export {};
const { applyVisualQaRepair } = require('./creative_qa_repair');

const draft = () => ({ effects: [
    { momentId: 'M1', filter: 'monochrome', sound: { id: 'pop' }, visualConfirmed: true },
    { momentId: 'M2', sticker: { id: 'question' } }
] });

test('removes only selected decoration and drops empty effect nodes without mutating evidence', () => {
    const raw = draft();
    const repaired = applyVisualQaRepair(raw, { repairs: [
        { momentId: 'M1', remove: ['filter'] }, { momentId: 'M2', remove: ['sticker'] }
    ] });
    expect(repaired.effects).toEqual([{ ...raw.effects[0], filter: null }]);
    expect(raw).toEqual(draft());
});

test.each(['zoom', 'faceInset', 'focusInset'])('removes a misplaced %s and preserves timing, sound and all source evidence', field => {
    const raw = { effects: [{ momentId: 'M1', start: 10, end: 15, frameIds: ['M1F0', 'M1F1', 'M1F2'],
        [field]: { sourceBox: { x: .04, y: .7, width: .15, height: .21 }, safeToCrop: true }, sound: { id: 'pop' } }] };
    const repaired = applyVisualQaRepair(raw, { repairs: [{ momentId: 'M1', remove: [field], reason: '放大未对准目标，恢复原图' }] });
    expect(repaired.effects).toEqual([{ ...raw.effects[0], [field]: null }]);
    expect(raw.effects[0][field]).toBeTruthy();
    expect(() => applyVisualQaRepair(raw, { repairs: [{ momentId: 'M1', remove: [field], [field]: { safeToCrop: true } }] })).toThrow();
});

test.each([
    [], [{ momentId: 'M3', remove: ['filter'] }], [{ momentId: 'M1', remove: ['sound'] }],
    [{ momentId: 'M1', remove: ['filter'], visualConfirmed: true }],
    [{ momentId: 'M1', remove: ['filter'] }, { momentId: 'M1', remove: ['filter'] }]
].map(repairs => ({ repairs })))('rejects empty, unknown, unsafe or duplicate repairs: %j', ({ repairs }) => {
    expect(() => applyVisualQaRepair(draft(), { repairs })).toThrow();
});
