import type { Artifact } from './enhancement';
type Data = Record<string, any>;
export type RepairCue = { start: number; end: number; text: string };
export const normalizedSpeech = (text: string) => text.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

export function subtitleRepairEligible(artifact: Artifact): boolean {
    const review = artifact.publicationReview;
    const details = (review?.issues || []).filter((issue: string) => !/^final_(?:subtitles|visuals)_not_passed$/u.test(issue));
    // Some reviewers classify the same visible transcription error under both checks.
    // This admits bounded audio diagnosis only; independent final review is still mandatory.
    const visualTranscriptionOnly = review?.checks?.visuals === false && details.length > 0
        && details.every((issue: string) => /字幕|原词|错识|识别/u.test(issue) && /[“「"][^”」"]+[”」"]/u.test(issue)
            && !/封面|遮挡|遮住|排版|出界|裁掉|重叠|错位|不同步|模糊|看不清/u.test(issue));
    const contentDetails = details.filter((issue: string) => issue !== 'final_content_not_passed');
    const contentTranscriptionOnly = review?.checks?.content === false && !!artifact.renderedSubtitles && contentDetails.length > 0
        && contentDetails.every((issue: string) => /字幕|原词|错识|识别/u.test(issue) && /[“「"][^”」"]+[”」"]/u.test(issue)
            && !/边界|结尾|起因|上下文|不完整|中断|断句|缺失|无关|删减/u.test(issue));
    return artifact.mode === 'own_stream_fun_review' && artifact.uploadReady === true && !artifact.editPlan
        && !artifact.creativePlan?.timeline && !artifact.selectionRejection && !artifact.rebuildRequired && !artifact.preRenderHold
        && !artifact.ownStreamHumanReview && !artifact.humanReview && !artifact.sourceExpansionRequest
        && (!artifact.renderedSubtitles || artifact.renderedSubtitles.revision === 0
            && Array.isArray(artifact.renderedSubtitles.edits) && artifact.renderedSubtitles.edits.length === 0)
        && !artifact.candidateSubtitles && !artifact.publicCopyPending
        && artifact.output.burnedSubtitles === true && !artifact.output.mediaError && !artifact.output.coverError
        && !artifact.subtitleProofreading?.reviewGroups?.length && review?.status === 'needs_review'
        && review.technical?.passed === true && review.checks?.subtitles === false
        && (review.checks.content === true || contentTranscriptionOnly)
        && ['attribution', 'policy'].every(key => review.checks[key] === true)
        && (review.checks.visuals === true || visualTranscriptionOnly);
}

/** Locate concrete quoted problems; a broad "bad subtitles" verdict never authorizes a whole-clip rewrite. */
export function planSubtitleProbes(artifact: Artifact, cues: RepairCue[], paddingSeconds = 5): Data[] {
    // In "current wording" versus "ASR/reference wording", the latter is a comparison, not a second suspect cue.
    const problems = String((artifact.publicationReview?.issues || []).join('\n')).replace(
        /([“「"][^”」"]{2,80}[”」"])与(?:后文)?[“「"][^”」"]{2,80}[”」"](?=[^。；\n]{0,20}不一致)/gu, '$1');
    const quotes = [...problems.matchAll(/[“「"]([^”」"]{2,80})[”」"]/gu)]
        .flatMap(match => cues.some(cue => cue.text.includes(match[1])) ? [match[1]] : match[1].split(/[\/／]/u))
        .filter(value => value.length >= 2 && !/^[a-z\s]+$/iu.test(value));
    const targets = new Map<number, string>();
    for (const quote of quotes.sort((a, b) => a.length - b.length)) {
        const matches = cues.map((cue, index) => ({ cue, index })).filter(row => row.cue.text.includes(quote));
        if (matches.length === 1 && !targets.has(matches[0].index)) targets.set(matches[0].index, quote);
    }
    if (!targets.size || targets.size > 4) return [];
    const probes = [...targets].map(([index, quote], order) => {
        const cue = cues[index], padding = Math.min(paddingSeconds, Math.max(0, (30 - (cue.end - cue.start)) / 2));
        const start = Math.max(artifact.window.start, artifact.window.start + cue.start - padding);
        const end = Math.min(artifact.window.end, artifact.window.start + cue.end + padding);
        const context = cues.filter(row => row.end > start - artifact.window.start && row.start < end - artifact.window.start)
            .map(row => row.text).join('');
        return { id: `A${order + 1}`, index, quote, start, end, original: cue.text, context };
    });
    return probes.some(row => row.end <= row.start || row.end - row.start > 30) ? [] : probes;
}

function uniqueIndex(text: string, quote: string): number {
    const index = text.indexOf(quote);
    return index >= 0 && text.indexOf(quote, index + 1) < 0 ? index : -1;
}
function inferredWord(text: string, original: string, before: string, after: string): string | null {
    const normalized = normalizedSpeech(text);
    const exact = before + original + after;
    if (uniqueIndex(normalized, exact) >= 0) return original;
    // A long, unique literal quote can confirm unchanged wording even if an adjacent word differs.
    if (original.length >= 6 && uniqueIndex(normalized, original) >= 0) return original;
    const candidates = new Set<string>();
    for (const length of [8, 6]) {
        const prefix = before.slice(-length), suffix = after.slice(0, length);
        if (prefix.length >= 6 && uniqueIndex(normalized, prefix) >= 0) {
            const index = normalized.indexOf(prefix) + prefix.length, value = normalized.slice(index, index + original.length);
            if (value.length === original.length && (after.length >= 2 && normalized.slice(index + value.length).startsWith(after.slice(0, 2))
                || !after && index + value.length === normalized.length)) candidates.add(value);
        }
        if (suffix.length >= 6 && uniqueIndex(normalized, suffix) >= 0) {
            const index = normalized.indexOf(suffix), value = normalized.slice(index - original.length, index);
            if (value.length === original.length && (before.length >= 2 && normalized.slice(0, index - value.length).endsWith(before.slice(-2))
                || !before && index - value.length === 0)) candidates.add(value);
        }
    }
    return candidates.size === 1 ? [...candidates][0] : null;
}

/** Two independent unprompted models must agree in a uniquely anchored source-audio window. */
export function consensusSubtitleEdit(probe: Data, row: Data, protectedNames: string[] = []): Data | null {
    if (row.id !== probe.id || row.start !== probe.start || row.end !== probe.end || !Array.isArray(row.decodes)
        || row.decodes.length !== 2 || new Set(row.decodes.map((decode: Data) => decode.model)).size !== 2
        || row.decodes.some((decode: Data) => decode.prompted !== false || decode.hotwords?.length || decode.useItn !== false
            || typeof decode.text !== 'string')) return null;
    const context = normalizedSpeech(probe.context), original = normalizedSpeech(probe.quote), position = uniqueIndex(context, original);
    if (position < 0) return null;
    const before = context.slice(Math.max(0, position - 8), position), after = context.slice(position + original.length, position + original.length + 8);
    const words = row.decodes.map((decode: Data) => inferredWord(decode.text, original, before, after));
    if (!words[0] || words[0] !== words[1]) return null;
    const replacement = words[0] as string;
    if (replacement === original) return { index: probe.index, from: probe.quote, to: probe.quote, confirmed: true, audioId: probe.id };
    const differences = [...original].flatMap((char, index) => char === [...replacement][index] ? [] : [char, [...replacement][index]]);
    if (differences.length > 4 || differences.some(char => /[0-9零〇一二三四五六七八九十百千万两不没无否别勿他她它你我爸妈姐哥弟妹]/u.test(char))
        || protectedNames.some(name => original.includes(normalizedSpeech(name)) || replacement.includes(normalizedSpeech(name)))) return null;
    // Punctuation is left byte-for-byte intact; only an exact literal suspect span is replaced.
    if (original.length !== probe.quote.length || !/^[\u3400-\u9fff]+$/u.test(replacement)) return null;
    return { index: probe.index, from: probe.quote, to: replacement, confirmed: true, audioId: probe.id };
}

export function applyConsensusEdits(cues: RepairCue[], edits: Data[]): RepairCue[] {
    return cues.map((cue, index) => {
        const edit = edits.find(row => row.index === index);
        if (!edit || edit.from === edit.to) return { ...cue };
        if (uniqueIndex(cue.text, edit.from) < 0) throw new Error('Subtitle correction does not uniquely match its original cue');
        return { ...cue, text: cue.text.replace(edit.from, edit.to) };
    });
}

/** Preserve original G IDs, grouping, voice rows and source hash; project only bound literal edits in memory. */
export function projectSubtitleRepairEvidence(evidence: Data, artifact: Artifact): Data {
    const edits: Data[] = artifact.automaticSubtitleRepair?.allEdits || artifact.automaticSubtitleRepair?.edits || [];
    if (!edits.length) return evidence;
    const matched = new Set<Data>();
    const cues = evidence.cues.map((cue: Data) => {
        const items = cue.items.map((item: Data) => {
            const local = edits.filter(row => Math.abs(Math.max(item.start, artifact.window.start) - row.sourceStart) <= .003
                && Math.abs(Math.min(item.end, artifact.window.end) - row.sourceEnd) <= .003);
            if (!local.length) return item;
            let text = item.text;
            for (const edit of local) {
                if (matched.has(edit) || uniqueIndex(text, edit.from) < 0) throw new Error('Source cue does not uniquely match local audio correction');
                matched.add(edit); text = text.replace(edit.from, edit.to);
            }
            return { ...item, text, automaticAudioCorrection: local.map(edit => ({ ...edit })) };
        });
        return items.every((item: Data, index: number) => item === cue.items[index]) ? cue
            : { ...cue, items, text: items.map((item: Data) => item.text.trim()).join(' ') };
    });
    if (matched.size !== edits.length) throw new Error('Local subtitle correction has no matching source cue');
    return { ...evidence, cues, byId: new Map(cues.map((cue: Data) => [cue.id, cue])) };
}
