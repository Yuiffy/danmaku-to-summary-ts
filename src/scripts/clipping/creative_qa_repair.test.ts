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

test.each([
    [], [{ momentId: 'M3', remove: ['filter'] }], [{ momentId: 'M1', remove: ['sound'] }],
    [{ momentId: 'M1', remove: ['filter'], visualConfirmed: true }],
    [{ momentId: 'M1', remove: ['filter'] }, { momentId: 'M1', remove: ['filter'] }]
].map(repairs => ({ repairs })))('rejects empty, unknown, unsafe or duplicate repairs: %j', ({ repairs }) => {
    expect(() => applyVisualQaRepair(draft(), { repairs })).toThrow();
});
