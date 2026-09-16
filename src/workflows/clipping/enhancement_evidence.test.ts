import { compactEnhancementEvidence } from './enhancement_evidence';
import { continuousPlan } from './editPlan';
test('interning preserves exact provenance, uncertainty and dialogue with complete retained references', () => {
    const observation = { start: 0, end: 10, label: 'UNKNOWN', scope: 'row_rejected', row: { score: .4, accepted: false } };
    const asrEvidence = { status: 'available', sourceSpan: { start: 0, end: 10, rawText: '不是，是三位', words: null }, aliasChanged: false };
    const speakerEvidence = { status: 'mixed', identityVerified: false, observations: [observation] };
    const speech = [{ start: 0, end: 4, text: '不是', asrEvidence, speakerEvidence }, { start: 4, end: 10, text: '是三位', asrEvidence, speakerEvidence }];
    const data = JSON.parse(compactEnhancementEvidence({ window: { start: 0, end: 10 }, speech, audience: [] }, continuousPlan('v', { start: 0, end: 10 })));
    const expand = (value: any): any => Array.isArray(value) ? value.map(expand) : value && typeof value === 'object'
        ? value.ref ? expand(data.provenance[value.ref]) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)])) : value;
    expect(data.retainedSpeech.map((row: any) => row.id)).toEqual(['S1', 'S2']);
    expect(expand(data.sourceSpeech)).toEqual(speech.map((row, index) => ({ ...row, id: `S${index + 1}` })));
    expect(data.sourceSpeech[0].speakerEvidence).toEqual(data.sourceSpeech[1].speakerEvidence);
});
