import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';
import { publicationSnapshot } from './publicationRuntime';
import { copyRepairEligible } from './ownPublicationRepair';
import { subtitleRepairEligible } from './ownSubtitleRepair';
import type { Artifact } from './enhancement';
import { randomUUID } from 'crypto';
import { publicationEnabled, subtitleAdvisoriesReviewable } from './publicationReview';
import type { PublicationConfig } from './publicationReview';

type Data = Record<string, any>;
interface RecheckAdapters {
    lock(file: string, id: number): { lock: number; lockPath: string };
    repair(artifact: Artifact, required: Data, subtitles: boolean): Promise<Artifact>;
    reviewFinal?(artifact: Artifact, required: Data): Promise<Artifact>;
    config(room: string, artifact: Artifact): Data;
}
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function finalReviewEligible(artifact: Artifact, config: PublicationConfig & Data): boolean {
    const kindMatches = config.policyVersion === 'topic-v1'
        ? artifact.mode === 'local_review' && artifact.publicationKind === 'keyword_topic' && artifact.automaticPublicationRequired === true
        : artifact.mode === 'own_stream_fun_review';
    return kindMatches && config.mode === 'auto' && publicationEnabled(config, artifact.roomId)
        && Boolean(config.authorizationNote?.trim()) && Number.isFinite(Date.parse(config.activatedAt))
        && Date.parse(artifact.generatedAt) >= Date.parse(config.activatedAt)
        && !artifact.selectionRejection && !artifact.preRenderHold && !artifact.rebuildRequired && !artifact.publicCopyPending
        && !artifact.ownStreamHumanReview && !artifact.humanReview && !artifact.sourceExpansionRequest && !artifact.storyRepairRequest
        && subtitleAdvisoriesReviewable(artifact) && !artifact.output?.mediaError && !artifact.output?.coverError
        && artifact.output?.burnedSubtitles === true && artifact.uploadReady === true;
}

function pendingRecord(registry: Data, queue: Data, id: number, file: string): Data {
    const record = registry.clips?.[String(id)];
    if (!record || record.id !== id || !record.metadataPath || !samePath(record.metadataPath, file)
        || !['needs_review', 'review'].includes(record.status) || record.bvid || record.aid || record.uploadState?.bvid
        || record.pendingCut || record.pendingRebuild || record.editorialExclusion
        || Object.values(queue.jobs || {}).some((job: any) => ['pending', 'running', 'retry_wait'].includes(job.status)
            && job.clipIds?.includes(id))) throw new Error('Recheck requires the same unpublished, inactive ordinary clip ID');
    return record;
}

/** Explicit maintenance entry; generic list refresh and policy activation never retry pending IDs. */
export async function recheckOwnPublication(argv: string[], io: RecheckAdapters): Promise<Data> {
    const { values } = parseArgs({ args: argv, options: { id: { type: 'string' }, metadata: { type: 'string' },
        'registry-path': { type: 'string' }, 'queue-path': { type: 'string' }, 'repair-subtitles': { type: 'boolean', default: false },
        'review-final': { type: 'boolean', default: false } } });
    const id = Number(values.id), file = path.resolve(String(values.metadata || ''));
    const registryPath = String(values['registry-path'] || ''), queuePath = String(values['queue-path'] || '');
    if (!Number.isSafeInteger(id) || id < 1 || !values.metadata || !registryPath || !queuePath) throw new Error('Numeric ID and registry, queue and metadata paths are required');
    if (values['repair-subtitles'] && values['review-final']) throw new Error('Choose subtitle repair or current-artifact final review');
    const record = pendingRecord(read(registryPath), read(queuePath), id, file);
    const { lock, lockPath } = io.lock(file, id);
    try {
        const before = fs.readFileSync(file, 'utf8'), artifact: Artifact = JSON.parse(before);
        if (!samePath(artifact.output.metadataPath, file) || artifact.uploadId && artifact.uploadId !== id) throw new Error('Metadata belongs to a different ID');
        const config = io.config(String(artifact.roomId), artifact).automaticPublication;
        const subtitles = values['repair-subtitles'] === true;
        const finalOnly = values['review-final'] === true;
        if (!(finalOnly ? finalReviewEligible(artifact, config) : subtitles ? subtitleRepairEligible(artifact) : copyRepairEligible(artifact, config))) return { id, status: 'needs_review', changed: false, reason: 'This artifact requires a different source or editorial repair' };
        const initial = await publicationSnapshot(artifact);
        const required = { attributionRequired: record.attributionRequired, qaRequired: record.qaRequired };
        if (finalOnly && !io.reviewFinal) throw new Error('Current-artifact final review adapter is unavailable');
        const result = finalOnly ? await io.reviewFinal!(artifact, required) : await io.repair(artifact, required, subtitles);
        if (result === artifact) return { id, status: 'needs_review', changed: false };
        if (!samePath(result.output.metadataPath, file) || result.uploadId && result.uploadId !== id
            || JSON.stringify(result.source) !== JSON.stringify(artifact.source) || JSON.stringify(result.window) !== JSON.stringify(artifact.window)
            || result.generatedAt !== artifact.generatedAt || result.ownStreamHumanReview || result.humanReview) {
            throw new Error('Automatic recheck changed numeric identity, source window or authority');
        }
        if ((artifact.attributionRequired || record.attributionRequired) && !result.attributionRequired
            || (artifact.qaRequired || record.qaRequired) && !result.qaRequired) throw new Error('Automatic recheck removed required review');
        if (finalOnly && JSON.stringify(initial) !== JSON.stringify(await publicationSnapshot(result))) {
            throw new Error('Current-artifact final review changed source, media or public copy');
        }
        pendingRecord(read(registryPath), read(queuePath), id, file);
        const current = await publicationSnapshot(artifact);
        if (fs.readFileSync(file, 'utf8') !== before || JSON.stringify(initial) !== JSON.stringify(current)) throw new Error('Existing artifact changed during recheck');
        const directory = path.join(path.dirname(file), 'temp', 'automatic-publication-rechecks', `${id}-${randomUUID()}`);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'BEFORE.json'), before, 'utf8');
        const temporary = `${file}.${randomUUID()}.tmp`;
        try { fs.writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', 'utf8'); fs.renameSync(temporary, file); }
        finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        return { id, status: result.publicationReview?.status, decision: result.publicationDecision?.action, changed: true,
            metadataPath: file, backupDirectory: directory };
    } finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
