import { QuestionRuntime } from '../../live-vote/questions/EvidenceQuery';
import { QuestionCorpus } from '../../live-vote/questions/QuestionCorpus';
import { configuredQuestionRooms } from '../../live-vote/questions/QuestionScope';
import { CommentEvent, CommentPlatformBlocked, CommentReplyConfig } from './CommentPolicy';
import { collaborationQuestion, historicalCollaborationQuestion, CommentClue, CommentContext, commentDates, commentSearchTerms,
  CommentVideo, needsCommentEvidence, safeEvidenceText, videoOnlyQuestion, videoExcerpts } from './CommentContext';
import { evidenceScorer } from '../../live-vote/questions/EvidenceRanking';

type Options = NonNullable<CommentReplyConfig['knowledge']>;
type SearchResult = { clues: Array<CommentClue & { roomId: string; score: number }>; partial: boolean };
interface KnowledgeIO { video(aid: string, signal: AbortSignal): Promise<CommentVideo>; now(): number }

/** Local FTS only: no answer/planner/embedding calls, no writes or agent-selected paths. */
export function createCommentKnowledge(runtime: QuestionRuntime, options: Options, io: KnowledgeIO) {
  const rooms = configuredQuestionRooms(runtime.questions);
  const allowed = [...new Set([options.roomId, ...options.collaborationRooms])];
  if (!runtime.questions.lexical?.enabled || allowed.some(id => !rooms.some(room => room.roomId === id))) {
    throw new Error('Comment knowledge requires configured rooms and the read-only lexical index');
  }
  const videos = new Map<string, { at: number; value: CommentVideo }>();
  const searches = new Map<string, { at: number; value: SearchResult }>();
  const put = <T>(cache: Map<string, { at: number; value: T }>, key: string, value: T) => {
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: io.now(), value });
  };
  const get = <T>(cache: Map<string, { at: number; value: T }>, key: string) => {
    const entry = cache.get(key);
    return entry && io.now() - entry.at < 60000 ? entry.value : undefined;
  };
  const aliases = rooms.filter(room => allowed.includes(room.roomId)).flatMap(room => {
    const name = /^[\p{Script=Han}]+/u.exec(room.name)?.[0] || room.name;
    return [...room.aliases, `小${name[0]}`, `小${name.at(-1)}`];
  }).filter(alias => alias.length >= 2);
  async function search(roomId: string, date: string | null, terms: string[], question: string, signal: AbortSignal,
    collection: 'recordings' | 'clips' = 'recordings', kind: 'subtitle' | 'danmaku' = 'subtitle'): Promise<SearchResult> {
    const key = JSON.stringify([roomId, date, terms, question, collection, kind]);
    const cached = get(searches, key);
    if (cached) return cached;
    // Each corpus is constrained to exactly one trusted room. User mentions cannot expand the scope.
    const config = { ...runtime.questions, semantic: undefined,
      recordingRoots: { [roomId]: runtime.questions.recordingRoots[roomId] } };
    const corpus = new QuestionCorpus(config, { roomId, question }, signal, runtime.botUid);
    try {
      const result = await corpus.search({ terms, kind, date, collection });
      const topicScore = evidenceScorer(terms, question);
      const score = (text: string) => {
        const relevance = topicScore(text);
        if (historicalCollaborationQuestion(question) && !relevance) return 0;
        return relevance * 5 + (collaborationQuestion(question) ? aliases.filter(alias => text.includes(alias)).length * 8 +
          (/明天|明晚|八点|取消|延期|改期/u.test(text) ? 4 : 0) : 0);
      };
      // A historical list needs candidates from different dates before repeated nearby mentions.
      const seenDates = new Set<string | null>();
      const firstByDate = historicalCollaborationQuestion(question) ? result.hits.filter(hit => {
        if (seenDates.has(hit.date)) return false;
        seenDates.add(hit.date); return true;
      }) : [];
      const candidates = [...firstByDate, ...result.hits.filter(hit => !firstByDate.includes(hit))];
      const clues = candidates.slice(0, 8).map(hit => {
        const expanded = corpus.context({ evidenceId: hit.evidenceId });
        const cues = ('context' in expanded ? expanded.context : hit.context)
          .map(cue => ({ ...cue, text: safeEvidenceText(cue.text) })).filter(cue => cue.text);
        const ranked = cues.map((cue, index) => ({ index, score: score(cue.text) }))
          .sort((a, b) => b.score - a.score || a.index - b.index);
        // Preserve original order and a few surrounding cues; the model sees ASR as evidence, never a verified speaker label.
        const selected = new Set<number>();
        let chars = 0;
        const candidates = ranked.filter(cue => cue.score > 0).slice(0, 4)
          .flatMap(cue => [cue.index, cue.index - 1, cue.index + 1]);
        for (const i of candidates) if (i >= 0 && i < cues.length && !selected.has(i) && chars + cues[i].text.length + 1 <= 180) {
          selected.add(i); chars += cues[i].text.length + 1;
        }
        const quote = [...selected].sort((a, b) => a - b).map(i => cues[i].text).join('；');
        return { roomId, room: hit.roomName || roomId, date: hit.date || date || '', time: hit.time, quote, kind: hit.kind || 'subtitle',
          score: Math.max(0, ...ranked.map(cue => cue.score)) };
      }).filter(clue => clue.quote && clue.score > 0);
      const value = { clues, partial: result.limited || corpus.coverage.get(roomId)?.lexicalStatus !== 'ready' };
      put(searches, key, value);
      return value;
    } finally { await corpus.close(); }
  }

  return async (event: CommentEvent, signal: AbortSignal): Promise<CommentContext | undefined> => {
    if (!needsCommentEvidence(event.text)) return undefined;
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 12000);
    let video: CommentVideo | undefined;
    const collected: SearchResult['clues'] = [];
    let partial = false;
    let historical = false, primaryRooms = [options.roomId];
    try {
      if (event.type === 1) {
        video = get(videos, event.oid);
        if (!video) {
          try {
            video = await io.video(event.oid, controller.signal);
            // Missing URLs/failed captions are transient; do not cache a title-only result.
            if (video.transcript?.cues.length) put(videos, event.oid, video);
          }
          catch (error) { if (error instanceof CommentPlatformBlocked) throw error; partial = true; }
        }
      }
      const dates = commentDates(event.text, event.createdAt, video, event.type === 1);
      const topic = `${event.text} ${video?.title || ''}`;
      const named = rooms.filter(room => allowed.includes(room.roomId) && [room.name, ...room.aliases]
        .some(alias => alias.length >= 2 && topic.includes(alias))).map(room => room.roomId);
      const selectedRooms = collaborationQuestion(topic) ? allowed : named.length ? named : [options.roomId];
      historical = historicalCollaborationQuestion(event.text) && !dates.targetDay;
      primaryRooms = named.length ? named : [options.roomId];
      const terms = commentSearchTerms(topic);
      const question = Array.from(event.text.replace(/@\S+/gu, '').trim()).slice(0, 120).join('') || '直播资料';
      // Video-based praise/support also needs the target, never a different recording.
      const videoOnly = event.type === 1 && videoOnlyQuestion(event.text);
      const datesToSearch: Array<string | null> = videoOnly ? [] : historical ? [dates.anchorDay.slice(0, 7),
        new Date(Date.UTC(Number(dates.anchorDay.slice(0, 4)), Number(dates.anchorDay.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7), null] : collaborationQuestion(topic) ?
        Array.from({ length: 3 }, (_, offset) => new Date(Date.parse(dates.anchorDay) - offset * 86400000).toISOString().slice(0, 10)) :
        [dates.targetDay || null];
      for (const date of datesToSearch) {
        for (const room of selectedRooms) {
          controller.signal.throwIfAborted();
          try {
            const result = await search(room, date, terms, question, controller.signal);
            collected.push(...result.clues); partial ||= result.partial;
            let roomClues = result.clues.length;
            if (!collaborationQuestion(topic) && roomClues < 4) {
              const clips = await search(room, date, terms, question, controller.signal, 'clips');
              collected.push(...clips.clues); partial ||= clips.partial;
              roomClues += clips.clues.length;
            }
            if (!collaborationQuestion(topic) && roomClues < 4) {
              const audience = await search(room, date, terms, question, controller.signal, 'recordings', 'danmaku');
              collected.push(...audience.clues); partial ||= audience.partial;
            }
          } catch { partial = true; controller.signal.throwIfAborted(); }
        }
      }
    } catch (error) { if (error instanceof CommentPlatformBlocked) throw error; partial = true; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    const audience = (clue: CommentClue) => clue.kind === 'danmaku' ? 1 : 0;
    const ranked = collected.sort((a, b) => audience(a) - audience(b) ||
      (historical ? b.date.localeCompare(a.date) : 0) || b.score - a.score || b.date.localeCompare(a.date));
    const chosen: typeof ranked = [], used = new Set<string>();
    // Historical questions first retain distinct dates for the requested broadcaster.
    // Dates diversify candidates; only the answer model can determine whether they describe separate events.
    const preferred = historical ? ranked.filter(clue => primaryRooms.includes(clue.roomId)) : ranked;
    for (const clue of preferred) {
      const key = historical ? clue.date : clue.room;
      if (!used.has(key)) { chosen.push(clue); used.add(key); }
    }
    for (const clue of ranked) if (!chosen.some(existing => existing.room === clue.room && existing.date === clue.date &&
        existing.kind === clue.kind && existing.quote === clue.quote)) chosen.push(clue);
    const excerpts = videoExcerpts(video?.transcript?.cues || [], `${event.text} ${video?.title || ''}`);
    const sampled = !!video?.transcript && (video.transcript.partial || excerpts.length < video.transcript.cues.length || (video.pages || 1) > 1);
    return { ...commentDates(event.text, event.createdAt, video, event.type === 1),
      ...(video ? { video: { title: safeEvidenceText(video.title, 120),
        description: video.description.split(/\r?\n/u).map(line => safeEvidenceText(line, 180)).filter(Boolean).join(' ').slice(0, 400),
        content: excerpts.length ? 'subtitles' as const : 'unavailable' as const, scope: 'first-page' as const,
        ...(excerpts.length ? { language: video.transcript!.language, sampled, excerpts } : {}) } } : {}),
      coverage: !collected.length && !excerpts.length ? 'unavailable' : partial || sampled ? 'partial' : 'available',
      clues: chosen.slice(0, 8).map(({ room, date, time, quote, kind }) => ({ room, date, time, quote, kind })) };
  };
}
