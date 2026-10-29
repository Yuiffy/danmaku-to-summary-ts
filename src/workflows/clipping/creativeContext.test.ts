import { contextQuestion, contextAss } from './creativeContext';

const rows = [{ time: 90.12, text: '你喜欢什么题材？' }];
test('preceding original audience question is labelled and preserved as an overlay, not speech', () => {
    const context = contextQuestion(90.12, rows, { start: 110, end: 145 });
    expect(context).toMatchObject({ text: rows[0].text, time: 90.12, end: 6, kind: 'audience_question' });
    const ass = contextAss(context, 1920, 1080);
    expect(ass).toContain('前情提要 · 观众弹幕\\N你喜欢什么题材？');
    expect(ass).toContain('0:00:00.00,0:00:06.00');
});
test('missing, ambiguous, future and distant comments cannot become context', () => {
    for (const at of [50, 115, NaN]) expect(() => contextQuestion(at, rows, { start: 110, end: 145 })).toThrow();
    expect(() => contextQuestion(90.12, [...rows, ...rows], { start: 110, end: 145 })).toThrow();
    expect(() => contextQuestion(90.12, rows, { start: 250, end: 280 })).toThrow();
});
test('ASS commands in audience input cannot change placement or inject events', () => {
    const context = contextQuestion(90.12, [{ time: 90.12, text: '{\\pos(0,0)}题材？' }], { start: 110, end: 145 });
    expect(contextAss(context, 1920, 1080)).not.toContain('{\\pos(0,0)}');
});
