import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { Artifact } from './enhancement';
import type { PublicationSource } from './publicationReview';

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Inconclusive literal editing still yields useful bounded audio evidence, never an automatic word replacement. */
export function subtitleDiagnosticEvidence(artifact: Artifact, source: PublicationSource): { digest: string; windows: any[] } | undefined {
    const attempt = artifact.automaticSubtitleRepairAttempt;
    if (!attempt || artifact.automaticSubtitleRepair) return undefined;
    const file = attempt.evidencePath, requestFile = path.join(path.dirname(file), 'request.json');
    if (attempt.status !== 'inconclusive' || digest(file) !== attempt.evidenceSha256) throw new Error('Subtitle diagnostic evidence changed');
    const audio = read(file), request = read(requestFile), origin = request.source;
    if (audio.version !== 1 || audio.requestSha256 !== request.requestSha256 || JSON.stringify(audio.source) !== JSON.stringify(origin)
        || path.resolve(origin.mediaPath) !== source.mediaPath || String(origin.mediaBytes) !== source.mediaBytes
        || Math.abs(origin.mediaMtimeMs - Number(source.mediaMtimeNs) / 1e6) > .01
        || path.resolve(origin.srtPath) !== source.srtPath || origin.srtSha256 !== source.srtSha256
        || !Array.isArray(audio.windows) || !audio.windows.length || audio.windows.length > 4
        || JSON.stringify(audio.windows.map(({ id, start, end }: any) => ({ id, start, end }))) !== JSON.stringify(request.windows)) {
        throw new Error('Subtitle diagnostic source or windows changed');
    }
    let duration = 0;
    for (const row of audio.windows) {
        duration += row.end - row.start;
        if (!Number.isFinite(row.start) || !Number.isFinite(row.end) || row.start < artifact.window.start || row.end > artifact.window.end
            || row.end <= row.start || row.end - row.start > 30 || path.dirname(path.resolve(row.audioPath)) !== path.dirname(path.resolve(file))
            || digest(row.audioPath) !== row.audioSha256 || row.decodes?.length !== 2
            || JSON.stringify(row.decodes.map((decode: any) => decode.model)) !== JSON.stringify([request.settings.model, request.settings.sensevoiceModel])
            || new Set(row.decodes.map((decode: any) => decode.model)).size !== 2
            || row.decodes.some((decode: any) => decode.prompted !== false || decode.hotwords?.length || decode.useItn !== false || typeof decode.text !== 'string')) {
            throw new Error('Subtitle diagnostic audio changed');
        }
    }
    if (duration > 120) throw new Error('Subtitle diagnostic budget exceeded');
    return { digest: createHash('sha256').update(attempt.evidenceSha256 + '\0' + digest(requestFile)).digest('hex'), windows: audio.windows };
}

/** The final review and upload worker must bind the same local audio proof, not just an editable metadata claim. */
export function subtitleRepairEvidenceDigest(artifact: Artifact, source: PublicationSource, depth = 0): string | undefined {
    const repair = artifact.automaticSubtitleRepair;
    if (!repair) return undefined;
    if (depth > 1) throw new Error('Local subtitle audio repair exceeds its probe budget');
    const { proofPath, proofSha256, resultIdentity: _resultIdentity, ...binding } = repair;
    if (repair.version !== 1 || repair.authority !== 'automatic' || repair.method !== 'unprompted_two_model_consensus'
        || !proofPath || digest(proofPath) !== proofSha256 || JSON.stringify(read(proofPath)) !== JSON.stringify(binding)
        || JSON.stringify(source) !== JSON.stringify(repair.source)
        || digest(repair.requestPath) !== repair.requestSha256 || digest(repair.evidencePath) !== repair.evidenceSha256
        || digest(repair.correctedSrtPath) !== repair.correctedSrtSha256) throw new Error('Local subtitle audio proof changed');
    const audio = read(repair.evidencePath), request = read(repair.requestPath);
    if (repair.previousRepair) subtitleRepairEvidenceDigest({ ...artifact, automaticSubtitleRepair: repair.previousRepair,
        output: { ...artifact.output, srtPath: repair.previousRepair.correctedSrtPath } }, source, depth + 1);
    if (audio.requestSha256 !== request.requestSha256 || JSON.stringify(audio.source) !== JSON.stringify(request.source)
        || JSON.stringify(audio.windows) !== JSON.stringify(repair.checks) || !Array.isArray(repair.edits)
        || !repair.edits.length || repair.edits.length > 4) throw new Error('Local subtitle audio checks differ from their proof');
    for (const row of repair.checks) {
        if (digest(row.audioPath) !== row.audioSha256 || row.decodes?.length !== 2
            || new Set(row.decodes.map((decode: any) => decode.model)).size !== 2
            || row.decodes.some((decode: any) => decode.prompted !== false || decode.hotwords?.length || decode.useItn !== false)) {
            throw new Error('Local subtitle audio model evidence changed');
        }
    }
    if (repair.edits.some((edit: any) => edit.from !== edit.to)
        && digest(artifact.output.srtPath) !== repair.correctedSrtSha256) throw new Error('Rendered subtitles differ from local audio correction');
    return proofSha256;
}
