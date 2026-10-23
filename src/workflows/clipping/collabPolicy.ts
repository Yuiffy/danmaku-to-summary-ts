import { Cue } from './editorialStyle';

export type Rect = [number, number, number, number];
export interface Span { start: number; end: number }
export interface SyncWindow {
    primary: Span;
    local: Span;
    basis: 'shared_game' | 'shared_audio' | 'manual';
    reviewNote: string;
}
export interface CollabSource {
    id: string;
    name: string;
    roomId: string;
    mediaPath: string;
    srtPath?: string;
    xmlPath?: string;
    sync: SyncWindow[];
    protectedRegions: Rect[];
}
export interface CollabSession { version: 1; primaryId: string; sources: CollabSource[] }
export interface MediaInfo { width: number; height: number; duration: number; audio: boolean }
export interface EvidenceRow extends Span {
    id: string; sourceId: string; kind: 'subtitle' | 'danmaku'; text: string;
    primaryStart: number | null; primaryEnd: number | null;
}
export interface CollabOverlay extends Span {
    sourceId: string; kind: 'face' | 'chat'; crop: Rect; placement: Rect; reviewNote: string;
}
export interface CollabShot extends Span {
    mode: 'primary' | 'solo'; sourceId: string; reason: string; evidenceIds: string[];
    overlays: CollabOverlay[];
}
export interface CollabPlan { version: 1; dossierSha256: string; shots: CollabShot[] }
export interface MappedOverlay extends CollabOverlay { local: Span; rate: number }
export interface CompiledShot extends CollabShot { outputStart: number; mappedOverlays: MappedOverlay[] }
export interface CollabTimeline { shots: CompiledShot[]; duration: number; cues: Cue[] }

