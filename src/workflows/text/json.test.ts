import { parseModelJson } from './json';

test('repairs Chinese delimiters but preserves all quoted dialogue and escaped strings', () => {
    const repaired = jest.fn();
    const input = '{"reviews"：[ {"text":"原话，冒号：和\\\"引号\\\""}，{"text":"path\\\\，末尾"}]}';
    expect(parseModelJson(input, repaired)).toEqual({ reviews: [{ text: '原话，冒号：和"引号"' }, { text: 'path\\，末尾' }] });
    expect(repaired).toHaveBeenCalledWith(expect.objectContaining({ count: 2, sourceSha256: expect.any(String), repairedSha256: expect.any(String) }));
});
test('drops only a redundant comma before a closer and keeps every member', () => {
    const repaired = jest.fn();
    expect(parseModelJson('{"clips":[{"id":"E1-1"}],}', repaired)).toEqual({ clips: [{ id: 'E1-1' }] });
    expect(repaired).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
    const arrayRepair = jest.fn();
    expect(parseModelJson('{"hitIds":["K1",],}', arrayRepair)).toEqual({ hitIds: ['K1'] });
    expect(arrayRepair).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }));
});
test('keeps quoted commas and values untouched when repairing delimiters', () => {
    expect(parseModelJson('{"text":"a,] b,}",}')).toEqual({ text: 'a,] b,}' });
});
test.each(['{"x":1，', '{"x":"broken，}', '{"x":NaN}', '{"x":undefined}', '{x:1}', '{"x":1', '{"x":[1,2'])('does not invent missing JSON or coerce content: %s', value => {
    expect(() => parseModelJson(value)).toThrow();
});
test('valid JSON and code fences require no repair', () => {
    const repaired = jest.fn();
    expect(parseModelJson('```json\n{"text":"，："}\n```', repaired)).toEqual({ text: '，：' });
    expect(repaired).not.toHaveBeenCalled();
});
