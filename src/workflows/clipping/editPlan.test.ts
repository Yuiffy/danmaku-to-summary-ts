import { AudioEvidence, buildEditFilter, continuousPlan, mapSubtitles, planFromEvidenceIds, validateEditPlan } from './editPlan';

const window = { start: 100, end: 160 };
const proof: AudioEvidence[] = [{ id: 'A1', kind: 'silence', start: 120, end: 130, precisionSeconds: 0.01, verified: true, sourceId: 'video' }];
const speech = [{ start: 101, end: 110, text: 'Setup' }, { start: 135, end: 159, text: 'No, that was wrong. Correction and conclusion.' }]
    .map(row => ({ ...row, asrEvidence: { sourceSpan: { start: row.start, end: row.end } } }));

test('ordered absolute half-open edits remap subtitles and both audio/video from the actual rough origin', () => {
    const plan = planFromEvidenceIds('video', window, ['A1'], speech, proof);
    const mapped = mapSubtitles(speech, plan);
    expect(mapped[0]).toMatchObject({ start: 1, end: 10 });
    expect(mapped[1].start).toBeCloseTo(25.6);
    const filter = buildEditFilter(plan, 92, 'clip.ass');
    expect(filter).toContain('trim=start=8:end=28.299999999999997');
    expect(filter).toContain('atrim=start=8:end=28.299999999999997');
    expect(filter).toContain('concat=n=2:v=1:a=1');
    expect(mapped[1].text).toBe(speech[1].text);
});

test('segment-interpolated subtitles cannot authorize removal inside the original sentence', () => {
    const interpolated = [{ start: 101, end: 102, text: 'No', asrEvidence: { sourceSpan: { start: 100, end: 140 } } }];
    expect(() => planFromEvidenceIds('video', window, ['A1'], interpolated, proof)).toThrow('dialogue');
});

test('legacy SRT without original timing is retained', () => {
    expect(() => planFromEvidenceIds('video', window, ['A1'], [{ start: 100, end: 110, text: 'Legacy' }], proof)).toThrow('provenance');
});

test.each(['coarse', 'unverified', 'wrong-source', 'laughter', 'unknown-id', 'short'])('protects %s evidence', kind => {
    const item: any = { ...proof[0], ...(kind === 'coarse' ? { precisionSeconds: 1 } : {}),
        ...(kind === 'unverified' ? { verified: false } : {}), ...(kind === 'wrong-source' ? { sourceId: 'other' } : {}),
        ...(kind === 'laughter' ? { kind: 'laughter' } : {}), ...(kind === 'short' ? { end: 121 } : {}) };
    expect(() => planFromEvidenceIds('video', window, [kind === 'unknown-id' ? 'A2' : 'A1'], speech, [item])).toThrow();
});

test('old continuous plans remain unchanged; reversed, overlapping and unaccounted intervals fail', () => {
    const plan = continuousPlan('video', window);
    expect(validateEditPlan(plan, 'video', window, speech, [])).toEqual(plan);
    expect(mapSubtitles(speech, plan)[1]).toMatchObject({ start: 35, end: 59 });
    for (const keep of [[{ start: 130, end: 160 }, { start: 100, end: 130 }],
        [{ start: 100, end: 140 }, { start: 130, end: 160 }], [{ start: 100, end: 150 }]]) {
        expect(() => validateEditPlan({ ...plan, keep }, 'video', window, speech, [])).toThrow();
    }
});
