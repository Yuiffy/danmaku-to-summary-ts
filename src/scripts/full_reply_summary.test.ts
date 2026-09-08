const combined = require('./full_reply_summary');
const loader = require('./config-loader');
const live = require('./live_generation_context');

describe('combined full reply and summary evidence', () => {
  const reply = 'Wow! The team defeated the boss after a careful practice round. The coffee break joke made everyone laugh, and the whole evening felt welcoming. Rest well after the stream!';
  const source = () => combined.evidenceContext([
    { start: 10, end: 15, text: '[Guest 0.8] The team defeated the boss after a careful practice round.' },
    { start: 17, end: 20, text: '[Host 0.9] The coffee break joke made everyone laugh.' },
    { start: 30, end: 35, text: '[Host 0.9] We are playing Chess now.' }
  ], [{ time: 31, text: 'Chess was fun today' }], '1', {
    ai: { roomSettings: { '1': { anchorName: 'Host' } } }
  });
  const payload = () => ({ reply, content: { overview: 'Team practice and Chess.', activityTypes: ['game'],
    songs: [], games: ['Chess'], topics: ['Team practice'] }, evidence: [
    { target: 'reply', value: 'The team defeated the boss', sourceIds: ['T1'], actor: 'team' },
    { target: 'game', value: 'Chess', sourceIds: ['T3'], actor: 'host' }
  ] });
  beforeEach(() => jest.spyOn(loader, 'getNames').mockReturnValue({ anchor: 'Host', fan: 'Fans' }));
  afterEach(() => jest.restoreAllMocks());

  it('links exact nearby speech and activity names without declaring semantic truth', () => {
    const result = combined.validateCombinedResult(JSON.stringify(payload()), source(), '1', 250);
    expect(result.reply).toBe(reply);
    expect(result.content.games).toEqual(['Chess']);
    expect(result.evidence.every((e: any) => e.linked)).toBe(true);
    expect(result.validation.semanticTruthProven).toBe(false);
  });

  it.each([
    ['invalid ID', (p: any) => { p.evidence[0].sourceIds = ['G1']; }],
    ['outside ID', (p: any) => { p.evidence[0].sourceIds = ['T9999']; }],
    ['missing evidence', (p: any) => { p.evidence[0].sourceIds = []; }],
    ['too many IDs', (p: any) => { p.evidence[0].sourceIds = Array(7).fill('T1'); }],
    ['actor kind', (p: any) => { p.evidence[0].actor = 'singing'; }],
    ['wrong actor', (p: any) => { p.evidence[0].actor = 'host'; }],
    ['invented game', (p: any) => { p.content.games = ['Poker']; p.evidence[1].value = 'Poker'; }],
    ['missing game evidence', (p: any) => { p.evidence[1].target = 'reply'; p.evidence[1].value = 'The coffee break joke'; }],
    ['unpublished claim', (p: any) => { p.evidence[0].value = 'She healed everyone'; }],
    ['long overview', (p: any) => { p.content.overview = 'x'.repeat(81); }],
    ['long reply', (p: any) => { p.reply += 'x'.repeat(251); }],
    ['bad activity', (p: any) => { p.content.activityTypes = ['unknown-category']; }]
  ])('rejects %s before publishing', (_label, mutate: any) => {
    const p = payload();
    mutate(p);
    expect(() => combined.validateCombinedResult(JSON.stringify(p), source(), '1', 250)).toThrow();
  });

  it('does not allow an audience quote to prove a host action', () => {
    const p = payload();
    p.evidence[1] = { ...p.evidence[1], sourceIds: ['D1'] };
    expect(() => combined.validateCombinedResult(JSON.stringify(p), source(), '1', 250)).toThrow('Host attribution');
  });

  it('keeps all source text ahead of task suffixes for cache reuse', () => {
    const fullPrefix = `${live.SHARED_PROMPT_CACHE_START}\nFULL SOURCE including the last topic\n${live.SHARED_PROMPT_CACHE_END}`;
    const prompt = combined.buildCombinedPrompt({ fullPrefix, highlight: 'original highlight', roomId: '1',
      context: { liveTitle: 'test', contentHints: [], recentDynamics: [] }, source: source() });
    expect(prompt.startsWith(fullPrefix)).toBe(true);
    expect(prompt).toContain('including the last topic');
    expect(prompt).toContain('Do not generate a comic script');
    expect(prompt).toContain('Only these source speaker labels identify the host: ["host"]');
  });
});
