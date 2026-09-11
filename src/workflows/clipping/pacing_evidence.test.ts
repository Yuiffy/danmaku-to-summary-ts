import { detectQuietPcm, protectedPauseWindows, usefulPauseEvidence } from './pacing_evidence';
import { planFromEvidenceIds } from './editPlan';
const speech = [{ start: 0, end: 5, text: 'setup' }, { start: 15, end: 20, text: 'No, corrected ending' }]
    .map(row => ({ ...row, asrEvidence: { sourceSpan: { start: row.start, end: row.end } } }));
test('scans only real gaps outside both original ASR spans and displayed text', () => {
    expect(protectedPauseWindows(speech, { start: 0, end: 20 })).toEqual([{ start: 5.2, end: 14.8 }]);
    expect(protectedPauseWindows(speech.map(row => ({ ...row, asrEvidence: { sourceSpan: { start: 0, end: 20 } } })), { start: 0, end: 20 })).toEqual([]);
    expect(protectedPauseWindows([{ start: 0, end: 1, text: 'legacy' }], { start: 0, end: 20 })).toEqual([]);
});
test('requires quiet in both channels and excludes short interruptions without deleting speech', () => {
    const pcm = Buffer.alloc(64000 * 10);
    const quiet = detectQuietPcm(pcm, 5.2, 'v');
    expect(quiet).toHaveLength(1);
    for (let frame = 0; frame < 160000; frame++) pcm.writeInt16LE(2000, frame * 4 + 2);
    expect(detectQuietPcm(pcm, 5.2, 'v')).toEqual([]);
    expect(detectQuietPcm(Buffer.alloc(64000 * 3), 5.2, 'v')).toEqual([]);
});
test('usefulness limits and independent VAD provenance are mandatory for non-speech cuts', () => {
    const event: any = { id: 'P1', sourceId: 'v', kind: 'non_speech', start: 6, end: 10, verified: true, precisionSeconds: .01 };
    expect(() => planFromEvidenceIds('v', { start: 0, end: 20 }, ['P1'], speech, [event])).toThrow('verification');
    event.verification = { method: 'protected_asr_gap_and_two_channel_fsmn', pcmSha256: 'a'.repeat(64), nonSpeech: true, speechIntervalsMs: [[], []] };
    expect(usefulPauseEvidence([event], 'v', { start: 0, end: 20 }, speech)).toHaveLength(1);
    expect(usefulPauseEvidence([event], 'v', { start: 0, end: 20 }, speech, { minRemovedRatio: .2 })).toEqual([]);
    event.verification.speechIntervalsMs = [[[0, 100]], []];
    expect(() => planFromEvidenceIds('v', { start: 0, end: 20 }, ['P1'], speech, [event])).toThrow('verification');
});
