/** Curated phrase recall and evidence checks. No IO, subtitle replacement or publication authority. */
export interface MemeSegment { start: number; end: number; text: string; [key: string]: unknown }
export interface TopicMemeRule {
    id: string;
    keyword: string;
    forms: string[];
    targetNames?: string[];
    roomIds?: string[];
}
export interface TopicMemeConfig { enabled?: boolean; contextSeconds?: number; rules?: TopicMemeRule[] }
export interface TopicMemeEvidence {
    ruleId: string;
    keyword: string;
    targetNames: string[];
    phrase: string;
    contextSeconds: number;
    cues: Array<{ start: number; end: number; text: string }>;
}
interface Config {
    keywords: string[]; ignoredRoomIds?: string[];
    review?: { enabled?: boolean; mode?: string }; memeRecall?: TopicMemeConfig;
}
const normalized = (text: string): string => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
const validCue = (cue: MemeSegment): boolean => Number.isFinite(cue.start) && Number.isFinite(cue.end)
    && cue.start >= 0 && cue.end > cue.start && typeof cue.text === 'string';
const namesIn = (text: string, names: string[]): boolean => names.some(name => {
    const value = normalized(text), target = normalized(name);
    if (!/^[a-z0-9_]+$/u.test(target)) return value.includes(target);
    // Normalizing punctuation must not turn SUI inside SUICA into an identity reference.
    return text.normalize('NFKC').toLowerCase().split(/[^a-z0-9_]+/u).includes(target);
});
const attribution = /梗|标题|口癖|先用|学的|学了|学她|学他|模仿|说过|常说|前辈.{0,6}用|来自|出自/u;

export function findTopicMemeMatches(segments: MemeSegment[], config: Config, context: { roomId?: string | null } = {}) {
    const settings = config.memeRecall;
    if (!settings?.enabled || config.review?.enabled !== true || config.review.mode !== 'preflight'
        || config.ignoredRoomIds?.includes(String(context.roomId || ''))) return [];
    const keywords = new Set(config.keywords);
    const seconds = Number(settings.contextSeconds);
    const contextSeconds = Number.isFinite(seconds) ? Math.max(0, Math.min(120, seconds)) : 60;
    const rules = (settings.rules || []).filter(rule => keywords.has(rule.keyword)
        && (!rule.roomIds?.length || rule.roomIds.includes(String(context.roomId || '')))).map(rule => {
        if (!rule.id || !rule.keyword.trim() || !rule.forms?.length || rule.forms.some(form => typeof form !== 'string'
            || normalized(form).length < 5 || normalized(form).length > 40)) throw new Error('Invalid topic meme recall rule');
        const targetNames = [...new Set([rule.keyword, ...(rule.targetNames || [])])].filter(name => keywords.has(name));
        return { ...rule, targetNames, forms: rule.forms.map(form => ({ original: form, text: normalized(form) })) };
    });
    return segments.flatMap((segment, index) => {
        if (!validCue(segment)) return [];
        const span: MemeSegment[] = [];
        let text = '';
        // At most three adjacent rows / fifteen seconds. Never bridge a long pause or unrelated text.
        for (let offset = 0; offset < 3 && index + offset < segments.length; offset++) {
            const row = segments[index + offset], previous = span.at(-1);
            if (!validCue(row) || row.end - segment.start > 15
                || previous && (row.start < previous.start || row.start - previous.end > 1.5)) break;
            const before = text.length;
            span.push(row); text += normalized(row.text);
            for (const rule of rules) for (const form of rule.forms) {
                const startChar = text.indexOf(form.text);
                if (startChar < 0 || startChar >= normalized(segment.text).length
                    || startChar + form.text.length <= before) continue;
                const meme: TopicMemeEvidence = { ruleId: rule.id, keyword: rule.keyword, targetNames: rule.targetNames,
                    phrase: form.original, contextSeconds,
                    cues: span.map(cue => ({ start: cue.start, end: cue.end, text: cue.text })) };
                return [{ index, segment, matchedKeywords: [rule.keyword], recall: {
                    kind: 'meme_reference' as const, requiresSemanticConfirmation: true as const,
                    hypotheses: [{ ruleId: rule.id, keyword: rule.keyword, form: form.original,
                        startChar, endChar: startChar + form.text.length }], meme } }];
            }
        }
        return [];
    });
}

