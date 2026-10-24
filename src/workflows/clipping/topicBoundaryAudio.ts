import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { topicAudioSettings } from './topicAudio';
type Data = Record<string, any>;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fileHash = (file: string) => hash(fs.readFileSync(file));
const execute = promisify(execFile);

/** Only concrete unresolved boundary cues that the editor says require audio. Never rewrite subtitles. */
export function planBoundaryAudio(plan: Data, input: Data): Data[] {
    const ids = new Set<string>();
    for (const clip of plan.clips || []) {
        const boundary = clip.boundaryReview;
        if (clip.status !== 'needs_review' || !boundary?.unresolvedCueIds?.length
            || !/听音|原音|音频|识别不清|未辨清|听不清/u.test([clip.reason, boundary.endReason,
                boundary.startReason, ...(clip.warnings || [])].join(' '))) continue;
        for (const id of boundary.unresolvedCueIds) ids.add(id);
    }
    // Bound the merged audio windows, not the number of short subtitle rows.
    if (!ids.size) return [];
    const rows = [...ids].map(id => input.subtitles.find((cue: Data) => cue.id === id));
    if (rows.some(row => !row || !Number.isFinite(row.start) || !Number.isFinite(row.end)
        || row.start < 0 || row.end <= row.start || row.end - row.start > 30)) return [];
    const windows: Data[] = [];
    for (const cue of rows.sort((a, b) => a.start - b.start)) {
        const padding = Math.min(3, (30 - cue.end + cue.start) / 2);
        const start = Math.max(input.subtitles[0].start, cue.start - padding);
        const end = Math.min(input.subtitles.at(-1).end, cue.end + padding);
        const previous = windows.at(-1);
        if (previous && start <= previous.end && end - previous.start <= 30) {
            previous.end = Math.max(previous.end, end); previous.cueIds.push(cue.id);
        } else windows.push({ id: `A${windows.length + 1}`, start, end, cueIds: [cue.id] });
    }
    return windows.length <= 2 ? windows : [];
}

export interface BoundaryAudioIO { run(input: string, output: string): Promise<void>; now(): number }

/** An explicit final recheck can diagnose concrete keyword doubts without changing a subtitle word. */
export function keywordAudioPlan(artifact: Data, input: Data): Data | null {
    const attempt = artifact.finalKeywordAudioAttempt;
    const transientBusy = attempt?.status === 'unavailable' && (attempt.retryCount || 0) < 2
        && artifact.aiReview?.boundaryAudioChecks?.status === 'unavailable'
        && /another ASR resource lease is active/u.test(artifact.aiReview.boundaryAudioChecks.reason || '');
    if (artifact.publicationKind !== 'keyword_topic' || artifact.publicationReview?.status !== 'needs_review'
        || attempt && !transientBusy || !/关键词|名称|人名|称呼/u.test((artifact.publicationReview?.issues || []).join(' '))) return null;
    const hits = artifact.aiReview?.keyword?.hits || [];
    const ids = [...new Set(hits.filter((hit: Data) => hit.verdict === 'mention'
        && hit.start >= artifact.window.start && hit.end <= artifact.window.end)
        .map((hit: Data) => hit.cueId))];
    if (!ids.length || ids.length > 2 || ids.some(id => !input.subtitles.some((cue: Data) => cue.id === id))) return null;
    return { clips: [{ status: 'needs_review', reason: '关键词名称需要局部原音核验',
        boundaryReview: { unresolvedCueIds: ids } }] };
}

export async function diagnoseKeywordAudio(artifact: Data, input: Data, config: Data, source: Data,
    runtime: Data, injected?: BoundaryAudioIO): Promise<Data> {
    const plan = keywordAudioPlan(artifact, input);
    if (!plan) return artifact;
    const diagnostics = structuredClone(artifact.finalKeywordAudioDiagnostics || {});
    const audio = await prepareBoundaryAudio(plan, input, config, source, diagnostics, runtime, injected);
    return { ...artifact, finalKeywordAudioAttempt: { at: new Date().toISOString(), status: audio?.status || 'disabled',
        retryCount: artifact.finalKeywordAudioAttempt ? (artifact.finalKeywordAudioAttempt.retryCount || 0) + 1 : 0,
        method: 'unprompted_two_model_keyword_diagnosis' }, finalKeywordAudioDiagnostics: diagnostics,
        ...(audio ? { aiReview: { ...artifact.aiReview,
            boundaryAudioHistory: [...(artifact.aiReview?.boundaryAudioHistory || []),
                ...(artifact.aiReview?.boundaryAudioChecks ? [artifact.aiReview.boundaryAudioChecks] : [])],
            boundaryAudioChecks: audio } } : {}) };
}

