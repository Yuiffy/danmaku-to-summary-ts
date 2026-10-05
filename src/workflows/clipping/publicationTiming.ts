import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

type Data = Record<string, any>;
const read = (file: string): Data => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function sourceTimingMetadata(srtPath: string): { path: string; sha256: string } | null {
    const original = srtPath.replace(/\.speaker\.srt$/iu, '.srt');
    const file = path.join(path.dirname(original), path.basename(original, path.extname(original)) + '.asr_meta.json');
    if (!fs.existsSync(file)) return null;
    const metadata = read(file);
    if (metadata.backend === 'paraformer' && /sentence_info_fallback/u.test(metadata.speakerProcessing?.intervalSource || '')) {
        throw new Error('原字幕时间轴不可靠，需校准后重建视频');
    }
    return { path: path.resolve(file), sha256: digest(file) };
}

/** This receipt is written only after rendering the new source window. Changing text alone cannot pass. */
export function validateRenderedTimingRepair(artifact: Data): string | undefined {
    const repair = artifact.renderedTimingRepair;
    if (!repair) return;
    const rendered = repair.rendered, transcript = repair.transcript;
    if (repair.version !== 1 || artifact.rebuildRequired || !rendered || !transcript
        || rendered.window.start !== artifact.window.start || rendered.window.end !== artifact.window.end
        || rendered.video !== digest(artifact.output.mediaPath) || rendered.subtitles !== digest(artifact.output.srtPath)
        || path.resolve(artifact.source.srtPath) !== path.resolve(transcript.path)
        || transcript.mode !== 'repaired_source_audio' || transcript.sha256 !== digest(transcript.path)
        || transcript.originalSrtSha256 !== digest(transcript.originalSrtPath)
        || transcript.metadataSha256 !== digest(transcript.metadataPath)
        || transcript.evidenceSha256 !== digest(transcript.evidencePath)
        || transcript.speakerSha256 !== digest(transcript.speakerPath)) {
        throw new Error('时间轴修复尚未重建，或修复证据已变更');
    }
    const stat = fs.statSync(artifact.source.mediaPath, { bigint: true });
    if (path.resolve(repair.originalSource.mediaPath) !== path.resolve(artifact.source.mediaPath)
        || repair.originalSource.mediaBytes !== String(stat.size) || repair.originalSource.mediaMtimeNs !== String(stat.mtimeNs)) {
        throw new Error('时间轴修复的原录播已变更');
    }
    const audio = repair.finalAudio;
    const finalStat = fs.statSync(artifact.output.mediaPath);
    if (audio?.version !== 1 || audio.method !== 'unprompted_final_audio'
        || audio.source.mediaPath !== path.resolve(artifact.output.mediaPath) || audio.source.mediaBytes !== finalStat.size
        || Math.abs(audio.source.mediaMtimeMs - finalStat.mtimeMs) > .01
        || audio.source.srtPath !== path.resolve(artifact.output.srtPath) || audio.source.srtSha256 !== rendered.subtitles
        || digest(audio.requestPath) !== audio.requestSha256 || digest(audio.evidencePath) !== audio.evidenceSha256) {
        throw new Error('时间轴修复缺少新成片的独立原音复核');
    }
    const request = read(audio.requestPath), result = read(audio.evidencePath);
    if (result.requestSha256 !== request.requestSha256 || JSON.stringify(result.source) !== JSON.stringify(audio.source)
        || JSON.stringify(result.windows) !== JSON.stringify(audio.windows) || !audio.windows.length
        || audio.windows.some((row: Data) => digest(row.audioPath) !== row.audioSha256 || row.decodes?.length !== 2
            || new Set(row.decodes.map((decode: Data) => decode.model)).size !== 2
            || row.decodes.some((decode: Data) => decode.prompted !== false || decode.hotwords?.length || decode.useItn !== false))) {
        throw new Error('新成片的独立原音证据已变更');
    }
    return createHash('sha256').update(audio.requestSha256 + '\0' + audio.evidenceSha256).digest('hex');
}