interface Cue { id: string; start: number; end: number; text: string }
interface Audience { id: string; time: number; text: string }
interface Hit {
    cueId: string; verdict: string; evidenceCueIds: string[]; evidenceDanmakuIds?: string[];
    recall?: { kind: string; meme?: TopicMemeEvidence };
}

/** Final review may need a cited, bounded attribution comment just beyond its normal context window. */
export function topicMemeAudienceContext(hits: Hit[], audience: Audience[]): Audience[] {
    return audience.filter(row => hits.some(hit => {
        const meme = hit.recall?.kind === 'meme_reference' ? hit.recall.meme : null;
        if (!meme?.cues.length || !hit.evidenceDanmakuIds?.includes(row.id)) return false;
        const seconds = Math.max(0, Math.min(120, meme.contextSeconds));
        return row.time >= meme.cues[0].start - seconds && row.time <= meme.cues.at(-1)!.end + seconds;
    }));
}

/** A curated phrase is a lead, never proof that the host named its associated person. */
export function topicMemeIdentityIssues(hits: Hit[], subtitles: Cue[], bounds: { start: number; end: number },
    audience: Audience[] = []): string[] {
    return hits.filter(hit => hit.recall?.kind === 'meme_reference' && hit.verdict !== 'false_match').flatMap(hit => {
        const label = `梗句线索 ${hit.cueId}`;
        if (hit.verdict !== 'mention') return [`${label} 与目标人物的关联尚未确认`];
        const meme = hit.recall?.meme;
        if (!meme?.cues.length || !meme.targetNames.length) return [`${label} 缺少原句来源`];
        const phraseCues = meme.cues.map(original => subtitles.find(cue => cue.start === original.start
            && cue.end === original.end && cue.text === original.text));
        if (phraseCues.some(cue => !cue || cue.start < bounds.start || cue.end > bounds.end
            || !hit.evidenceCueIds.includes(cue.id))) return [`${label} 未完整保留并引用原句`];
        const start = meme.cues[0].start, end = meme.cues.at(-1)!.end;
        const citedSpeech = subtitles.filter(cue => hit.evidenceCueIds.includes(cue.id)
            && !phraseCues.some(phrase => phrase?.id === cue.id) && cue.start >= bounds.start && cue.end <= bounds.end
            && cue.end >= start - meme.contextSeconds && cue.start <= end + meme.contextSeconds);
        const citedAudience = topicMemeAudienceContext([hit], audience);
        if (![...citedSpeech, ...citedAudience].some(row => namesIn(row.text, meme.targetNames) && attribution.test(row.text))) {
            return [`${label} 缺少明确点名并解释梗关联的独立字幕或弹幕依据`];
        }
        return [];
    });
}

export const MEME_REFERENCE_RULES = [
    'A hit with recall.kind=meme_reference is a curated PHRASE lead, not a misrecognized person name or a claim of exclusive authorship. Decide whether the retained speech is actually borrowing/discussing the target-related meme. Use mention only for a contextually confirmed reference; unrelated everyday usage or an unrelated username is false_match, and unresolved attribution is uncertain.',
    'For each confirmed meme reference, cite EVERY original phrase cue in evidenceCueIds AND independent nearby speech/audience explicitly naming the target and linking that phrase (for example 岁己前辈先用的). Supply audience citations in the hit evidenceDanmakuIds. Source names and the configured phrase catalogue alone are not proof. Repeated phrases without an independent link are insufficient.',
    'The complete phrase must remain IN the clip. An explicitly linked audience remark within recall.meme.contextSeconds may resolve its referent even just outside the final interval; that remark is context, not retained speech or permission to extend public claims. Clip-level evidenceDanmakuIds still cite only IN-CLIP audience claims. Never report that the host said the name when only chat named it, or assert who invented the meme.',
    'Meme phrases are real speech. NEVER replace a meme phrase or any part of it with the target name, insert an unspoken name, or use name-hinted ASR to confirm a name that was never spoken. Preserve its original words and source speaker uncertainty. Ordinary independent subtitle correction rules still apply.'
];