export function assertSpan(span: Span, maximum = Infinity): void {
    if (!span || !Number.isFinite(span.start) || !Number.isFinite(span.end)
        || span.start < 0 || span.end <= span.start || span.end > maximum + .001) throw new Error('Invalid time span');
}
export function assertRect(rect: Rect): void {
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)
        || rect[0] < 0 || rect[1] < 0 || rect[2] <= 0 || rect[3] <= 0
        || rect[0] + rect[2] > 1.000001 || rect[1] + rect[3] > 1.000001) throw new Error('Invalid normalized rectangle');
}
function overlaps(a: Rect, b: Rect): boolean {
    return a[0] < b[0] + b[2] - .000001 && b[0] < a[0] + a[2] - .000001
        && a[1] < b[1] + b[3] - .000001 && b[1] < a[1] + a[3] - .000001;
}
export function validateSession(session: CollabSession, media: Record<string, MediaInfo>): void {
    if (session.version !== 1 || !Array.isArray(session.sources) || session.sources.length < 2
        || session.sources.length > 16) throw new Error('A session needs 2–16 recording segments');
    const ids = new Set<string>();
    const primary = media[session.primaryId];
    if (!primary) throw new Error('Primary source missing');
    for (const source of session.sources) {
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(source.id) || ids.has(source.id)
            || !source.name?.trim() || !/^\d+$/.test(source.roomId) || !source.mediaPath) throw new Error('Invalid or duplicate source identity');
        ids.add(source.id);
        const info = media[source.id];
        if (!info || ![info.duration, info.width, info.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('Invalid source media');
        if (!Array.isArray(source.protectedRegions) || !Array.isArray(source.sync)) throw new Error('Source needs sync and protectedRegions arrays');
        source.protectedRegions.forEach(assertRect);
        if (source.id === session.primaryId && (source.sync.length || !info.audio)) throw new Error('Primary needs original audio and an identity clock');
        let priorPrimary = -1, priorLocal = -1;
        for (const window of source.sync) {
            assertSpan(window.primary, primary.duration); assertSpan(window.local, info.duration);
            const rate = (window.local.end - window.local.start) / (window.primary.end - window.primary.start);
            if (window.primary.start < priorPrimary || window.local.start < priorLocal || Math.abs(rate - 1) > .01
                || !['shared_game', 'shared_audio', 'manual'].includes(window.basis) || !window.reviewNote?.trim())
                throw new Error('Sync windows need ordered reviewed anchors, no overlap and <=1% drift');
            priorPrimary = window.primary.end; priorLocal = window.local.end;
        }
    }
    if (!ids.has(session.primaryId)) throw new Error('Primary source missing');
}

/** No extrapolation through unverified time, reconnects, ad breaks or missing media. */
export function mapPrimary(source: CollabSource, span: Span): { local: Span; rate: number } {
    const w = source.sync.find(w => span.start >= w.primary.start && span.end <= w.primary.end);
    if (!w) throw new Error(`Unverified sync coverage for ${source.id}; split at gaps/anchors`);
    const rate = (w.local.end - w.local.start) / (w.primary.end - w.primary.start);
    return { local: { start: w.local.start + (span.start - w.primary.start) * rate,
        end: w.local.start + (span.end - w.primary.start) * rate }, rate };
}
export function mapLocal(source: CollabSource, span: Span, primaryId: string): Span | null {
    if (source.id === primaryId) return span;
    const w = source.sync.find(w => span.start >= w.local.start && span.end <= w.local.end);
    if (!w) return null;
    const rate = (w.primary.end - w.primary.start) / (w.local.end - w.local.start);
    return { start: w.primary.start + (span.start - w.local.start) * rate,
        end: w.primary.start + (span.end - w.local.start) * rate };
}

export function compileCollab(session: CollabSession, plan: CollabPlan, media: Record<string, MediaInfo>,
    subtitles: Record<string, Cue[]>, evidence: EvidenceRow[]): CollabTimeline {
    validateSession(session, media);
    if (plan.version !== 1 || !Array.isArray(plan.shots) || !plan.shots.length || plan.shots.length > 500)
        throw new Error('Plan needs 1–500 shots');
    const sources = Object.fromEntries(session.sources.map(s => [s.id, s]));
    const rows = new Map(evidence.map(row => [row.id, row]));
    const shots: CompiledShot[] = [], cues: Cue[] = [];
    let cursor = 0, prior = -1;
    for (const shot of plan.shots) {
        const source = sources[shot.sourceId], info = media[shot.sourceId];
        if (!source || !info?.audio || !shot.reason?.trim() || !Array.isArray(shot.overlays)
            || !['primary', 'solo'].includes(shot.mode) || shot.mode === 'primary' && shot.sourceId !== session.primaryId
            || shot.mode === 'solo' && shot.sourceId === session.primaryId) throw new Error('Invalid shot/audio source');
        assertSpan(shot, info.duration);
        if (shot.mode === 'primary') {
            if (shot.start < prior) throw new Error('Primary story must stay chronological without duplicate spans');
            prior = shot.end;
        } else if (shot.overlays.length) throw new Error('Solo cutaways use their own clock and audio; overlays require the primary clock');
        if (!Array.isArray(shot.evidenceIds) || !shot.evidenceIds.length || shot.evidenceIds.some(id => {
            const row = rows.get(id);
            return !row || (row.sourceId === shot.sourceId ? row.end <= shot.start || row.start >= shot.end
                : shot.mode !== 'primary' || row.primaryStart === null || row.primaryEnd === null
                || row.primaryEnd <= shot.start || row.primaryStart >= shot.end);
        })) throw new Error('Shot needs real, overlapping source evidence IDs');
        const speech = subtitles[shot.sourceId] || [];
        if (speech.some(c => c.start < shot.start - .04 && c.end > shot.start + .04
            || c.start < shot.end - .04 && c.end > shot.end + .04)) throw new Error('Shot boundary splits a subtitle sentence');
        cues.push(...speech.filter(c => c.end > shot.start && c.start < shot.end).map(c => ({ text: c.text,
            start: cursor + Math.max(c.start, shot.start) - shot.start, end: cursor + Math.min(c.end, shot.end) - shot.start })));
        const mappedOverlays: MappedOverlay[] = [];
        if (shot.overlays.length > 12) throw new Error('At most 12 inserts per shot');
        for (const overlay of shot.overlays) {
            const peer = sources[overlay.sourceId];
            assertSpan(overlay, shot.end); assertRect(overlay.crop); assertRect(overlay.placement);
            if (!peer || peer.id === session.primaryId || overlay.start < shot.start || !overlay.reviewNote?.trim()
                || !['face', 'chat'].includes(overlay.kind)) throw new Error('Invalid reviewed peer inset');
            // Always reserve the normal large-subtitle band, even when exporting external SRT.
            if ([...source.protectedRegions, [0, .7, 1, .3] as Rect].some(r => overlaps(r, overlay.placement)))
                throw new Error('Inset covers protected gameplay/HUD/subtitles');
            if (mappedOverlays.some(o => o.end > overlay.start && o.start < overlay.end && overlaps(o.placement, overlay.placement)))
                throw new Error('Simultaneous insets overlap');
            mappedOverlays.push({ ...overlay, ...mapPrimary(peer, overlay) });
        }
        shots.push({ ...shot, outputStart: cursor, mappedOverlays }); cursor += shot.end - shot.start;
    }
    return { shots, cues, duration: cursor };
}
