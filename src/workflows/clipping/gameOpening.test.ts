import { createHash } from 'crypto';
import { openingBoundary, unresolvedSpokenOpening, validateVisualOpening, validateVisualOpeningEnvelope, verifyVisualOpening } from './gameOpening';

type Data = Record<string, any>;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const source = { mediaPath: 'original.flv', mediaBytes: '2000', mediaMtimeNs: '42' };
function harness(contextPatch: Data = {}, uncertainAt?: number) {
  const files = new Map<string, string>(), cache = new Map<string, Data>();
  const localAudioEvidence = { version: 1, method: 'independent_local_asr', retranscriptions: [],
    primary: { start: 100, end: 150, audioPath: 'audio.mp3', asrSha256: 'original-asr', provenanceSha256: 'original-provenance' } };
  const options = { source, directory: 'evidence', root: {}, settings: {}, gameName: 'Test Game', host: 'Host',
    audio: { start: 100, end: 150, path: 'audio.mp3' }, localAudioEvidence,
    frames: [{ index: 2, time: 118 }, { index: 1, time: 110 }],
    frameObservations: [{ index: 1, activity: 'other' }, { index: 2, activity: 'gameplay' }] };
  const io = {
    digest: (file: string) => { if (!files.has(file)) throw new Error('Missing evidence'); return sha(files.get(file)!); },
    readJson: (file: string) => JSON.parse(files.get(file)!),
    writeJson: (file: string, value: Data) => { files.set(file, JSON.stringify(value)); },
    readTranscript: (bundle: Data, actualSource: Data) => {
      if (JSON.stringify(bundle) !== JSON.stringify(localAudioEvidence.primary) || JSON.stringify(actualSource) !== JSON.stringify(source)) {
        throw new Error('Independent ASR provenance changed');
      }
      return [{ start: 101, end: 109, text: 'An unrelated conversation.' }, { start: 110, end: 115, text: 'Still unrelated.' },
        { start: 121, end: 125, text: 'Now playing the game.' }];
    },
    extract: jest.fn(async (args: string[]) => {
      const file = args.at(-1)!;
      files.set(file, 'original pixels at ' + args[2]);
      io.writeJson(file + '.complete.json', { version: 3, args, source,
        signature: sha(JSON.stringify({ args, source })), sha256: io.digest(file) });
    }),
    request: jest.fn(async (prompt: string, samples: Data[]) => {
      if (prompt.includes('COMPLETE preceding original-audio ASR')) {
        expect(prompt).toContain('An unrelated conversation');
        expect(prompt).toContain('Merely failing to find a spoken launch phrase is insufficient');
        return { text: JSON.stringify({ decision: 'keep', reason: 'Complete preceding context establishes unrelated talk then silent launch',
          windowStartsUnrelated: true, earlierContextClosed: true, allPossibleSetupRetained: true,
          ownGameTransition: true, retainedContentAllowed: true, retainedLeadIn: null, ...contextPatch }) };
      }
      expect(samples.length).toBeLessThanOrEqual(8);
      return { text: JSON.stringify({ reason: 'Actual source pixels', frames: samples.map(s => ({ index: s.index,
        activity: s.time === uncertainAt ? 'uncertain' : s.time >= 117.1 ? 'game' : 'other', description: 'Original pixels at ' + s.time })) }) };
    }),
    cache: async (settings: Data, run: () => Promise<Data>) => {
      const key = JSON.stringify({ phase: settings.phase, prompt: settings.prompt, signature: settings.signature });
      if (cache.has(key) && settings.validate(cache.get(key))) return cache.get(key)!;
      const result = await run(); cache.set(key, result); return result;
    }
  };
  return { options, io, files };
}

