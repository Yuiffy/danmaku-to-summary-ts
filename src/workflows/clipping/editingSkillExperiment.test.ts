import { editingSkillPrompt, measureEditingTimeline, validateEditingSamples, EditingSample } from './editingSkillExperiment';

const sample: EditingSample = {
    id: 'story', sessionId: 'room/date', split: 'screening', duration: 10,
    cues: [
        { id: 'C1', start: 0, end: 1, text: '先关闭' },
        { id: 'C2', start: 1, end: 2, text: '电源，再拔线。' },
        { id: 'C3', start: 3, end: 4, text: '无关重复' },
        { id: 'C4', start: 5, end: 6, text: '然后检查是否接好。' }
    ],
    reference: { requiredBeats: [{ label: '前提完整句', cueIds: ['C1', 'C2'] }, { label: '结果', cueIds: ['C4'] }], redundantCueIds: ['C3'] }
};

test('control prompt remains byte-identical and unknown variants fail closed', () => {
    expect(editingSkillPrompt('原有提示\n{"cues":[]}', 'baseline')).toBe('原有提示\n{"cues":[]}');
    expect(() => editingSkillPrompt('prompt', 'other' as any)).toThrow('Unknown');
});

test('metrics distinguish necessary beats from redundant speech without approving media', () => {
    const full = measureEditingTimeline(sample, [{ start: 0, end: 10 }]);
    const edited = measureEditingTimeline(sample, [{ start: 0, end: 2 }, { start: 5, end: 6.2 }]);
    expect(full.redundantRetained).toEqual(['C3']);
    expect(edited).toMatchObject({ completeBeatCount: 2, missingBeats: [], redundantRetained: [], duration: 3.2, cuts: 1,
        publicationApproved: false, mediaReviewed: false });
    expect(measureEditingTimeline(sample, [{ start: 1, end: 2 }, { start: 5, end: 6 }]).missingBeats).toEqual(['前提完整句']);
});

test('evaluation rejects partial cues, overlapping cuts, fabricated references and ambiguous split identities', () => {
    expect(() => measureEditingTimeline(sample, [{ start: .5, end: 6 }])).toThrow('truncates');
    expect(() => measureEditingTimeline(sample, [{ start: 0, end: 2 }, { start: 1, end: 6 }])).toThrow('timeline');
    expect(() => validateEditingSamples([sample, { ...sample, id: 'second', split: 'holdout' }])).toThrow('leakage');
    expect(() => validateEditingSamples([{ ...sample, reference: { requiredBeats: [], redundantCueIds: ['C999'] } }])).toThrow('Unknown');
    expect(() => validateEditingSamples([{ ...sample, reference: { ...sample.reference, redundantCueIds: ['C1'] } }])).toThrow('Contradictory');
});

test('equivalent complete wording establishes a beat without rewarding half a sentence', () => {
    const alternatives: EditingSample = { ...sample, reference: {
        requiredBeats: [{ label: '完整操作', cueIds: ['C1', 'C2'], alternativeCueIds: [['C4']] }], redundantCueIds: ['C3']
    } };
    expect(measureEditingTimeline(alternatives, [{ start: 5, end: 6 }]).missingBeats).toEqual([]);
    expect(measureEditingTimeline(alternatives, [{ start: 0, end: 1 }]).missingBeats).toEqual(['完整操作']);
    const invalid = structuredClone(alternatives);
    invalid.reference.requiredBeats[0].alternativeCueIds = [[]];
    expect(() => validateEditingSamples([invalid])).toThrow('alternative');
    invalid.reference.requiredBeats[0].alternativeCueIds = [['C999']];
    expect(() => validateEditingSamples([invalid])).toThrow('Unknown');
    invalid.reference.requiredBeats[0].alternativeCueIds = [['C3']];
    expect(() => validateEditingSamples([invalid])).toThrow('Contradictory');
});
