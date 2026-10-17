import { runArchiveStages, assertOrderedActivityParts, activityBoundaryFeedback, retryBoundaryEvents, selectActivitySubmission } from './activityStages';

test('explicit pending selection retains complete Ps and evidence while invalidating approval', () => {
  const row = { activities: [{ id: 'short' }, { id: 'full' }], uploadReady: false,
    output: { parts: [{ activityId: 'short', start: 1, end: 5, duration: 4 },
      { activityId: 'full', start: 100, end: 400, duration: 300, mediaPath: 'full.mp4', sha256: 'bound' }] } };
  const selected = selectActivitySubmission(row, ['full'], '只保留用户指定的完整演唱');
  expect(selected.output.parts).toEqual([row.output.parts[1]]);
  expect(selected.window).toEqual({ start: 100, end: 400, duration: 300 });
  expect(selected.activitySelection.previousActivities).toEqual(row.activities);
  expect(selected.uploadReady).toBe(false);
  expect(row.output.parts).toHaveLength(2);
  for (const ids of [[], ['missing'], ['full', 'full']]) expect(() => selectActivitySubmission(row, ids, '指定')).toThrow();
  expect(() => selectActivitySubmission({ ...row, uploadReady: true }, ['full'], '指定')).toThrow();
});

test('final boundary feedback reopens only explicitly identified failed Ps with new evidence and preserves siblings', () => {
  const checks = { boundaries: false, titles: true };
  const row: any = { activityAutomaticPublicationRequired: true, uploadReady: false,
    activityReview: { authority: 'automatic', status: 'pending', checks, proofPath: 'proof.json' },
    activities: [{ id: 'watch', kind: 'watch', start: 10, end: 100, verification: { decision: 'keep' } },
      { id: 'sibling', kind: 'watch', start: 200, end: 300, verification: { decision: 'keep' } }],
    output: { parts: [{ activityId: 'watch' }, { activityId: 'sibling' }] } };
  const proof = { status: 'needs_review', evidenceVersion: 3, checks,
    responses: [{ checks, reviewScope: { partNumbers: [1] }, issues: ['末尾混入下一视频'] }] };
  const registry = { id: 1, status: 'needs_review' };
  const feedback = activityBoundaryFeedback(row, proof, registry, ['watch']);
  const raw = [{ id: 'watch', kind: 'watch', start: 20, end: 80 }, { id: 'sibling', kind: 'watch', start: 210, end: 290 }];
  expect(retryBoundaryEvents(raw, row.activities, ['watch'], [], feedback)).toEqual([{ ...raw[0], boundaryFeedback: feedback[0] }]);
  expect(raw[0].end).toBe(80);
  const unavailable = [{ ...raw[0], boundaryFeedback: feedback[0], verification: { decision: 'uncertain' } }, row.activities[1]];
  expect(retryBoundaryEvents(raw, unavailable, ['watch'])).toEqual([{ ...raw[0], boundaryFeedback: feedback[0] }]);
  const operatorSong = { ...row, activityAutomaticPublicationRequired: false,
    activityOperatorReview: { version: 1, note: '去除开头混入的播放，保留完整重唱', requestedAt: '2026-10-13T00:00:00Z' },
    activities: row.activities.map((e: any) => ({ ...e, kind: 'song' })) };
  expect(activityBoundaryFeedback(operatorSong, proof, registry, ['watch'])).toEqual(feedback);
  expect(() => activityBoundaryFeedback({ ...operatorSong, activityOperatorReview: undefined }, proof, registry, ['watch'])).toThrow();
  expect(() => activityBoundaryFeedback(row, proof, registry, ['sibling'])).toThrow('failed final');
  expect(() => activityBoundaryFeedback(row, proof, registry, ['watch', 'watch'])).toThrow();
  for (const registered of [{ status: 'queued' }, { ...registry, bvid: 'BV1' },
    { ...registry, automaticPublicationAuthorization: {} }, { ...registry, uploadState: { aid: 1 } }]) {
    expect(() => activityBoundaryFeedback(row, proof, registered, ['watch'])).toThrow();
  }
  expect(() => activityBoundaryFeedback(row, { ...proof, checks: { boundaries: true } }, registry, ['watch'])).toThrow();
  expect(() => activityBoundaryFeedback({ ...row, activityReview: { ...row.activityReview, checks: { boundaries: true } } }, proof, registry, ['watch'])).toThrow();
});

test.each([true, false])('a recovered shared summary resumes failed songs once, cache only (retry succeeds: %s)', async succeeds => {
  const run = jest.fn(async (kind, reuseSummaryOnly) => {
    if (kind === 'songs' && (!reuseSummaryOnly || !succeeds)) {
      throw Object.assign(new Error('summary not ready'), { code: 'ACTIVITY_SUMMARY_NOT_READY' });
    }
    return { status: 'rendered' };
  });
  const failed = jest.fn();
  await runArchiveStages(run, jest.fn(), failed);
  expect(run.mock.calls).toEqual([['songs'], ['games'], ['watch'], ['songs', true]]);
  expect(failed).toHaveBeenCalledTimes(succeeds ? 1 : 2);
});

test.each(['boundary error', 'summary still failed', 'disabled'])('does not retry without a recovered prerequisite: %s', async scenario => {
  const run = jest.fn(async kind => {
    if (kind === 'songs') throw Object.assign(new Error(scenario), {
      code: scenario === 'boundary error' ? 'OTHER' : 'ACTIVITY_SUMMARY_NOT_READY' });
    if (kind === 'watch' && scenario === 'summary still failed') throw new Error('still failed');
    return { status: scenario === 'disabled' ? 'disabled' : 'rendered' };
  });
  await runArchiveStages(run, jest.fn(), jest.fn());
  expect(run).toHaveBeenCalledTimes(3);
});

test('rejects overlapping activity Ps before rendering without changing their source intervals', () => {
  const parts = [{ start: 12932, end: 14323 }, { start: 14313, end: 14752 }];
  expect(() => assertOrderedActivityParts(parts)).toThrow('P2');
  expect(parts[1].start).toBe(14313);
  expect(() => assertOrderedActivityParts([{ start: 1, end: 2 }, { start: 2, end: 3 }])).not.toThrow();
});
