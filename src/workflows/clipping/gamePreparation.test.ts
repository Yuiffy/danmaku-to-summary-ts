import { createHash } from 'crypto';
import { preparationBoundary, validatePreparation, verifyPreparation } from './gamePreparation';

const clone = (v: any) => JSON.parse(JSON.stringify(v));
const rows = [{ start: .5, end: 1, text: 'unrelated' }, { start: 2, end: 3, text: 'compiling shaders' },
  { start: 4, end: 5, text: 'brightness finished' }, { start: 6, end: 8, text: 'unrelated food' }];
const source = { mediaPath: 'source.flv', mediaBytes: '100', mediaMtimeNs: '2' };
const flags = { actualLocalSetup: true, targetGameEstablished: true, earlierContextUnrelated: true,
  laterContextUnrelated: true, allPreparationRetained: true, retainedContentAllowed: true, publicCopySupported: true };

async function fixture(extra: any = {}, extraTimes: number[] = []) {
  const files = new Map<string, any>();
  const writeJson = (p: string, v: any) => { files.set(p, clone(v)); };
  const digest = (p: string) => createHash('sha256').update(JSON.stringify(files.get(p))).digest('hex');
  function image(time: number) {
    const p = `frame-${time}.jpg`, args = ['-y', '-ss', String(time), '-i', source.mediaPath, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', p];
    writeJson(p, { time });
    writeJson(p + '.complete.json', { version: 3, args, source, sha256: digest(p),
      signature: createHash('sha256').update(JSON.stringify({ args, source })).digest('hex') });
    return { index: 1, time, path: p, sha256: digest(p) };
  }
  const primary = { start: 0, end: 10 }, early = image(4), visible = image(22);
  const witnessEvent = { id: 'actual-play', gameId: 'game', start: 20, end: 30,
    verification: { decision: 'keep', version: 4, protocolVersion: 14, evidenceMethod: 'independent_local_asr',
      start: 20, end: 30, publicCopySupported: true, frameTimes: [22], frameObservations: [{ index: 1, activity: 'gameplay' }],
      originalFrameEvidence: [visible] } };
  const event = { id: 'preparation', gameId: 'game', start: 0, end: 8, chapters: [{ start: 2, title: 'Preparation' }],
    verification: { decision: 'uncertain', nonGameReview: { method: 'independent_local_asr', decision: 'uncertain', primary },
      chapterReviews: [{ index: 1, supported: true }], originalFrameEvidence: [early] } };
  const io = { writeJson, digest, readJson: (p: string) => clone(files.get(p)), readTranscript: () => clone(rows),
    cache: async (_: any, run: any) => run(), request: async () => ({ text: JSON.stringify({ decision: 'keep', reason: 'Actual same-game setup, then food break',
      ...flags, firstRetainedRow: { transcriptIndex: 2, ...rows[1] }, lastRetainedRow: { transcriptIndex: 3, ...rows[2] }, ...extra }) }) };
  const verdict = await verifyPreparation({ event, witnessEvent, source, directory: 'evidence', root: {}, settings: {},
    gameName: 'Game', host: 'Host', additionalFrames: extraTimes.map(image) }, io);
  return { verdict, io, files };
}

test('preparation-only cut keeps complete actual setup without claiming visible gameplay', async () => {
  const { verdict, io } = await fixture();
  expect(verdict).toMatchObject({ verificationKind: 'preparation_only', decision: 'keep', start: 2, end: 5 });
  expect(verdict).not.toHaveProperty('frameObservations');
  expect(validatePreparation(verdict.preparationReview, source, io)).toEqual({ start: 2, end: 5 });
});

test('targeted early original images stay in the full context and their extraction remains bound', async () => {
  const { verdict, io } = await fixture({}, [3, 6]);
  expect(verdict.preparationReview.frames.map((f: any) => f.time)).toEqual([4, 3, 6, 22]);
  expect(validatePreparation(verdict.preparationReview, source, io)).toEqual({ start: 2, end: 5 });
  const edited = clone(verdict.preparationReview); edited.frames[1].time = 3.5;
  expect(() => validatePreparation(edited, source, io)).toThrow(/original recording/);
  await expect(fixture({}, [11])).rejects.toThrow(/inside the complete original context/);
  await expect(fixture({}, [1, 2, 3])).rejects.toThrow(/inside the complete original context/);
});

test.each(Object.keys(flags))('preparation cannot pass without independent %s', async flag => {
  await expect(fixture({ [flag]: false })).rejects.toThrow(/remains uncertain/);
});

test('game discussion cannot witness preparation; source, raw assessment and retained rows stay bound', async () => {
  const { verdict, io, files } = await fixture(), original = verdict.preparationReview;
  for (const mutate of [
    (r: any) => { r.witnessEvent.gameId = 'different'; },
    (r: any) => { r.witnessEvent.verification.verificationKind = 'preparation_only'; },
    (r: any) => { r.witnessEvent.verification.frameObservations[0].activity = 'other'; },
    (r: any) => { r.witnessEvent.verification.decision = 'uncertain'; },
    (r: any) => { r.contextReview.firstRetainedRow.start = 2.5; },
    (r: any) => { r.primary.end = 9; },
    (r: any) => { r.frames[0].time = 5; },
    (r: any) => { r.boundary.end = 4; },
  ]) {
    const changed = clone(original); mutate(changed);
    expect(() => validatePreparation(changed, source, io)).toThrow();
  }
  const response = files.get(original.contextReview.responsePath);
  response.text = '{}';
  expect(() => validatePreparation(original, source, io)).toThrow(/assessment changed/);
  const changed = clone(original); changed.witnessEvent.start = 9; changed.witnessEvent.verification.start = 9;
  expect(() => preparationBoundary(changed, rows)).toThrow(/witness/);
});
