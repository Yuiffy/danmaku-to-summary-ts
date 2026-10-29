import { buildEditingBoundaryReview } from './editingBoundaryReview';

test('audits both original sides of a cut even without subtitle evidence', () => {
    const result = buildEditingBoundaryReview([{ start: 0, end: 2 }, { start: 8, end: 10 }],
        [{ id: 'C1', start: 1, end: 2.2, text: '还没有说完' }], 10);
    expect(result.joins[0]).toMatchObject({ removedSeconds: 6, windows: [
        { side: 'outgoing', sourceTime: 2, start: 1.25, end: 2.75, cues: [{ id: 'C1' }] },
        { side: 'incoming', sourceTime: 8, start: 7.25, end: 8.75, cues: [] }
    ] });
    expect(result).toMatchObject({ audioReviewed: false, visualReviewed: false, publicationApproved: false });
});

test('clamps review to source and ignores contiguous ranges', () => {
    const keep = [{ start: 0, end: .1 }, { start: .1, end: .2 }, { start: 9.9, end: 10 }];
    const before = JSON.stringify(keep);
    const result = buildEditingBoundaryReview(keep, [], 10);
    expect(result.joins).toHaveLength(1);
    expect(result.joins[0].windows.map(w => [w.start, w.end])).toEqual([[0, .95], [9.15, 10]]);
    expect(JSON.stringify(keep)).toBe(before);
    expect(() => buildEditingBoundaryReview([{ start: 0, end: 11 }], [], 10)).toThrow('ranges');
    expect(() => buildEditingBoundaryReview([{ start: 0, end: 2 }, { start: 1, end: 3 }], [], 10)).toThrow('ranges');
    expect(() => buildEditingBoundaryReview(keep, [], 10, NaN)).toThrow('ranges');
});
