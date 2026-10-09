/** Bounded topic-audio decisions. No filesystem, model or provider calls. */
type Data = Record<string, any>;
export interface TopicAudioSettings {
    enabled: boolean; windowSeconds: number; maxWindowsPerGroup: number;
    maxWindowsPerRecording: number; maxAudioSecondsPerRecording: number; timeoutMs: number;
    maxElapsedMsPerRecording: number; hotwords: string[];
}
export interface TopicAudioBudget { windows: number; audioSeconds: number; elapsedMs: number }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
    finite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;

export function topicAudioSettings(raw: Data = {}, names: string[] = []): TopicAudioSettings {
    return { enabled: raw.enabled === true, windowSeconds: bounded(raw.windowSeconds, 30, 12, 30),
        maxWindowsPerGroup: bounded(raw.maxWindowsPerGroup, 3, 1, 4),
        maxWindowsPerRecording: bounded(raw.maxWindowsPerRecording, 6, 1, 12),
        maxAudioSecondsPerRecording: bounded(raw.maxAudioSecondsPerRecording, 180, 30, 360),
        timeoutMs: bounded(raw.timeoutMs, 180000, 10000, 300000),
        maxElapsedMsPerRecording: bounded(raw.maxElapsedMsPerRecording, 360000, 10000, 600000),
        hotwords: [...new Set((Array.isArray(raw.hotwords) ? raw.hotwords : ['岁己', '小岁'])
            .filter((s: unknown): s is string => typeof s === 'string' && names.includes(s) && s.length >= 2 && s.length <= 16))].slice(0, 8) };
}

export function planTopicAudio(input: Data, settings: TopicAudioSettings, budget: TopicAudioBudget): Data {
    const targets = input.hits.filter((h: Data) => h.recall?.requiresSemanticConfirmation === true);
    const windows: Data[] = [], skipped: Data[] = [];
    if (!settings.enabled || !targets.length) return { windows, skipped };
    for (const hit of targets) {
        const shared = windows.find(w => hit.start >= w.start && hit.end <= w.end);
        if (shared) { shared.hitIds.push(hit.id); continue; }
        const cue = input.subtitles.find((c: Data) => c.id === hit.cueId);
        const fail = (reason: string) => skipped.push({ hitIds: [hit.id], status: 'unavailable', reason });
        if (!cue || !finite(cue.start) || !finite(cue.end) || cue.start < 0 || cue.end <= cue.start
            || cue.end - cue.start > settings.windowSeconds) { fail('invalid_or_overlong_anchor'); continue; }
        const earliest = Math.max(0, Math.min(...input.subtitles.map((c: Data) => c.start)));
        const latest = Math.max(...input.subtitles.map((c: Data) => c.end));
        const start = Math.max(earliest, Math.min(cue.start - (settings.windowSeconds - cue.end + cue.start) / 2,
            latest - settings.windowSeconds));
        const end = Math.min(latest, start + settings.windowSeconds);
        if (windows.length >= settings.maxWindowsPerGroup || budget.windows >= settings.maxWindowsPerRecording
            || budget.audioSeconds + end - start > settings.maxAudioSecondsPerRecording
            || budget.elapsedMs >= settings.maxElapsedMsPerRecording) { fail('recording_audio_budget_exhausted'); continue; }
        // Ordinary context, separate from every suspected-name cue. Never a decoder prompt.
        const suspected = new Set(targets.map((h: Data) => h.cueId));
        const references = input.subtitles.filter((c: Data) => !suspected.has(c.id)
            && c.start >= start && c.end <= end).map((c: Data) => ({ id: c.id, start: c.start, end: c.end, text: c.text }));
        windows.push({ id: `A${windows.length + 1}`, hitIds: [hit.id], start, end, references });
        budget.windows += 1; budget.audioSeconds += end - start;
    }
    return { windows, skipped };
}

/** Validate cross-language provenance before any evidence enters an editor request. */
export function validateTopicAudio(value: Data, request: Data): void {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    if (value.version !== 1 || value.method !== 'topic_audio_pair' || value.requestSha256 !== request.requestSha256
        || !same(value.source, request.source) || !same(value.settings, request.settings)
        || !Array.isArray(value.windows) || value.windows.length !== request.windows.length) throw new Error('Topic audio binding mismatch');
    for (const [i, row] of value.windows.entries()) {
        const original = request.windows[i], duration = original.end - original.start;
        if (row.id !== original.id || row.start !== original.start || row.end !== original.end
            || !same(row.hitIds, original.hitIds) || !/^[a-f0-9]{64}$/u.test(row.audioSha256 || '')
            || !finite(row.duration) || Math.abs(row.duration - duration) > .1
            || !['aligned', 'mismatch', 'inconclusive', 'no_speech'].includes(row.status)
            || !Array.isArray(row.vad) || row.vad.some((r: number[]) => r.length !== 2
                || !finite(r[0]) || !finite(r[1]) || r[0] < 0 || r[1] <= r[0] || r[1] > duration + .1)
            || !Array.isArray(row.alignment?.matches)) throw new Error('Topic audio window is invalid');
        if (row.status === 'no_speech') {
            if (row.vad.length || row.unprompted || row.biased) throw new Error('Silence must bypass both decoders');
        } else if (!row.vad.length || typeof row.unprompted?.text !== 'string' || row.unprompted.text.length > 8000
            || row.unprompted.prompted !== false || row.unprompted.timingPrecision !== 'window'
            || !same(row.unprompted.hotwords, [])) throw new Error('Unprompted evidence contains decoder hints or lacks speech');
        if (row.status === 'aligned') {
            const matches = row.alignment.matches;
            if (matches.length < 2 || new Set(matches.map((r: Data) => r.cueId)).size < 2
                || matches.some((r: Data) => !original.references.some((c: Data) => c.id === r.cueId && c.text === r.sourceText)
                    || !finite(r.score) || r.score < .72 || r.score > 1)
                || typeof row.biased?.text !== 'string' || row.biased.text.length > 8000 || row.biased.prompted !== true
                || row.biased.timingPrecision !== 'window' || !same(row.biased.hotwords, request.settings.hotwords)) {
                throw new Error('Topic audio alignment or biased provenance is invalid');
            }
        } else if (row.biased) throw new Error('Unverified timeline must not run biased decoding');
    }
}

export function topicAudioHitIssue(hit: Data, checks?: Data): string | null {
    if (!hit.recall?.requiresSemanticConfirmation || !checks) return null;
    const rows = [...(checks.windows || []), ...(checks.skipped || [])].filter(r => r.hitIds.includes(hit.id));
    if (rows.length && rows.every(r => r.status === 'aligned')) return null;
    return `局部音频待核: ${hit.id} ${rows.map(r => r.status + (r.reason ? ` (${r.reason})` : '')).join('; ') || 'missing_audio_check'}`;
}

export function gateTopicAudioHits(hits: Data[], checks?: Data): Data[] {
    return hits.map(hit => {
        const issue = topicAudioHitIssue(hit, checks);
        return issue ? { ...hit, verdict: 'uncertain', audioIssue: issue, reason: `${hit.reason}; ${issue}` } : hit;
    });
}
