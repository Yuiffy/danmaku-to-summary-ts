import * as fs from 'fs';
import { createHash } from 'crypto';
import type { Artifact } from './enhancement';
import type { PublicationSource } from './publicationReview';

const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const digest = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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