describe('independent silent visual game opening', () => {
  test('only a failed spoken match with independent evidence can enter visual review; corrupt provenance still fails', () => {
    const response = { text: 'original model reply', meta: { localAudioEvidence: { version: 1 } } };
    expect(JSON.parse(unresolvedSpokenOpening(response, 'Game boundary phrase is absent or ambiguous in its original excerpt')!.text))
      .toMatchObject({ decision: 'uncertain', observed: false });
    expect(response.text).toBe('original model reply');
    expect(unresolvedSpokenOpening(response, 'Independent original audio source changed')).toBeNull();
    expect(unresolvedSpokenOpening({ text: 'no independent evidence' }, 'Game boundary phrase is absent or ambiguous')).toBeNull();
  });
  test.each([false, true])('missing pre-game chapter frames trigger bounded original lead-in probes (%s)', async uncertain => {
    const { options, io } = harness({}, uncertain ? 100 : undefined);
    options.frames = [{ index: 8, time: 130 }];
    options.frameObservations = [{ index: 8, activity: 'gameplay' }];
    if (uncertain) await expect(verifyVisualOpening(options, io)).rejects.toThrow(/No bounded earliest/);
    else {
      const review = await verifyVisualOpening(options, io);
      expect(review.start).toBeLessThan(117.1);
      expect(review.start).toBeGreaterThanOrEqual(116.85);
      expect(validateVisualOpening(review, source, options.audio, io)).toBe(review.start);
      const probes = io.request.mock.calls.filter(([prompt]) => prompt.includes('search interval'));
      expect(probes.length).toBeGreaterThan(0);
      expect(probes[0][1].some((frame: Data) => frame.time === options.audio.start)).toBe(true);
      expect(probes[0][1].every((frame: Data) => frame.index > 8)).toBe(true);
    }
  });
  test.each([false, true])('a 73-second sparse gap is probed without approving ambiguous pixels (%s)', async uncertain => {
    const { options, io } = harness({}, uncertain ? 110 + 73 / 3 : undefined);
    options.audio.end = 200; options.localAudioEvidence.primary.end = 200;
    options.frames = [{ index: 1, time: 110 }, { index: 2, time: 183 }];
    options.frameObservations = [{ index: 1, activity: 'other' }, { index: 2, activity: 'gameplay' },
      { index: 200, activity: 'gameplay' }];
    if (uncertain) {
      await expect(verifyVisualOpening(options, io)).rejects.toThrow(/No bounded earliest/);
    } else {
      const review = await verifyVisualOpening(options, io);
      expect(review.start).toBe(117);
      expect(review.bracket.end - review.bracket.start).toBeLessThanOrEqual(30);
      expect(validateVisualOpening(review, source, options.audio, io)).toBe(117);
      expect(io.request.mock.calls.some(([prompt]) => prompt.includes('search interval'))).toBe(true);
      const probe = io.request.mock.calls.find(([prompt]) => prompt.includes('search interval'))!;
      expect(probe[1].every((sample: Data) => sample.index > 200)).toBe(true);
    }
  });
  test('retains the last certain non-game frame before the first game pixel without inventing speech', async () => {
    const { options, io } = harness(), review = await verifyVisualOpening(options, io);
    expect(review.start).toBe(117);
    expect(openingBoundary(review)).toBe(117);
    expect(review.samples.map((s: Data) => s.index)).not.toEqual(review.samples.map((_: Data, i: number) => i + 1));
    expect(validateVisualOpening(review, source, options.audio, io)).toBe(117);
    expect(review).not.toHaveProperty('heardWords');
    expect(io.request).toHaveBeenCalledTimes(3);
    await verifyVisualOpening(options, io);
    expect(io.request).toHaveBeenCalledTimes(3);
  });

  test.each(['windowStartsUnrelated', 'earlierContextClosed', 'allPossibleSetupRetained', 'ownGameTransition', 'retainedContentAllowed'])('uncertain %s cannot be replaced by a visual start', async key => {
    const { options, io } = harness({ [key]: false });
    await expect(verifyVisualOpening(options, io)).rejects.toThrow(/earlier or ambiguous setup/);
  });

  test('possible earlier preparation is retained from the entire independent row instead of blocking a complete cut', async () => {
    const lead = { transcriptIndex: 2, start: 110, end: 115, text: 'Still unrelated.' };
    const { options, io } = harness({ retainedLeadIn: lead }), review = await verifyVisualOpening(options, io);
    expect(review).toMatchObject({ version: 2, start: 110, timingSource: 'original_visual_context' });
    expect(openingBoundary(review)).toBe(117);
    expect(validateVisualOpening(review, source, options.audio, io)).toBe(110);
    for (const mutate of [(r: Data) => { r.contextReview.retainedLeadIn.start = 112; },
      (r: Data) => { r.contextReview.retainedLeadIn.text = 'Invented setup'; },
      (r: Data) => { r.contextReview.retainedLeadIn.transcriptIndex = 3; },
      (r: Data) => { r.start = 117; }]) {
      const changed = structuredClone(review); mutate(changed);
      expect(() => validateVisualOpening(changed, source, options.audio, io)).toThrow();
    }
  });

  test('unreadable earlier pixels and later scene brackets are rejected', async () => {
    const unknown = harness({}, 112);
    await expect(verifyVisualOpening(unknown.options, unknown.io)).rejects.toThrow(/pixels remain uncertain/);
    const { options, io } = harness(), review = await verifyVisualOpening(options, io);
    review.frames[1].activity = 'game';
    expect(() => openingBoundary(review)).toThrow(/first unambiguous/);
    review.frames[1].activity = 'other'; review.bracket.start = 117.25;
    expect(() => openingBoundary(review)).toThrow(/first unambiguous/);
  });

  test('changed source pixels, receipt source, or original response cannot pass revalidation', async () => {
    for (const change of ['pixels', 'receipt', 'response', 'context'] as const) {
      const { options, io, files } = harness(), review = await verifyVisualOpening(options, io);
      if (change === 'pixels') files.set(review.samples[0].path, 'different pixels');
      if (change === 'receipt') {
        const sample = review.samples[0], receipt = io.readJson(sample.receiptPath);
        receipt.args[2] = '99'; io.writeJson(sample.receiptPath, receipt); sample.receiptSha256 = io.digest(sample.receiptPath);
      }
      if (change === 'response') {
        const batch = review.batches[0], response = io.readJson(batch.responsePath), row = JSON.parse(response.text);
        row.frames[0].description = 'Changed assessment'; response.text = JSON.stringify(row);
        io.writeJson(batch.responsePath, response); batch.responseSha256 = io.digest(batch.responsePath);
      }
      if (change === 'context') {
        const context = review.contextReview, response = io.readJson(context.responsePath);
        response.requestBinding.window.start = 99; io.writeJson(context.responsePath, response); context.responseSha256 = io.digest(context.responsePath);
      }
      expect(() => validateVisualOpening(review, source, options.audio, io)).toThrow(/changed|not bound|differs/);
    }
  });

  test('a forged positive context, duplicated frame IDs, missing coverage and partial ASR are rejected', async () => {
    const { options, io } = harness(), review = await verifyVisualOpening(options, io);
    for (const mutate of [
      (r: Data) => { r.contextReview.reason = 'Just approve it'; },
      (r: Data) => { r.batches[0].indices.unshift(r.batches[0].indices[0]); },
      (r: Data) => { r.batches.pop(); },
      (r: Data) => { r.samples[0].index = 80; },
      (r: Data) => { r.localAudioEvidence.primary.start = 105; },
      (r: Data) => { r.start = 118; }
    ]) {
      const changed = structuredClone(review); mutate(changed);
      expect(() => validateVisualOpening(changed, source, options.audio, io)).toThrow();
    }
  });
  test('cached visual verdicts cannot move the accepted cut or impersonate a spoken or native-audio boundary', async () => {
    const { options, io } = harness(), review = await verifyVisualOpening(options, io);
    const audioObservations = [{ index: 1, heardWords: null, timingSource: 'original_visual_transition' }];
    const value = { evidenceMethod: 'independent_local_asr', start: 117, startFrameReview: review, audioObservations,
      boundaryReview: { start: 117, startFrameReview: review, audioObservations, excerptReviews: [{ decision: 'keep', observed: true,
        timingSource: 'original_visual_transition', boundaryAnchor: 'before_visual_transition', heardWords: null, seconds: 17,
        reason: 'Original pixels and full preceding context independently establish the silent launch' }] } };
    expect(validateVisualOpeningEnvelope(value, source, options.audio, io)).toBe(117);
    for (const mutate of [
      (v: Data) => { v.start = 118; },
      (v: Data) => { v.boundaryReview.start = 118; },
      (v: Data) => { v.boundaryReview.excerptReviews[0].seconds = 18; },
      (v: Data) => { v.boundaryReview.excerptReviews[0].quoteSource = null; },
      (v: Data) => { v.boundaryReview.excerptReviews[0].heardWords = 'invented words'; },
      (v: Data) => { v.evidenceMethod = 'native_audio'; }
    ]) {
      const changed = structuredClone(value); mutate(changed);
      expect(() => validateVisualOpeningEnvelope(changed, source, options.audio, io)).toThrow(/boundary or excerpt/);
    }
  });
});
