import { AudioEvidence, Span, Subtitle, planFromEvidenceIds } from './editPlan';

export interface PacingSettings {
    noiseDb?: number; minRemovedSeconds?: number; minRemovedRatio?: number;
    maxRemovedRatio?: number; maxPausesPerClip?: number; maxScannedSeconds?: number;
}
export function pacingSettings(raw: PacingSettings = {}) {
    const settings = { noiseDb: -40, minRemovedSeconds: 3, minRemovedRatio: .02,
        maxRemovedRatio: .2, maxPausesPerClip: 2, maxScannedSeconds: 120 };
    for (const key of Object.keys(settings) as Array<keyof typeof settings>) if (raw[key] !== undefined) settings[key] = raw[key]!;
    if (settings.noiseDb < -80 || settings.noiseDb > -35 || settings.minRemovedSeconds < 3
        || settings.minRemovedRatio < 0 || settings.minRemovedRatio > .2 || settings.maxRemovedRatio > .4
        || settings.maxRemovedRatio < settings.minRemovedRatio || !Number.isInteger(settings.maxPausesPerClip)
        || settings.maxPausesPerClip < 1 || settings.maxPausesPerClip > 2 || settings.maxScannedSeconds < 1
        || settings.maxScannedSeconds > 600 || Object.values(settings).some(value => !Number.isFinite(value))) throw new Error('Invalid precision pacing settings');
    return settings;
}
export function protectedPauseWindows(speech: Subtitle[], window: Span, minimum = 3.6): Span[] {
    const rows = speech.filter(row => row.end > window.start && row.start < window.end);
    if (!rows.length || rows.some(row => !Number.isFinite(row.asrEvidence?.sourceSpan?.start)
        || !Number.isFinite(row.asrEvidence?.sourceSpan?.end) || row.asrEvidence.sourceSpan.end <= row.asrEvidence.sourceSpan.start)) return [];
    const spans = rows.flatMap(row => [row, row.asrEvidence.sourceSpan]).sort((a, b) => a.start - b.start);
    const gaps: Span[] = []; let end = window.start;
    for (const span of spans) {
        const start = Math.max(window.start, end + .2), next = Math.min(window.end, span.start - .2);
        if (next - start >= minimum) gaps.push({ start, end: next });
        end = Math.max(end, span.end);
    }
    // Keep both opening and closing boundaries, including a trailing silent reaction.
    return gaps.filter(span => span.start > window.start && span.end < window.end);
}
export function detectQuietPcm(pcm: Buffer, sourceStart: number, sourceId: string, raw: PacingSettings = {}): AudioEvidence[] {
    const settings = pacingSettings(raw), rate = 16000, channels = 2, step = 160;
    if (pcm.length % 4 || !pcm.length || !Number.isFinite(sourceStart) || sourceStart < 0) throw new Error('Invalid PCM evidence');
    const frames = pcm.length / 4, limit = 32767 * 10 ** (settings.noiseDb / 20);
    const result: AudioEvidence[] = []; let quietStart: number | null = null;
    const close = (frame: number) => {
        if (quietStart !== null && (frame - quietStart) / rate >= settings.minRemovedSeconds + .6) result.push({
            id: `pause-${Math.round((sourceStart + quietStart / rate) * 1000)}`, sourceId, kind: 'silence', verified: true,
            precisionSeconds: .01, start: sourceStart + quietStart / rate, end: sourceStart + frame / rate });
        quietStart = null;
    };
    for (let frame = 0; frame < frames; frame += step) {
        const end = Math.min(frames, frame + step); let quiet = true;
        for (let sample = frame * channels; sample < end * channels; sample++) {
            if (Math.abs(pcm.readInt16LE(sample * 2)) > limit) { quiet = false; break; }
        }
        if (quiet && quietStart === null) quietStart = frame;
        if (!quiet) close(frame);
    }
    close(frames);
    return result;
}
export function usefulPauseEvidence(events: AudioEvidence[], sourceId: string, window: Span, speech: Subtitle[], raw: PacingSettings = {}) {
    const settings = pacingSettings(raw), picked: AudioEvidence[] = [];
    for (const event of [...events].sort((a, b) => b.end - b.start - (a.end - a.start))) {
        try {
            const next = [...picked, event];
            const plan = planFromEvidenceIds(sourceId, window, next.map(row => row.id), speech, next);
            const removed = plan.removed.reduce((n, row) => n + row.end - row.start, 0);
            if (removed / (window.end - window.start) <= settings.maxRemovedRatio) picked.push(event);
        } catch { /* Ambiguous or stale timing stays intact. */ }
        if (picked.length >= settings.maxPausesPerClip) break;
    }
    const seconds = picked.reduce((n, row) => n + row.end - row.start - .6, 0);
    return seconds >= settings.minRemovedSeconds && seconds / (window.end - window.start) >= settings.minRemovedRatio ? picked : [];
}
