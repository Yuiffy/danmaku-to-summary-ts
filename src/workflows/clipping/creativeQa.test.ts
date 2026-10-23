import { normalizeCreativeQa } from './creativeQa';

test.each([false, true])('structured source requirements survive normalization (serialized: %s)', serialized => {
    const issue = { '位置': 'C18之后，素材窗外R361', '问题': '需扩展素材核实剧情结尾', requiredSourceCueIds: ['R361'] };
    const input = { approved: false, needsSourceExpansion: true, requiredSourceCueIds: ['R360', 'R361'],
        issues: [serialized ? JSON.stringify(issue) : issue] };
    const result = normalizeCreativeQa(input);
    expect(result).toMatchObject({ approved: false, needsSourceExpansion: true, requiredSourceCueIds: ['R360', 'R361'] });
    expect(JSON.parse(result.issues[0])).toEqual(issue);
    expect(normalizeCreativeQa(result)).toEqual(result);
    expect(input.issues[0]).toEqual(serialized ? JSON.stringify(issue) : issue);
});

test('prose and arbitrary JSON do not invent source requirements or approval', () => {
    const issues = ['请检查R361之后的剧情', '{invalid', 'null', '{"requiredSourceCueIds":["R999"]}'];
    expect(normalizeCreativeQa({ approved: false, issues })).toEqual({ approved: false, issues });
});

test.each([null, 'R361', ['C361'], [null]])('malformed structured source IDs fail closed: %p', ids => {
    expect(() => normalizeCreativeQa({ approved: false, issues: [{ issue: '扩窗', requiredSourceCueIds: ids }] }))
        .toThrow('Invalid creative QA source cue IDs');
});
