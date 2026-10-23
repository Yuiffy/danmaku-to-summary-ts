export {};
const { resolveAsrHotwords } = require('./asr_backends');
const { applyCorrectionsToSegments, applyCorrectionsToText } = require('./asr_corrections');

const config = (kind: string) => ({
  asr: {
    default_backend: 'paraformer',
    corrections: {
      [kind]: [{ from: '小碎', to: '小岁', require_nearby: ['岁己'], context_window_tokens: 1 }],
      exclude_when: { 小碎: ['小碎步', '小碎片'] }
    },
    routing: [{
      match: { room_id: '1791260716' }, backend: 'paraformer',
      corrections: {
        [kind]: [{ from: '小碎', to: '小岁', require_nearby: ['海獭'], context_window_tokens: 6, boundary_sensitive: false,
          exclude_pattern: ['(?<!给)小碎', '小碎(?!看|买|送)'] }]
      }
    }]
  }
});

describe('global and room correction composition', () => {
  test.each(['safe', 'contextual', 'ambiguous'])('keeps both %s rules and their own conditions', kind => {
    const resolved = resolveAsrHotwords(config(kind), { room_id: '1791260716' }).corrections;
    expect(resolved[kind]).toHaveLength(2);
    expect(applyCorrectionsToText('岁己。小碎', resolved)).toBe('岁己。小岁');
    expect(applyCorrectionsToText('海獭给小碎看', resolved)).toBe('海獭给小岁看');
    if (kind !== 'safe') {
      // The room's nearby keyword must not inherit the global rule's looser phrase condition.
      expect(applyCorrectionsToText('海獭。小碎', resolved)).toBe('海獭。小碎');
      expect(applyCorrectionsToText('给小碎看', resolved)).toBe('给小碎看');
    }
    expect(applyCorrectionsToText('岁己。小碎步和小碎片', resolved)).toBe('岁己。小碎步和小碎片');
    expect(applyCorrectionsToText('海獭给小碎步看', resolved)).toBe('海獭给小碎步看');
  });

  test('does not lose alternatives during normalization or count an overlap twice', () => {
    const resolved = resolveAsrHotwords(config('ambiguous'), { room_id: '1791260716' }).corrections;
    expect(applyCorrectionsToSegments([{ text: '岁己。小碎' }, { text: '海獭给小碎看' }], resolved))
      .toEqual(['岁己。小岁', '海獭给小岁看']);
    const stats = new Map();
    expect(applyCorrectionsToSegments([{ text: '岁己海獭给小碎看' }], resolved, stats))
      .toEqual(['岁己海獭给小岁看']);
    expect([...stats.values()].reduce((sum: number, row: any) => sum + row.count, 0)).toBe(1);
  });

  test('deduplicates identical rules without dropping a distinct window or boundary condition', () => {
    const input = config('ambiguous');
    const global = input.asr.corrections.ambiguous[0];
    input.asr.routing[0].corrections.ambiguous = [global, { ...global, context_window_tokens: 2 }];
    const rules = resolveAsrHotwords(input, { room_id: '1791260716' }).corrections.ambiguous;
    expect(rules).toHaveLength(2);
    expect(rules.map((rule: any) => rule.context_window_tokens)).toEqual([1, 2]);
  });

  test.each(['safe', 'contextual', 'ambiguous'])('inherits global exclusions for a room-only %s rule', kind => {
    const input = config(kind);
    input.asr.corrections[kind] = [];
    const rules = resolveAsrHotwords(input, { room_id: '1791260716' }).corrections;
    expect(applyCorrectionsToText('海獭给小碎步看', rules)).toBe('海獭给小碎步看');
  });

  test('protects a compound split across cues when the global name context matches', () => {
    const resolved = resolveAsrHotwords(config('ambiguous'), { room_id: '1791260716' }).corrections;
    const texts = ['岁己。小碎', '步'];
    expect(applyCorrectionsToSegments(texts.map(text => ({ text })), resolved)).toEqual(texts);
  });

  test('keeps room additions scoped to the matching room', () => {
    const resolved = resolveAsrHotwords(config('ambiguous'), { room_id: '123' }).corrections;
    expect(resolved.ambiguous).toHaveLength(1);
    expect(applyCorrectionsToText('岁己。小碎', resolved)).toBe('岁己。小岁');
    expect(applyCorrectionsToText('海獭给小碎看', resolved)).toBe('海獭给小碎看');
  });

  test('supports room rules when global corrections are explicitly disabled', () => {
    const input = { asr: { ...config('ambiguous').asr, corrections: null } };
    const resolved = resolveAsrHotwords(input, { room_id: '1791260716' }).corrections;
    expect(resolved.ambiguous).toHaveLength(1);
    expect(applyCorrectionsToText('海獭给小碎看', resolved)).toBe('海獭给小岁看');
  });

  test('hotword aliases retain global ordinary-word protections', () => {
    const input = config('ambiguous');
    input.asr['common_hotwords'] = [{ word: '小岁', ambiguous_aliases: ['小碎'], require_nearby: ['前辈'] }];
    const resolved = resolveAsrHotwords(input, { room_id: '1791260716' }).corrections;
    expect(applyCorrectionsToText('小碎前辈', resolved)).toBe('小岁前辈');
    expect(applyCorrectionsToText('小碎步前辈', resolved)).toBe('小碎步前辈');
    expect(applyCorrectionsToText('岁己。小碎', resolved)).toBe('岁己。小岁');
    expect(applyCorrectionsToText('海獭给小碎看', resolved)).toBe('海獭给小岁看');
  });

  test('a conflicting room target does not replace the global target where both match', () => {
    const input = config('ambiguous');
    input.asr.routing[0].corrections.ambiguous = [{
      from: '小碎', to: '另一个人', require_nearby: ['岁己'], context_window_tokens: 1
    }];
    const resolved = resolveAsrHotwords(input, { room_id: '1791260716' }).corrections;
    expect(applyCorrectionsToText('岁己。小碎', resolved)).toBe('岁己。小岁');
  });
});