/** Shares the existing per-recording audio budget and preserves hash-bound, unprompted two-model results. */
export async function prepareBoundaryAudio(plan: Data, input: Data, config: Data, source: Data,
    diagnostics: Data, runtime: Data, injected?: BoundaryAudioIO): Promise<Data | null> {
    const limits = topicAudioSettings(config.review?.audioChecks, input.target?.names || []);
    if (!limits.enabled) return null;
    const windows = planBoundaryAudio(plan, input);
    if (!windows.length) return null;
    const budget = diagnostics.topicAudioBudget ||= { windows: 0, audioSeconds: 0, elapsedMs: 0 };
    const seconds = windows.reduce((sum, row) => sum + row.end - row.start, 0);
    const held = (reason: string) => ({ version: 1, status: 'unavailable', reason, windows: [] });
    if (windows.length > limits.maxWindowsPerGroup || budget.windows + windows.length > limits.maxWindowsPerRecording
        || budget.audioSeconds + seconds > limits.maxAudioSecondsPerRecording
        || budget.elapsedMs >= limits.maxElapsedMsPerRecording) return held('局部原音核验预算已用尽');
    budget.windows += windows.length; budget.audioSeconds += seconds;
    const now = injected?.now || Date.now, started = now();
    const directory = path.join(source.selectionCacheDirectory || path.join(path.dirname(source.mediaPath), 'temp',
        path.basename(source.mediaPath), 'topic_selection'), 'boundary_audio', randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    const requestPath = path.join(directory, 'request.json'), outputPath = path.join(directory, 'audio.json');
    try {
        if (runtime.pathMap?.length) throw new Error('Boundary audio requires native Python');
        const stat = fs.statSync(source.mediaPath);
        const origin = { mediaPath: path.resolve(source.mediaPath), mediaBytes: stat.size, mediaMtimeMs: stat.mtimeMs,
            srtPath: path.resolve(source.srtPath), srtSha256: fileHash(source.srtPath) };
        const request: Data = { version: 1, source: origin, settings: { model: runtime.model,
            sensevoiceModel: runtime.sensevoiceModel, vadModel: runtime.vadModel, device: runtime.device, use_itn: false,
            resource_guard: runtime.resource_guard, gpu_throttle: runtime.gpu_throttle,
            ffmpeg: runtime.ffmpeg || 'ffmpeg', ffmpegThreads: runtime.ffmpegThreads || 2 },
            windows: windows.map(({ id, start, end }) => ({ id, start, end })) };
        request.requestSha256 = hash(JSON.stringify(request) + fileHash(runtime.scriptPath));
        fs.writeFileSync(requestPath, JSON.stringify(request), 'utf8');
        if (injected) await injected.run(requestPath, outputPath);
        else {
            const result = await execute(runtime.python.executable, [...runtime.python.args, runtime.scriptPath, requestPath, outputPath],
                { windowsHide: true, shell: false, timeout: Math.min(limits.timeoutMs, limits.maxElapsedMsPerRecording - budget.elapsedMs),
                    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } });
            fs.writeFileSync(path.join(directory, 'audio.log'), result.stdout + result.stderr, 'utf8');
        }
        const audio = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        if (audio.version !== 1 || audio.requestSha256 !== request.requestSha256
            || JSON.stringify(audio.source) !== JSON.stringify(origin) || !Array.isArray(audio.windows)
            || JSON.stringify(audio.windows.map(({ id, start, end }: Data) => ({ id, start, end }))) !== JSON.stringify(request.windows)) {
            throw new Error('Boundary audio source/windows changed');
        }
        for (const row of audio.windows) {
            if (path.dirname(path.resolve(row.audioPath)) !== directory || fileHash(row.audioPath) !== row.audioSha256
                || !Array.isArray(row.decodes) || row.decodes.length !== 2
                || JSON.stringify(row.decodes.map((d: Data) => d.model)) !== JSON.stringify([runtime.model, runtime.sensevoiceModel])
                || runtime.model === runtime.sensevoiceModel || row.decodes.some((d: Data) => d.prompted !== false
                    || !Array.isArray(d.hotwords) || d.hotwords.length || d.useItn !== false || typeof d.text !== 'string'
                    || d.text.length > 8000 || d.timingPrecision !== 'window')) throw new Error('Boundary audio evidence is invalid');
        }
        const after = fs.statSync(source.mediaPath);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || fileHash(source.srtPath) !== origin.srtSha256) {
            throw new Error('Source changed during boundary audio check');
        }
        return { version: 1, status: 'available', method: 'unprompted_two_model_boundary_diagnosis',
            windows: audio.windows.map((row: Data, index: number) => ({ ...row, cueIds: windows[index].cueIds })),
            evidence: { requestPath, requestSha256: fileHash(requestPath), outputPath, outputSha256: fileHash(outputPath) } };
    } catch (error) {
        const failure = error as Error & { stdout?: string; stderr?: string };
        fs.writeFileSync(path.join(directory, 'audio.log'), `${failure.stdout || ''}${failure.stderr || ''}\n${failure.message}`, 'utf8');
        return held(`局部原音核验未完成：${failure.message.slice(-500)}`);
    } finally { budget.elapsedMs += Math.max(0, now() - started); }
}
