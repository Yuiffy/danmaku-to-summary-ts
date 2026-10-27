/** Pure recall hypotheses. Original subtitle words are never replaced here. */
import { findTopicMemeMatches, topicMemeIdentityIssues } from './topicMemeRecall';
import type { TopicMemeConfig, TopicMemeEvidence } from './topicMemeRecall';
export interface TopicRecallSegment { start: number; end: number; text: string; [key: string]: unknown }
export interface TopicRecallRule {
    id: string;
    keyword: string;
    forms: string[];
    roomIds?: string[];
    requireNearby?: string[];
    cuePattern?: string;
    excludePatterns?: string[];
}
export interface TopicRecallConfig {
    enabled?: boolean;
    contextSeconds?: number;
    rules?: TopicRecallRule[];
}
export interface TopicRecallHypothesis {
    ruleId: string;
    form: string;
    keyword: string;
    startChar: number;
    endChar: number;
}
export interface TopicRecallEvidence {
    kind: 'ambiguous_asr' | 'meme_reference';
    requiresSemanticConfirmation: true;
    hypotheses: TopicRecallHypothesis[];
    meme?: TopicMemeEvidence;
}
export interface TopicRecallMatch {
    index: number;
    segment: TopicRecallSegment;
    matchedKeywords: string[];
    recall?: TopicRecallEvidence;
}
interface TopicConfig {
    keywords: string[];
    ignoredRoomIds?: string[];
    review?: { enabled?: boolean; mode?: string };
    ambiguousRecall?: TopicRecallConfig;
    memeRecall?: TopicMemeConfig;
}
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const lowSignal = /谢谢|谢|感谢|灯牌|粉丝团|人气票|礼物|舰长|上舰|提督|总督|\bID\b|昵称/iu;
const asciiWord = (value: string): boolean => /[a-z0-9_]/iu.test(value);

export function findAmbiguousTopicMatches(segments: TopicRecallSegment[], config: TopicConfig,
    context: { roomId?: string | null } = {}): TopicRecallMatch[] {
    const recall = config.ambiguousRecall;
    if (!recall?.enabled || config.review?.enabled !== true || config.review.mode !== 'preflight'
        || config.ignoredRoomIds?.includes(String(context.roomId || ''))) return [];
    const configuredSeconds = Number(recall.contextSeconds);
    const seconds = Number.isFinite(configuredSeconds) ? Math.min(120, Math.max(0, configuredSeconds)) : 45;
    const keywords = new Set(config.keywords);
    const rules = (recall.rules || []).filter(rule => keywords.has(rule.keyword)
        && (!rule.roomIds?.length || rule.roomIds.includes(String(context.roomId || '')))).map(rule => {
        if (!rule.id || !rule.keyword || !Array.isArray(rule.forms) || !rule.forms.length
            || rule.forms.some(form => typeof form !== 'string' || form.length < 2)
            || (!rule.cuePattern && !rule.requireNearby?.length)) throw new Error('Invalid ambiguous topic recall rule');
        return { ...rule, pattern: rule.cuePattern ? new RegExp(rule.cuePattern, 'iu') : null,
            excluded: (rule.excludePatterns || []).map(pattern => new RegExp(pattern, 'giu')) };
    });
    const matches: TopicRecallMatch[] = [];
    for (const [index, segment] of segments.entries()) {
        const text = String(segment.text || '');
        if (!text || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)
            || segment.end <= segment.start || lowSignal.test(text)) continue;
        let nearby: string | undefined;
        const hypotheses: TopicRecallHypothesis[] = [];
        for (const rule of rules) {
            if (rule.pattern && !rule.pattern.test(text)) continue;
            const occurrences = rule.forms.filter(form => text.toLowerCase().includes(form.toLowerCase()))
                .flatMap(form => Array.from(text.matchAll(new RegExp(escaped(form), 'giu')))
                .map(match => ({ form: match[0], startChar: match.index!, endChar: match.index! + match[0].length })));
            if (!occurrences.length) continue;
            if (rule.requireNearby?.length) {
                nearby ??= segments.filter(row => row.end >= segment.start - seconds && row.start <= segment.end + seconds)
                    .map(row => row.text).join('\n').toLowerCase();
                if (!rule.requireNearby.some(term => nearby!.includes(term.toLowerCase()))) continue;
            }
            for (const occurrence of occurrences) {
                // Latin forms must not rewrite/infer a name inside IDs such as abc机.
                if (/^[a-z]/iu.test(occurrence.form) && asciiWord(text[occurrence.startChar - 1] || '')) continue;
                if (/[a-z]$/iu.test(occurrence.form) && asciiWord(text[occurrence.endChar] || '')) continue;
                const protectedOccurrence = rule.excluded.some(pattern => Array.from(text.matchAll(pattern))
                    .some(match => match.index! < occurrence.endChar && match.index! + match[0].length > occurrence.startChar));
                if (protectedOccurrence) continue;
                hypotheses.push({ ruleId: rule.id, keyword: rule.keyword, ...occurrence });
            }
        }
        if (hypotheses.length) matches.push({ index, segment,
            matchedKeywords: [...new Set(hypotheses.map(hypothesis => hypothesis.keyword))],
            recall: { kind: 'ambiguous_asr', requiresSemanticConfirmation: true, hypotheses } });
    }
    return matches;
}

