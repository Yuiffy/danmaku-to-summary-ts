import { combineGameSessions, retainGameContinuation } from './gameSessions';

const game = (id: string) => ({ id, name: id, aliases: [id], tags: [id], collection: { seasonId: 1, sectionId: 2 } });
const event = (id: string, start: number, end: number) => ({ id, gameId: id, start, end,
  startObserved: false, endObserved: false, evidenceIds: [`T${start}`], windows: [1],
  chapters: [{ start: start + 5, title: 'old', evidenceIds: [`T${start}`] }],
  excludedRanges: [{ start: start + 10, end: start + 15, reason: 'exclude', evidenceIds: [`T${start}`] }],
  visualWindow: { first: start + 20, last: end - 20 }, verification: { decision: 'uncertain' } });
const fixture = () => ({ plan: { status: 'planned', coverage: { status: 'complete' },
  visualTimeline: { status: 'complete', ranges: [{ kind: 'gameplay' }] },
  events: [event('a', 10, 100), event('b', 200, 300), event('c', 400, 500)] },
  config: { games: ['a', 'b', 'c'].map(game) } });

test('explicit same-game continuity keeps restart gaps, chapters and exclusions, with a fresh review', () => {
  const { plan } = fixture();
  plan.events[2].gameId = 'b';
  const joined = retainGameContinuation(plan, ['b', 'c']);
  expect(joined.events).toHaveLength(2);
  expect(joined.events[0]).toBe(plan.events[0]);
  expect(joined.events[1]).toMatchObject({ id: 'b', gameId: 'b', start: 200, end: 500 });
  expect(joined.events[1].verification).toBeUndefined();
  expect(joined.events[1].chapters).toHaveLength(2);
  expect(joined.events[1].excludedRanges).toHaveLength(2);
  expect(joined.gameContinuation.originalEvents).toEqual(plan.events.slice(1));
  expect(retainGameContinuation(joined, ['b', 'c'])).toBe(joined);
  expect(() => retainGameContinuation(plan, ['a', 'c'])).toThrow('consecutive');
  expect(() => retainGameContinuation(plan, ['a', 'b'])).toThrow('same game');
  expect(() => retainGameContinuation({ ...plan, status: 'rendered' }, ['b', 'c'])).toThrow('Reuse existing');
});

test('retains the whole multi-game interval, gaps and exclusions without inheriting any approval', () => {
  const { plan, config } = fixture();
  const original = JSON.stringify(plan);
  const combined = combineGameSessions(plan, config);
  expect(JSON.stringify(plan)).toBe(original);
  const session = combined.plan.events[0];
  expect(session).toMatchObject({ start: 10, end: 500, visualWindow: { first: 30, last: 480 } });
  expect(session.verification).toBeUndefined();
  expect(session.chapters.map((c: any) => c.title)).toEqual(['a', 'b', 'c']);
  expect(session.excludedRanges).toHaveLength(3);
  expect(combined.plan.sessionCombination.originalEvents).toEqual(plan.events);
  expect(combined.config.games[0].members.map((g: any) => g.id)).toEqual(['a', 'b', 'c']);
  expect(combineGameSessions(combined.plan, config)).toEqual(combined);
});

test('cannot turn incomplete source coverage or a mismatched collection into a combined archive', () => {
  const { plan, config } = fixture();
  expect(() => combineGameSessions({ ...plan, coverage: { status: 'incomplete' } }, config)).toThrow('coverage');
  expect(() => combineGameSessions({ ...plan, visualTimeline: { status: 'complete', ranges: [{ kind: 'uncertain' }] } }, config)).toThrow('coverage');
  config.games[1].collection.sectionId = 9;
  expect(() => combineGameSessions(plan, config)).toThrow('one collection');
});

test('rendered or registered source must reuse its existing submissions', () => {
  const { plan, config } = fixture();
  expect(() => combineGameSessions({ ...plan, status: 'rendered' }, config)).toThrow('Reuse existing');
  expect(() => combineGameSessions({ ...plan, uploadManifestPath: 'existing.json' }, config)).toThrow('Reuse existing');
});

test('combined public copy names all games without a detailed phase title', () => {
  const { plan, config } = fixture();
  const combined = combineGameSessions(plan, config);
  const { publicCopy } = require('../../scripts/clipping/stream_game_render');
  const copy = publicCopy({ streamerName: 'Sui', streamTitle: '和栞栞联动', recordedAt: '2026-10-28' },
    combined.config.games[0], [{ start: 10, chapters: combined.plan.events[0].chapters }], 1, 1, 2);
  expect(copy.title).toBe('游戏联动｜a、b、c（1/2） 2026-10-28');
  expect(copy.description).toContain('中文字幕可在播放器中开关');
  const { parseArgs } = require('../../scripts/stream_game_clips');
  expect(parseArgs(['run', '--combine-games']).options['combine-games']).toBe(true);
});
