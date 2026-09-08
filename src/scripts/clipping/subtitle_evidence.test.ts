const evidence = require('./subtitle_evidence');

describe('subtitle evidence', () => {
  test('restores punctuation without changing words, aliases or partial-text overrides', () => {
    const pack = evidence.buildSubtitleEvidence([{ start: 0, end: 4, text: 'Like me no',
      asrEvidence: { correctedText: 'Like me? No.' } }]);
    expect(evidence.formatEvidenceCues(pack.cues)).toContain('Like me? No.');
    expect(evidence.formatEvidenceCues([{ ...pack.cues[0], text: 'only part', partial: true }])).toContain('only part');
    const changed = evidence.buildSubtitleEvidence([{ start: 0, end: 4, text: 'SUI', asrEvidence: { correctedText: 'sleep?' } }]);
    expect(evidence.formatEvidenceCues(changed.cues)).not.toContain('sleep');
  });
  test('parses JSON without losing valid responses to a harmless prose wrapper', () => {
    expect(evidence.parseClipResponse('Result:\n{"clips":[{"event":"literal } in speech"}]}\nDone.'))
      .toEqual([{ event: 'literal } in speech' }]);
    expect(evidence.parseClipResponse('```json\n{"clips":[]}\n```')).toEqual([]);
    expect(() => evidence.parseClipResponse('{"clips":"not an array"}')).toThrow();
  });

  test('accepts equivalent top-level clip arrays without weakening record validation', () => {
    const clips = [{ candidateIndex: 1, startCueId: 'G1', endCueId: 'G2', title: 'A literal [title]' }];
    expect(evidence.parseClipResponse(JSON.stringify(clips))).toEqual(clips);
    expect(evidence.parseClipResponse('```json\n' + JSON.stringify(clips) + '\n```')).toEqual(clips);
    expect(evidence.parseClipResponse('[]')).toEqual([]);
    for (const invalid of ['[null]', '["text"]', '[[]]', '[true]', 'null', '{"title":"not a collection"}']) {
      expect(() => evidence.parseClipResponse(invalid)).toThrow();
    }
  });

  test('preserves every source item and exact timing while grouping continuous speech', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ start: i * 1.123, end: i * 1.123 + 1, text: `word-${i}` }));
    const packed = evidence.buildSubtitleEvidence(rows);
    expect(packed.cues.length).toBeLessThan(rows.length);
    const restored = packed.cues.flatMap(c => c.items).map(({ start, end, text }) => ({ start, end, text }));
    expect(restored).toEqual(rows);
    expect(evidence.formatEvidenceCues(packed.cues)).toContain('word-29');
    expect(evidence.buildSubtitleEvidence(rows).sourceSha256).toBe(packed.sourceSha256);
    expect(evidence.buildSubtitleEvidence([...rows, { start: 40, end: 41, text: 'changed' }]).sourceSha256).not.toBe(packed.sourceSha256);
  });

  test('does not merge speakers or speech across a silence gap', () => {
    const packed = evidence.buildSubtitleEvidence([
      { start: 0, end: 2, text: 'first', speaker: 'host' },
      { start: 2, end: 3, text: 'guest', speaker: 'guest' },
      { start: 6, end: 7, text: 'later', speaker: 'guest' }
    ]);
    expect(packed.cues).toHaveLength(3);
    expect(evidence.resolveEvidenceBoundaries({ startCueId: 'G1', endCueId: 'G2' }, packed))
      .toMatchObject({ start: 0, end: 3, boundaryFromEvidence: true });
    expect(() => evidence.resolveEvidenceBoundaries({ startCueId: 'invented', endCueId: 'G2' }, packed)).toThrow();
  });

  test('flags evidence outside the final clip and never guesses missing references', () => {
    const packed = evidence.buildSubtitleEvidence([{ start: 5, end: 9, text: 'specific claim' }]);
    const linked = evidence.linkClipEvidence({ evidenceCueIds: ['G1'], sourceKind: 'recount' }, { start: 5, end: 9 }, packed);
    expect(linked.status).toBe('linked');
    expect(linked.subtitles[0].sourceIndices).toEqual([0]);
    const bad = evidence.linkClipEvidence({ evidenceCueIds: ['G1', 'G99'], evidenceDanmakuIds: ['D1'] },
      { start: 5, end: 8 }, packed, [{ time: 12, text: 'a viewer, not the host' }]);
    expect(bad.status).toBe('needs_review');
    expect(bad.issues).toEqual(expect.arrayContaining(['subtitle_outside_clip:G1', 'unknown_subtitle:G99', 'danmaku_outside_clip:D1']));
  });

  test('does not certify an unsupported quote or a number that is only a substring of the evidence', () => {
    const packed = evidence.buildSubtitleEvidence([{ start: 1, end: 5, text: 'The value is 1000.' }]);
    const linked = evidence.linkClipEvidence({ title: 'The value is 100', description: 'He said "never recorded"',
      evidenceCueIds: ['G1'], sourceKind: 'live_speech' }, { start: 1, end: 5 }, packed);
    expect(linked.issues).toContain('unsupported_number:title:100');
    expect(linked.issues).toContain('unsupported_quote:description:never recorded');
    expect(linked.status).toBe('needs_review');
  });

  test('unprovided evidence remains flagged after final boundary revalidation', () => {
    const packed = evidence.buildSubtitleEvidence([{ start: 1, end: 5, text: 'source' }]);
    const danmaku = [{ time: 3, text: 'a comment not included in the model input' }];
    const clip = { start: 1, end: 5, title: 'A comment' };
    const grounding = evidence.linkClipEvidence({ evidenceCueIds: ['G1'], evidenceDanmakuIds: ['D1'], sourceKind: 'live_speech' },
      clip, packed, danmaku, { cueIds: new Set(['G1']), danmakuIds: new Set() });
    expect(grounding.issues).toContain('unseen_danmaku:D1');
    const checked = evidence.revalidateClipEvidence({ ...clip, grounding }, packed, danmaku);
    expect(checked.grounding.status).toBe('needs_review');
    expect(checked.grounding.issues).toContain('unseen_danmaku:D1');
    expect(evidence.revalidateClipEvidence({ ...clip, grounding: { subtitleIds: 'invalid' } }, packed, danmaku).grounding.status)
      .toBe('needs_review');
  });

  test('viewer reaction copy requires a viewer reference, including when recall is reused', () => {
    const source = evidence.buildSubtitleEvidence([{ start: 0, end: 10, text: 'a spoken quote' }]);
    const raw = { title: '弹幕要把这句话写进作文', evidenceCueIds: ['G1'], sourceKind: 'live_speech' };
    const window = { start: 0, end: 10 };
    const missing = evidence.linkClipEvidence(raw, window, source);
    expect(missing.issues).toContain('audience_attribution_needs_review');
    const complete = evidence.linkClipEvidence({ ...raw, evidenceDanmakuIds: ['D1'] }, window, source,
      [{ time: 5, text: '我要写进作文' }]);
    expect(complete.status).toBe('linked');
    expect(evidence.revalidateClipEvidence({ ...window, title: raw.title,
      grounding: { ...complete, reusedRecall: true } }, source, [{ time: 5, text: '我要写进作文' }]).grounding.reusedRecall).toBe(true);
  });

  test.each([
    { comments: [{ time: 5, text: 'Original reaction.' }] },
    { comments: [{ time: 6, text: 'Original reaction.' }] },
    { comments: [{ time: 4, text: 'Inserted earlier comment.' }, { time: 5, text: 'Original reaction.' }] },
    { comments: [] }
  ])('rechecks a cited audience snapshot rather than silently rebinding its ID: %j', ({ comments }) => {
    const source = evidence.buildSubtitleEvidence([{ start: 0, end: 10, text: 'A source fact.' }]);
    const clip = { start: 0, end: 10, title: 'A reaction', description: 'Original reaction.' };
    const original = [{ time: 5, text: 'Original reaction.' }];
    const grounding = evidence.linkClipEvidence({ ...clip, evidenceCueIds: ['G1'], evidenceDanmakuIds: ['D1'], sourceKind: 'recount' },
      clip, source, original);
    const before = JSON.stringify(grounding);
    const checked = evidence.revalidateClipEvidence({ ...clip, grounding }, source, comments);
    expect(JSON.stringify(grounding)).toBe(before);
    expect(checked.title).toBe(clip.title);
    expect(checked.description).toBe(clip.description);
    expect(checked.grounding.danmakuIds).toEqual(['D1']);
    if (comments[0]?.time === 5) {
      expect(checked.grounding).toEqual(grounding);
    } else {
      expect(checked.grounding.status).toBe('needs_review');
      expect(checked.grounding.issues).toContain('danmaku_source_changed:D1');
      expect(checked.grounding.audienceChanges).toEqual([{
        id: 'D1', reason: 'changed', original: { id: 'D1', time: 5, text: 'Original reaction.' },
        current: comments[0] ? { id: 'D1', ...comments[0] } : null
      }]);
      const again = evidence.revalidateClipEvidence(JSON.parse(JSON.stringify(checked)), source, comments);
      expect(again.grounding).toEqual(checked.grounding);
    }
  });

  test('a changed comment keeps its first snapshot through later changes until the citation is replaced', () => {
    const source = evidence.buildSubtitleEvidence([{ start: 0, end: 10, text: 'A source fact.' }]);
    const clip = { start: 0, end: 10, title: 'A reaction' };
    const grounding = evidence.linkClipEvidence({ evidenceCueIds: ['G1'], evidenceDanmakuIds: ['D1'], sourceKind: 'recount' },
      clip, source, [{ time: 5, text: 'Original reaction.' }]);
    const changed = evidence.revalidateClipEvidence({ ...clip, grounding }, source, [{ time: 5, text: 'Changed reaction.' }]);
    const changedAgain = evidence.revalidateClipEvidence(changed, source, [{ time: 5, text: 'Changed again.' }]);
    expect(changedAgain.grounding.audienceChanges[0]).toMatchObject({
      original: { text: 'Original reaction.' }, current: { text: 'Changed again.' }
    });
    expect(changedAgain.grounding.issues.filter(issue => issue === 'danmaku_source_changed:D1')).toHaveLength(1);
    const removed = evidence.revalidateClipEvidence({ ...changedAgain,
      grounding: { ...changedAgain.grounding, danmakuIds: [] } }, source, []);
    expect(removed.grounding.issues).not.toContain('danmaku_source_changed:D1');
    expect(removed.grounding.audienceChanges).toBeUndefined();
  });

  test('missing old audience snapshots remain unverifiable, not newly certified by matching IDs', () => {
    const source = evidence.buildSubtitleEvidence([{ start: 0, end: 10, text: 'A source fact.' }]);
    const clip = { start: 0, end: 10, title: 'A reaction', grounding: {
      sourceSha256: source.sourceSha256, subtitleIds: ['G1'], danmakuIds: ['D1'], sourceKind: 'recount'
    } };
    const comments = [{ time: 5, text: 'A newly resolved comment.' }];
    const checked = evidence.revalidateClipEvidence(clip, source, comments);
    expect(checked.grounding.issues).toContain('danmaku_snapshot_missing:D1');
    expect(checked.grounding.audienceChanges[0]).toMatchObject({ id: 'D1', reason: 'missing_snapshot', original: null });
    expect(evidence.revalidateClipEvidence(JSON.parse(JSON.stringify(checked)), source, comments).grounding).toEqual(checked.grounding);
  });

  test('does not invalidate unchanged cited rows when unrelated audience rows are appended', () => {
    const source = evidence.buildSubtitleEvidence([{ start: 0, end: 10, text: 'A source fact.' }]);
    const clip = { start: 0, end: 10, title: 'A reaction' };
    const comments = [{ time: 5, text: 'A reaction.' }];
    const grounding = evidence.linkClipEvidence({ evidenceCueIds: ['G1'], evidenceDanmakuIds: ['D1'], sourceKind: 'recount' }, clip, source, comments);
    const checked = evidence.revalidateClipEvidence({ ...clip, grounding }, source, [...comments, { time: 20, text: 'Later unrelated comment.' }]);
    expect(checked.grounding).toEqual(grounding);
  });
});