/** A literal anchor retains its existing contract when a cue also contains an alias. */
export function mergeTopicRecallMatches(segments: TopicRecallSegment[], literal: TopicRecallMatch[],
    config: TopicConfig, context: { roomId?: string | null } = {}): TopicRecallMatch[] {
    const literalIndices = new Set(literal.map(match => match.index));
    const names = [...literal, ...findAmbiguousTopicMatches(segments, config, context)
        .filter(match => !literalIndices.has(match.index))];
    const nameIndices = new Set(names.map(match => match.index));
    return [...names, ...findTopicMemeMatches(segments, config, context)
        .filter(match => !nameIndices.has(match.index))].sort((a, b) => a.index - b.index);
}

interface AssessedHit {
    cueId: string;
    verdict: string;
    evidenceCueIds: string[];
    evidenceDanmakuIds?: string[];
    recall?: TopicRecallEvidence;
}
interface SourceCue { id: string; start: number; end: number; text: string }

/** A model label alone cannot authorize an ambiguous-name clip. */
export function topicRecallIdentityIssues(hits: AssessedHit[], subtitles: SourceCue[],
    bounds: { start: number; end: number }, audience: Array<{ id: string; time: number; text: string }> = []): string[] {
    const inside = new Set(subtitles.filter(cue => cue.start >= bounds.start && cue.end <= bounds.end).map(cue => cue.id));
    return [...topicMemeIdentityIssues(hits, subtitles, bounds, audience), ...hits.filter(hit =>
        hit.recall?.requiresSemanticConfirmation && hit.recall.kind !== 'meme_reference' && hit.verdict !== 'false_match').flatMap(hit => {
        if (hit.verdict !== 'mention') return [`疑似人名 ${hit.cueId} 的语义尚未确认`];
        if (!hit.evidenceCueIds.some(id => id !== hit.cueId && inside.has(id))) {
            return [`疑似人名 ${hit.cueId} 缺少片内独立语义依据`];
        }
        return [];
    })];
}

interface PendingRecallHit extends AssessedHit { id: string; start: number; end: number }
interface RecallPlan {
    groupId: string;
    sourceSha256: string;
    hits: PendingRecallHit[];
    clips: Array<Record<string, unknown>>;
    [key: string]: unknown;
}
interface RecallWindow { start: number; end: number; [key: string]: unknown }

/** An empty edit is not a negative identity verdict. Keep unresolved hypotheses visible for review. */
export function holdUnresolvedTopicRecall(plan: RecallPlan, windows: RecallWindow[]): RecallPlan {
    if (plan.clips.length) return plan;
    const unresolved = plan.hits.filter(hit => hit.recall?.requiresSemanticConfirmation && hit.verdict === 'uncertain');
    if (!unresolved.length) return plan;
    const clips = windows.flatMap(window => {
        const hits = unresolved.filter(hit => hit.start >= window.start && hit.end <= window.end);
        if (!hits.length) return [];
        const reason = hits.some(hit => hit.recall?.kind === 'meme_reference')
            ? '梗句与目标人物关联未确认，模型未给出事件选窗' : '疑似人名语义未确认，模型未给出事件选窗';
        return [{ ...window, status: 'needs_review', event: '', reason, score: 0, sourceKind: 'uncertain',
            issues: [reason], warnings: [], subtitleEdits: [], rejectedSubtitleEdits: [], subtitleSegments: [],
            copy: null, hits, hitIds: hits.map(hit => hit.id), sourceSha256: plan.sourceSha256 }];
    }).map((clip, index) => ({ ...clip, id: `${plan.groupId}-recall-${index + 1}` }));
    return { ...plan, clips };
}

/** High-ambiguity words have no global alias exemption, even after another hit is confirmed. */
export function topicRecallSubtitleEditSupport(edit: { original: string; replacement: string; evidenceCueIds: string[] },
    cue: SourceCue, input: { hits: Array<{ recall?: TopicRecallEvidence }>; target: { names: string[] } },
    inside: Set<string>, hits: AssessedHit[]): boolean | null {
    if (input.target.names.some(name => edit.replacement.includes(name)) && input.hits.some(hit => hit.recall?.kind === 'meme_reference'
        && hit.recall.meme?.cues.some(row => row.start === cue.start && row.end === cue.end))) return false;
    const forms = input.hits.filter(hit => hit.recall?.kind !== 'meme_reference')
        .flatMap(hit => hit.recall?.hypotheses.map(hypothesis => hypothesis.form) || []);
    if (!forms.some(form => form.toLowerCase() === edit.original.toLowerCase())
        || !input.target.names.includes(edit.replacement)) return null;
    return hits.some(hit => hit.cueId === cue.id && hit.verdict === 'mention'
        && hit.recall?.hypotheses.some(hypothesis => hypothesis.form.toLowerCase() === edit.original.toLowerCase()
            && hypothesis.startChar === cue.text.indexOf(edit.original))
        && edit.evidenceCueIds.includes(cue.id) && hit.evidenceCueIds.some(id => id !== cue.id
            && inside.has(id) && edit.evidenceCueIds.includes(id)));
}
