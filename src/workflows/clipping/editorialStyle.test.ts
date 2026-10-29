import { clipStyle, composeTimeline, parseSrt, projectCues, writeSrt, validateHookBudget } from './editorialStyle';
const cues = [{ start: 0, end: 3, text: '开场' }, { start: 8, end: 11, text: '反转' }, { start: 15, end: 19, text: '解释' }];
const plan = (highlights: Array<{ start: number; end: number }>, repetition?: 'auto' | 'keep' | 'omit_prefix') =>
    ({ version: 1 as const, reason: '保留完整原话及后文解释', highlights, repetition });
test('chronological opening continues after OP without repeating', () => {
    const t = composeTimeline(30, 6, plan([{ start: 0, end: 4 }]), cues);
    expect(t.repetition).toBe('omit_prefix');
    expect(t.duration).toBe(36);
    expect(t.pieces.at(-1)).toMatchObject({ start: 4, outputStart: 10 });
});
test('montage repeats in complete chronological body and projects both subtitle occurrences', () => {
    const t = composeTimeline(30, 6, plan([{ start: 8, end: 11 }, { start: 15, end: 19 }]), cues);
    expect(t.repetition).toBe('keep');
    expect(t.duration).toBe(43);
    const out = projectCues(t.pieces, cues, [{ start: 0, end: 2, text: '鹿饼' }]);
    expect(out.filter(c => c.text === '反转').map(c => c.start)).toEqual([0, 21]);
    expect(out.find(c => c.text === '鹿饼')?.start).toBe(7);
    expect(parseSrt(writeSrt(out))).toEqual(out);
});
test('explicit keep also supports an opening teaser', () => {
    expect(composeTimeline(30, 6, plan([{ start: 0, end: 4 }], 'keep'), cues).repetition).toBe('keep');
});
test.each([
    plan([{ start: 1, end: 3 }]), plan([{ start: 8, end: 10 }]),
    plan([{ start: 8, end: 11 }], 'omit_prefix'), plan([{ start: 8, end: 11 }, { start: 9, end: 12 }]),
    plan([{ start: 0, end: 25 }]), plan([{ start: 28, end: 32 }])
])('invalid / speech-splitting plans fail before rendering', p => {
    expect(() => composeTimeline(30, 6, p, cues)).toThrow();
});
test('three explicit modes and unknown mode rejection', () => {
    expect(['普通', '重点前置', '精切'].map(clipStyle)).toEqual(['ordinary', 'highlight_first', 'precision']);
    expect(() => clipStyle('other')).toThrow();
});
test('new short clips reject excessive repeated answers while historical timelines remain auditable', () => {
    const answer = [{ start: 15, end: 25.5, text: '完整答案' }];
    const p = plan([{ start: 15, end: 25.5 }]);
    expect(() => validateHookBudget(36.8, p, answer)).toThrow(/Repeated teaser/);
    expect(composeTimeline(36.8, 3.2, p, answer).hookSeconds).toBe(10.5);
    expect(() => validateHookBudget(36.8, plan([{ start: 0, end: 10.5 }]), [{ start: 0, end: 10, text: '提问' }])).not.toThrow();
});
