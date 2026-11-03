import { createHash } from 'crypto';

type Data = Record<string, any>;

/** Retain an explicitly selected same-game continuation, including its restart gap. */
export function retainGameContinuation(plan: Data, ids: string[]): Data {
  if (!ids.length) return plan;
  const previous = plan.gameContinuation;
  if (previous) {
    if (previous.version !== 1 || JSON.stringify(previous.ids) !== JSON.stringify(ids)) throw new Error('Different game continuation already selected');
    return plan;
  }
  if (plan.status === 'rendered' || plan.uploadManifestPath) throw new Error('Reuse existing game submissions; cannot join rendered media');
  const ordered = [...plan.events].sort((a, b) => a.start - b.start);
  const selected = ordered.filter(e => ids.includes(e.id));
  if (ids.length < 2 || new Set(ids).size !== ids.length || selected.length !== ids.length
    || selected.some(e => e.gameId !== selected[0].gameId)
    || ordered.slice(ordered.indexOf(selected[0]), ordered.indexOf(selected.at(-1)) + 1).length !== selected.length) {
    throw new Error('Continuation requires consecutive events of the same game');
  }
  if (plan.coverage?.status !== 'complete' || plan.visualTimeline?.status !== 'complete'
    || plan.visualTimeline.ranges.some((r: Data) => r.kind === 'uncertain')) throw new Error('Continuation requires complete source coverage');
  const first = selected[0], last = selected.at(-1);
  const event = { id: first.id, gameId: first.gameId, start: first.start, end: last.end,
    startObserved: first.startObserved, endObserved: last.endObserved,
    evidenceIds: [...new Set(selected.flatMap(e => e.evidenceIds))],
    windows: [...new Set(selected.flatMap(e => e.windows || []))],
    chapters: selected.flatMap(e => e.chapters).sort((a, b) => a.start - b.start),
    excludedRanges: selected.flatMap(e => e.excludedRanges || []),
    visualWindow: { first: Math.min(...selected.map(e => e.visualWindow.first)), last: Math.max(...selected.map(e => e.visualWindow.last)) },
    note: 'Continuous same-game session; retain all restart/setup gaps and independently review the outer boundaries.' };
  return { ...plan, events: ordered.flatMap(e => e === first ? [event] : ids.includes(e.id) ? [] : [e]),
    gameContinuation: { version: 1, ids, originalEvents: selected } };
}

/** A continuous archive needs only its outer boundaries, retaining every game switch. */
export function combineGameSessions(plan: Data, config: Data): { plan: Data; config: Data } {
  if (plan.sessionCombination) {
    const game = plan.sessionCombination.game;
    if (plan.sessionCombination.version !== 1 || !game?.members?.length
      || plan.events.length !== 1 || plan.events[0].gameId !== game.id) throw new Error('Invalid combined game session');
    return { plan, config: { ...config, games: [game] } };
  }
  if (plan.status === 'rendered' || plan.uploadManifestPath) throw new Error('Reuse existing game submissions; cannot combine rendered media');
  if (plan.coverage?.status !== 'complete' || plan.visualTimeline?.status !== 'complete'
    || plan.visualTimeline.ranges.some((r: Data) => r.kind === 'uncertain')) throw new Error('Combining requires complete source coverage');
  const events = [...plan.events].sort((a, b) => a.start - b.start);
  const ids = [...new Set<string>(events.map(e => e.gameId))];
  const members = ids.map(id => config.games.find((g: Data) => g.id === id));
  if (members.length < 2 || members.some(g => !g)) throw new Error('Combining needs at least two known games');
  const route = members[0].collection;
  if (!route?.seasonId || !route?.sectionId || members.some(g => g.collection?.seasonId !== route.seasonId
    || g.collection?.sectionId !== route.sectionId)) throw new Error('Combined games must share one collection');
  const game = { ...members[0], id: `game-session-${createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 16)}`,
    name: members.map(g => g.name).join('、'), aliases: members.flatMap(g => [g.name, ...g.aliases]),
    tags: [...new Set(members.flatMap(g => g.tags || []))], members: members.map(g => ({ id: g.id, name: g.name })) };
  const event = { id: 'combined-game-session', gameId: game.id,
    start: events[0].start, end: Math.max(...events.map(e => e.end)),
    startObserved: events[0].startObserved, endObserved: events.at(-1).endObserved,
    evidenceIds: [...new Set(events.flatMap(e => e.evidenceIds))],
    windows: [...new Set(events.flatMap(e => e.windows || []))],
    chapters: events.map(e => ({ ...(e.chapters[0] || { start: e.start, evidenceIds: e.evidenceIds }),
      title: members.find(g => g.id === e.gameId).name, kind: 'phase', nameEvidence: null,
      description: `游玩《${members.find(g => g.id === e.gameId).name}》，保留本场准备和游戏过程。` })),
    excludedRanges: events.flatMap(e => e.excludedRanges || []),
    visualWindow: { first: Math.min(...events.map(e => e.visualWindow.first)), last: Math.max(...events.map(e => e.visualWindow.last)) },
    note: 'Continuous multi-game session; all intervals between games are retained. Independently verify the outer boundaries and the complete public chapters.' };
  return { plan: { ...plan, events: [event], sessionCombination: { version: 1, game, originalEvents: events } },
    config: { ...config, games: [game] } };
}
