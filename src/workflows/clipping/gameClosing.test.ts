import { createHash } from 'crypto';
import { contextClosingBoundary, validateClosingContext, validateClosingEnvelope, verifyClosingContext } from './gameClosing';

const clone = (v: any) => JSON.parse(JSON.stringify(v));
const source = { mediaPath: 'source.flv', mediaBytes: '100', mediaMtimeNs: '20' };
const audio = { start: 0, end: 8, path: 'evidence/audio-2.mp3' };
const transcript = [{ start: 4, end: 5, text: '含混的最后处理', source: 'audio_transcript' }];

async function fixture(context: any = {}, retainRecordingEnd = false) {
  const span = retainRecordingEnd ? { ...audio, end: 80 } : audio;
  const files = new Map<string, any>();
  const digest = (file: string) => createHash('sha256').update(JSON.stringify(files.get(file))).digest('hex');
  const writeJson = (file: string, value: any) => { files.set(file, clone(value)); };
  const io = { digest, writeJson, readJson: (file: string) => clone(files.get(file)), readTranscript: () => clone(transcript),
    cache: async (_: any, run: any) => run(),
    extract: async (args: string[], settings: any) => {
      const file = args.at(-1)!; writeJson(file, { time: args[2] });
      writeJson(file + '.complete.json', { version: 3, args, source: settings.sourceIdentity, sha256: digest(file),
        signature: createHash('sha256').update(JSON.stringify({ args, source: settings.sourceIdentity })).digest('hex') });
    },
    request: async (prompt: string, images: any[]) => ({ text: JSON.stringify(prompt.startsWith('Inspect EVERY')
      ? { reason: 'Target credits, black transition, then different activity', frames: images.map(s => ({ index: s.index,
        activity: s.time < 2 ? 'game' : s.time < 3.25 ? 'uncertain' : 'other', description: `Original at ${s.time}` })) }
      : { decision: 'keep', reason: 'All possible exit handling kept; later discussion is unrelated', ownTargetGame: true,
        allPossibleHandlingRetained: true, laterContextUnrelated: true, retainedContentAllowed: true,
        retainedTail: { transcriptIndex: 1, start: 4, end: 5, text: transcript[0].text },
        ...(retainRecordingEnd ? { retainedTail: null, laterContextUnrelated: null, recordingEndRetained: true } : {}), ...context }) }) };
  const review = await verifyClosingContext({ audio: span, source, directory: 'evidence', root: {}, settings: {},
    retainRecordingEnd, sourceDuration: span.end,
    gameName: 'target', host: 'host', localAudioEvidence: { version: 1, method: 'independent_local_asr',
      primary: { audioPath: span.path, start: 0, end: span.end }, retranscriptions: [] } }, io);
  return { review, io, files, audio: span };
}

test('silent exit retains black pixels and the complete ambiguous last ASR row', async () => {
  const { review, io } = await fixture();
  expect(review.end).toBe(5);
  expect(review.samples[review.frames.findLastIndex((f: any) => f.activity !== 'other') + 1].time).toBe(3.25);
  expect(validateClosingContext(review, source, audio, io)).toBe(5);
  const excerpt = { decision: 'keep', observed: true, timingSource: review.timingSource, boundaryAnchor: 'after_retained_context',
    heardWords: null, seconds: 5, reason: 'Independently reviewed full context' };
  const observation = { index: 2, heardWords: null, timingSource: review.timingSource };
  const value = { end: 5, evidenceMethod: 'independent_local_asr', endFrameReview: review, audioObservations: [null, observation],
    boundaryReview: { end: 5, endFrameReview: review, excerptReviews: [null, excerpt], audioObservations: [null, observation] } };
  expect(validateClosingEnvelope(value, source, audio, io)).toBe(5);
  expect(() => validateClosingEnvelope({ ...value, boundaryReview: { ...value.boundaryReview, spokenEnd: 5 } }, source, audio, io)).toThrow(/envelope/);
});

test('missing spoken exit alone cannot approve subsequent possible game handling', async () => {
  await expect(fixture({ laterContextUnrelated: false })).rejects.toThrow(/later game handling/);
  await expect(fixture({ decision: 'uncertain' })).rejects.toThrow(/later game handling/);
  await expect(fixture({ retainedTail: { transcriptIndex: 1, start: 4, end: 4.5, text: transcript[0].text } })).rejects.toThrow(/independent ASR/);
});

test('source, image observations, raw responses, ASR row and envelope cannot be edited to approve', async () => {
  const { review, io, files } = await fixture();
  for (const mutate of [
    (r: any) => { r.end = 3.25; },
    (r: any) => { r.frames[0].activity = 'other'; },
    (r: any) => { r.frames.at(-1).activity = 'uncertain'; },
    (r: any) => { r.samples.splice(1, 1); r.frames.splice(1, 1); },
    (r: any) => { r.batches.pop(); },
    (r: any) => { r.contextReview.retainedTail.text = 'invented exit phrase'; },
    (r: any) => { r.source.mediaBytes = '200'; },
    (r: any) => { r.localAudioEvidence.primary.end = 7; },
  ]) {
    const changed = clone(review); mutate(changed);
    expect(() => validateClosingContext(changed, source, audio, io)).toThrow();
  }
  const raw = files.get(review.batches[0].responsePath); raw.text = '{}';
  expect(() => validateClosingContext(review, source, audio, io)).toThrow(/assessment changed/);
});

test('independent context may retain through all unknown exit pixels but must see unrelated aftermath', async () => {
  const { review } = await fixture();
  const changed = clone(review); changed.contextReview.retainedTail = null;
  expect(contextClosingBoundary(changed, transcript)).toBe(3.25);
  changed.frames.at(-2).activity = 'uncertain';
  expect(() => contextClosingBoundary(changed, transcript)).toThrow(/bounded final transition/);
});

test('explicit complete recording tail retains ongoing handling without inventing an exit', async () => {
  const { review, io, audio: span } = await fixture({}, true);
  expect(review).toMatchObject({ version: 3, retentionMode: 'through_recording_end', end: 80,
    sampleSeconds: 30, resolutionSeconds: null, contextReview: { retainedTail: null, laterContextUnrelated: null } });
  expect(review.samples.map((s: any) => s.time)).toEqual([0, 30, 60, 79.9]);
  expect(validateClosingContext(review, source, span, io, 80)).toBe(80);
  expect(() => validateClosingContext(review, source, span, io)).toThrow(/source duration/);
  expect(() => validateClosingContext(review, source, span, io, 81)).toThrow(/source duration/);
  const changed = clone(review); changed.samples.at(-1).time = 79;
  expect(() => contextClosingBoundary(changed, transcript)).toThrow(/coverage/);
  const edited = clone(review); edited.contextReview.recordingEndRetained = false;
  expect(() => validateClosingContext(edited, source, span, io, 80)).toThrow(/independently verified/);
  await expect(fixture({ retainedContentAllowed: false }, true)).rejects.toThrow(/independently verified/);
  await expect(fixture({ decision: 'uncertain' }, true)).rejects.toThrow(/independently verified/);
  await expect(fixture({ laterContextUnrelated: true }, true)).rejects.toThrow(/incomplete/);
});
