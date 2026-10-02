'use strict';
const fs = require('fs');
const path = require('path');
const asr = require('../asr/asr_backends');
const { runFfmpeg, resolveFfprobePath } = require('./media_runtime');
const { probeMediaDuration } = require('./video_probe');
const { fileDigest } = require('./source_snapshot');
const { writeJsonAtomic } = require('./candidate_subtitles');
const { sha } = require('./stream_activity_plan');

function timingRepairReason(metadata) {
    return metadata?.backend === 'paraformer' && /sentence_info_fallback/u.test(metadata.speakerProcessing?.intervalSource || '')
        ? 'paraformer_sentence_info_alignment_fallback' : null;
}
function repairConfig(root) {
    const backend = asr.getAsrConfig(root).paraformer;
    return { ...root, asr: { ...root.asr, paraformer: { ...backend,
        model: backend.base_model || 'paraformer-zh', model_profile: 'default', finetuned_model: null,
        enable_speaker: false, emotion_analysis: { ...backend.emotion_analysis, enabled: false },
        gpu_throttle: { ...backend.gpu_throttle, enabled: true, segment_paraformer: true },
        merge_length_s: 8, max_vad_segment_s: 8, batch_size_s: 60 } } };
}
async function prepareActivityTranscript({ source, root, directory, duration, transcribe, extract, probe, reuseOnly = false }) {
    const metadataPath = source.srtPath.replace(/\.srt$/iu, '.asr_meta.json');
    const metadata = fs.existsSync(metadataPath) ? JSON.parse(fs.readFileSync(metadataPath, 'utf8')) : null;
    const reason = timingRepairReason(metadata);
    if (!reason) return { path: source.srtPath, sha256: source.srtSha256, mode: 'source_srt' };
    const settings = repairConfig(root);
    const key = sha({ version: 1, source, reason, metadataSha256: fileDigest(metadataPath),
        model: settings.asr.paraformer.model, chunkSeconds: 8 });
    const folder = path.join(directory, 'temp', 'transcript-timing', key.slice(0, 16));
    const srtPath = path.join(folder, 'ALIGNED.srt'), recordPath = path.join(folder, 'RESULT.json');
    if (fs.existsSync(recordPath)) {
        const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
        if (record.key === key && fs.existsSync(srtPath) && fileDigest(srtPath) === record.sha256) return record;
    }
    if (reuseOnly) return { path: source.srtPath, sha256: source.srtSha256, mode: 'source_srt', timingReliable: false, reason };
    fs.mkdirSync(folder, { recursive: true });
    const audioPath = path.join(folder, 'SOURCE.wav');
    console.log(`[activity] ${reason}: 从原音频重建临时转写，保留原 SRT`);
    const ffmpegPath = root.audio?.ffmpeg?.path || 'ffmpeg';
    await (extract || runFfmpeg)(['-y', '-i', source.mediaPath, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000',
        '-c:a', 'pcm_s16le', audioPath], { ffmpegPath, stage: '活动转写时间轴修复', timeoutMs: 900000 });
    const audioDuration = await (probe || probeMediaDuration)(audioPath, resolveFfprobePath(ffmpegPath));
    if (Math.abs(audioDuration - duration) > .25) throw new Error('Decoded activity audio timeline differs from the recording; cannot repair by guessing an offset');
    const result = await (transcribe || asr.transcribeParaformer)(audioPath, settings, {
        resolvedBackend: { backend: 'paraformer', reason: 'activity_transcript_timing_repair' } });
    const segments = asr.normalizeAsrResult(result).segments;
    if (!segments.length || segments.some(s => s.start < 0 || s.end > duration + .25)) throw new Error('Activity transcript timing repair returned invalid coverage');
    asr.writeSrt({ ...result, segments }, srtPath, { ...asr.getSubtitleConfig(root), proofreading: { enabled: false }, corrections: {} });
    const record = { version: 1, key, path: srtPath, sha256: fileDigest(srtPath), mode: 'repaired_source_audio',
        reason, originalSrtPath: source.srtPath, originalSrtSha256: source.srtSha256,
        metadataPath, metadataSha256: fileDigest(metadataPath), backend: result.backend, audioDuration, segments: segments.length };
    writeJsonAtomic(recordPath, record);
    // The source and repaired transcript provide reproducible review evidence; the PCM is disposable.
    fs.unlinkSync(audioPath);
    return record;
}
module.exports = { timingRepairReason, repairConfig, prepareActivityTranscript };
