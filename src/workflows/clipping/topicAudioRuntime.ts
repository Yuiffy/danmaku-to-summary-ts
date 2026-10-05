import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { planTopicAudio, topicAudioSettings, validateTopicAudio, TopicAudioBudget } from './topicAudio';
type Data = Record<string, any>;
const exec = promisify(execFile);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fileHash = (file: string) => hash(fs.readFileSync(file));
const write = (file: string, data: Data) => {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8'); fs.renameSync(tmp, file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
};
export interface TopicAudioIO { run(request: Data, inputPath: string, outputPath: string, timeoutMs: number): Promise<void>; now(): number }

/** All mutable budgets are scoped to one recording's diagnostics object. No queue writes. */
export async function prepareTopicAudio(input: Data, config: Data, source: Data, diagnostics: Data,
    runtime: Data, injected?: TopicAudioIO): Promise<Data | null> {
    const settings = topicAudioSettings(config.review?.audioChecks, input.target.names);
    if (!settings.enabled || !input.hits.some((h: Data) => h.recall?.requiresSemanticConfirmation)) return null;
    const budget: TopicAudioBudget = diagnostics.topicAudioBudget ||= { windows: 0, audioSeconds: 0, elapsedMs: 0 };
    const plan = planTopicAudio(input, settings, budget);
    const io = injected || { now: Date.now, run: async (_request: Data, inputPath: string, outputPath: string, timeoutMs: number) => {
        try {
            const completed = await exec(runtime.python.executable, [...runtime.python.args, runtime.scriptPath, inputPath, outputPath],
                { windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024,
                    env: { ...process.env, PYTHONUTF8: '1' } });
            fs.writeFileSync(`${inputPath}.log`, completed.stdout + completed.stderr, 'utf8');
        } catch (error) {
            const failure = error as Error & { stdout?: string; stderr?: string; code?: string; killed?: boolean };
            fs.writeFileSync(`${inputPath}.log`, (failure.stdout || '') + (failure.stderr || '') + '\n' + failure.message, 'utf8');
            throw new Error(failure.killed ? 'Topic audio process timed out' : `Topic audio process failed (${failure.code}): ${(failure.stderr || failure.message).slice(-700)}`);
        }
    } };
    const started = io.now();
    const result: Data = { version: 1, method: 'topic_audio_pair', windows: [], skipped: plan.skipped };
    if (!plan.windows.length) return result;
    try {
        if (!source.mediaPath || !source.srtPath) throw new Error('Source media/SRT path missing');
        if (!settings.hotwords.length) throw new Error('No configured canonical target hotwords');
        if (runtime.pathMap?.length) throw new Error('Topic audio requires a native Python runtime; path maps are not supported');
        const stat = fs.statSync(source.mediaPath);
        const identity = { mediaPath: path.resolve(source.mediaPath), mediaBytes: stat.size, mediaMtimeMs: stat.mtimeMs,
            srtPath: path.resolve(source.srtPath), srtSha256: fileHash(source.srtPath), evidenceSha256: input.sourceSha256 };
        const request: Data = { version: 1, source: identity, settings: { ...settings,
            model: runtime.model, vadModel: runtime.vadModel, device: runtime.device,
            resource_guard: runtime.resource_guard, gpu_throttle: runtime.gpu_throttle,
            ffmpeg: runtime.ffmpeg || 'ffmpeg', ffmpegThreads: runtime.ffmpegThreads || 2 }, windows: plan.windows };
        request.requestSha256 = hash(JSON.stringify({ request, implementation: [fileHash(runtime.scriptPath),
            fileHash(path.join(path.dirname(runtime.scriptPath), 'topic_audio_policy.py'))] }));
        const cacheDirectory = source.selectionCacheDirectory || path.join(path.dirname(source.mediaPath),
            'temp', path.basename(source.mediaPath), 'topic_selection');
        const directory = path.join(cacheDirectory, 'audio_checks', request.requestSha256);
        fs.mkdirSync(directory, { recursive: true });
        // Unique files keep concurrent attempts from overwriting one another. No automatic retry or cache reuse.
        const attempt = randomUUID();
        const inputPath = path.join(directory, `${attempt}.input.json`), outputPath = path.join(directory, `${attempt}.result.json`);
        write(inputPath, request);
        result.evidence = { inputPath, inputSha256: fileHash(inputPath), logPath: `${inputPath}.log` };
        const timeout = Math.min(settings.timeoutMs, settings.maxElapsedMsPerRecording - budget.elapsedMs);
        await io.run(request, inputPath, outputPath, timeout);
        const output = JSON.parse(fs.readFileSync(outputPath, 'utf8').replace(/^\uFEFF/u, ''));
        validateTopicAudio(output, request);
        const after = fs.statSync(source.mediaPath);
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || fileHash(source.srtPath) !== identity.srtSha256) {
            throw new Error('Source changed during topic audio check');
        }
        for (const row of output.windows) {
            const audioPath = path.resolve(row.audioPath || '');
            if (path.dirname(audioPath) !== directory || fileHash(audioPath) !== row.audioSha256) throw new Error('Extracted topic audio changed');
        }
        Object.assign(result, { ...output, skipped: plan.skipped, evidence: { inputPath, inputSha256: fileHash(inputPath),
            resultPath: outputPath, resultSha256: fileHash(outputPath) } });
    } catch (error) {
        const reason = error instanceof Error ? error.message.slice(-900) : String(error).slice(-900);
        result.skipped.push(...plan.windows.map((w: Data) => ({ hitIds: w.hitIds, status: 'unavailable', reason })));
    } finally { budget.elapsedMs += Math.max(0, io.now() - started); }
    return result;
}
