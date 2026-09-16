import { spawn, execFile, SpawnOptions, ExecFileOptions } from 'child_process';

interface GpuUsage { gpuUtil: number; vramUsed: number; vramTotal: number }
const ASR_TIMING_SENTINEL = '[[ASR_TIMING]]';

export function runCommand(command: string, args: string[], options: SpawnOptions = {}) {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { ...options, windowsHide: true, shell: false, stdio: 'inherit' });
        child.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Command failed with exit code ${code}`));
            }
        });
        child.on('error', reject);
    });
}

export async function getVideoDuration(filePath: string) {
    return new Promise<number>((resolve, reject) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });

        let output = '';
        let error = '';

        ffprobe.stdout.on('data', (data) => {
            output += data.toString();
        });

        ffprobe.stderr.on('data', (data) => {
            error += data.toString();
        });

        ffprobe.on('close', (code) => {
            if (code === 0 && output.trim()) {
                const duration = parseFloat(output.trim());
                if (!isNaN(duration)) {
                    resolve(duration);
                } else {
                    reject(new Error(`Invalid duration: ${output}`));
                }
            } else {
                reject(new Error(`ffprobe failed: ${error || 'unknown error'}`));
            }
        });

        ffprobe.on('error', reject);
    });
}

export function logAsrTimings(timings: Record<string, unknown> | null | undefined, mediaDurationSeconds: number, speakerProcessing: unknown = null) {
    if (!timings || typeof timings !== 'object' || Object.keys(timings).length === 0) {
        return;
    }
    const seconds = (key: string) => Number(timings[key] || 0);
    const trueAsrSeconds = seconds('asr_inference_s');
    const trueAsrSpeed = trueAsrSeconds > 0 && mediaDurationSeconds > 0
        ? mediaDurationSeconds / trueAsrSeconds
        : null;
    const summary = {
        cacheHit: Boolean(Number(timings.model_cache_hit || 0)),
        modelLoadSeconds: seconds('model_load_s'),
        referenceEmbeddingSeconds: seconds('reference_embedding_s'),
        vadSeconds: seconds('vad_s'),
        transcriptionSeconds: trueAsrSeconds,
        punctuationSeconds: seconds('punc_s'),
        builtinSpeakerEmbeddingSeconds: seconds('builtin_speaker_embedding_s'),
        speakerClusterEmbeddingSeconds: seconds('speaker_cluster_embedding_s'),
        speakerModelLoadSeconds: seconds('speaker_model_load_s'),
        speakerProbeEmbeddingSeconds: seconds('speaker_probe_embedding_s'),
        speakerProbeClusteringSeconds: seconds('speaker_probe_clustering_s'),
        speakerFullEmbeddingSeconds: seconds('speaker_full_embedding_s'),
        speakerFullClusteringSeconds: seconds('speaker_full_clustering_s'),
        speakerMatchingSeconds: seconds('speaker_matching_s'),
        speakerTotalSeconds: seconds('speaker_total_s'),
        speakerProcessing: speakerProcessing || null,
        pipelineOverheadSeconds: seconds('pipeline_overhead_s'),
        postprocessSeconds: seconds('postprocess_s'),
        emotionModelLoadSeconds: seconds('emotion_model_load_s'),
        emotionInferenceSeconds: seconds('emotion_inference_s'),
        emotionTotalSeconds: seconds('emotion_total_s'),
        backendTotalSeconds: seconds('backend_total_s'),
        trueAsrSpeed: trueAsrSpeed === null ? null : Number(trueAsrSpeed.toFixed(2))
    };
    console.log(
        `⏱️  ASR阶段耗时: cache=${summary.cacheHit ? 'hit' : 'miss'}, ` +
        `加载=${summary.modelLoadSeconds.toFixed(1)}s, 参考embedding=${summary.referenceEmbeddingSeconds.toFixed(1)}s, ` +
        `VAD=${summary.vadSeconds.toFixed(1)}s, 真正转写=${summary.transcriptionSeconds.toFixed(1)}s` +
        `${summary.trueAsrSpeed ? ` (${summary.trueAsrSpeed.toFixed(1)}x)` : ''}, ` +
        `标点=${summary.punctuationSeconds.toFixed(1)}s, speaker探测=${(
            summary.speakerProbeEmbeddingSeconds + summary.speakerProbeClusteringSeconds
        ).toFixed(1)}s, speaker全量=${summary.speakerFullEmbeddingSeconds.toFixed(1)}s, ` +
        `speaker聚类=${summary.speakerFullClusteringSeconds.toFixed(1)}s, 匹配=${summary.speakerMatchingSeconds.toFixed(1)}s, ` +
        `pipeline其他=${summary.pipelineOverheadSeconds.toFixed(1)}s, 后处理=${summary.postprocessSeconds.toFixed(1)}s, ` +
        `情感加载=${summary.emotionModelLoadSeconds.toFixed(1)}s, 情感推理=${summary.emotionInferenceSeconds.toFixed(1)}s, ` +
        `情感总计=${summary.emotionTotalSeconds.toFixed(1)}s, ` +
        `backend总计=${summary.backendTotalSeconds.toFixed(1)}s`
    );
    console.log(`${ASR_TIMING_SENTINEL} ${JSON.stringify(summary)}`);
    return summary;
}

export async function getGpuUsage() {
    return new Promise<GpuUsage | null>((resolve) => {
        const child = spawn(
            'nvidia-smi',
            ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
            { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }
        );

        let stdout = '';
        child.stdout.on('data', (d) => { stdout += d.toString(); });

        child.on('close', (code) => {
            if (code !== 0) {
                resolve(null); // nvidia-smi 不可用
                return;
            }
            try {
                // 可能有多个 GPU，取第一个
                const line = stdout.trim().split('\n')[0];
                const parts = line.split(',').map(s => parseFloat(s.trim()));
                if (parts.length >= 3 && parts.every(n => !isNaN(n))) {
                    resolve({ gpuUtil: parts[0], vramUsed: parts[1], vramTotal: parts[2] });
                } else {
                    resolve(null);
                }
            } catch {
                resolve(null);
            }
        });

        child.on('error', () => resolve(null)); // nvidia-smi 不存在
    });
}

export function execFileAsync(command: string, args: string[], options: ExecFileOptions = {}) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile(command, args, { ...options, encoding: 'utf8', windowsHide: true, shell: false }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

export async function getRelevantProcessSnapshot() {
    try {
        const { stdout } = await execFileAsync('powershell', [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-Command',
            'Get-Process python,node,ffmpeg -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress'
        ]);
        const trimmed = stdout.trim();
        if (!trimmed) {
            return [];
        }

        const parsed = JSON.parse(trimmed);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return rows.map((row: { Id: number; ProcessName: string; Path?: string }) => `pid=${row.Id} name=${row.ProcessName} path=${row.Path || 'unknown'}`);
    } catch {
        return [];
    }
}

export async function getGpuProcessSnapshot() {
    try {
        const { stdout } = await execFileAsync('nvidia-smi', [
            '--query-compute-apps=pid,process_name,used_memory',
            '--format=csv,noheader,nounits'
        ]);
        return stdout
            .trim()
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

export async function logWhisperResourceSnapshot(stage: string) {
    const usage = await getGpuUsage();
    if (usage) {
        const vramPct = usage.vramTotal > 0 ? (usage.vramUsed / usage.vramTotal * 100) : 0;
        console.log(`📸 [Whisper资源快照:${stage}] GPU=${usage.gpuUtil.toFixed(0)}%, VRAM=${usage.vramUsed.toFixed(0)}/${usage.vramTotal.toFixed(0)}MB (${vramPct.toFixed(1)}%)`);
    } else {
        console.log(`📸 [Whisper资源快照:${stage}] GPU占用数据不可用`);
    }

    const gpuProcesses = await getGpuProcessSnapshot();
    if (gpuProcesses.length > 0) {
        console.log(`📸 [Whisper资源快照:${stage}] GPU进程: ${gpuProcesses.join(' | ')}`);
    } else {
        console.log(`📸 [Whisper资源快照:${stage}] GPU进程: 无或不可获取`);
    }

    const relevantProcesses = await getRelevantProcessSnapshot();
    if (relevantProcesses.length > 0) {
        console.log(`📸 [Whisper资源快照:${stage}] 相关进程: ${relevantProcesses.join(' | ')}`);
    } else {
        console.log(`📸 [Whisper资源快照:${stage}] 相关进程: 无`);
    }
}
