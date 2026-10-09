import { createHash } from 'crypto';
import type { Artifact } from './enhancement';
import type { PublicationSnapshot, PublicationConfig } from './publicationReview';
import { publicationEnabled } from './publicationReview';
import { ownAutomaticReviewEligible } from './ownRequiredReview';

type Data = Record<string, any>;
export interface CopyRepairIO {
    snapshot(artifact: Artifact): Promise<PublicationSnapshot>;
    reviewCopy(artifact: Artifact, issues: string[]): Promise<Artifact>;
    renderCover(artifact: Artifact, options?: { textPosition: 'bottom' }): Promise<string>;
    reviewFinal(artifact: Artifact): Promise<Artifact>;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const identity = (artifact: Artifact, snapshot: PublicationSnapshot) => createHash('sha256')
    .update(JSON.stringify({ window: artifact.window, source: snapshot.source, digests: snapshot.digests })).digest('hex');

/** Missing/stale prerequisite reviews are rerun; their required flags remain intact. */
export function prerequisiteRepairEligible(artifact: Artifact, config: PublicationConfig & Data): boolean {
    const issues = artifact.publicationReview?.issues;
    return ownAutomaticReviewEligible(artifact, config)
        && (artifact.uploadReady === true && !artifact.publicCopyPending
            || artifact.publicCopyPending === true && artifact.attributionRequired === true)
        && artifact.publicationReview?.status === 'needs_review' && Array.isArray(issues) && issues.length > 0
        && issues.every((issue: string) => /^(?:publicCopyPending|artifact_not_upload_ready|attribution_(?:not_passed|evidence_stale)|required_qa_(?:not_passed|evidence_stale))$/u.test(issue))
        && issues.some((issue: string) => /^(?:attribution_|required_qa_)/u.test(issue));
}

/** Copy defects may be categorized as content, attribution or cover visuals; subtitle, policy and boundary failures still block. */
export function copyRepairEligible(artifact: Artifact, config: PublicationConfig & Data): boolean {
    if (prerequisiteRepairEligible(artifact, config)) return true;
    const review = artifact.publicationReview;
    return artifact.mode === 'own_stream_fun_review' && config.mode === 'auto' && publicationEnabled(config, artifact.roomId)
        && Boolean(config.authorizationNote?.trim()) && Number.isFinite(Date.parse(config.activatedAt))
        && Date.parse(artifact.generatedAt) >= Date.parse(config.activatedAt)
        && !artifact.selectionRejection && !artifact.preRenderHold && !artifact.rebuildRequired && !artifact.publicCopyPending
        && !artifact.ownStreamHumanReview && !artifact.humanReview && !artifact.sourceExpansionRequest && !artifact.storyRepairRequest
        && !artifact.subtitleProofreading?.reviewGroups?.length && !artifact.output?.mediaError && !artifact.output?.coverError
        && artifact.output?.burnedSubtitles === true && artifact.uploadReady === true
        && review?.status === 'needs_review' && review.technical?.passed === true
        && ['subtitles', 'policy'].every(key => review.checks[key] === true)
        && Array.isArray(review.issues) && review.issues.some((issue: string) => /标题|封面|文案|简介|\b(?:title|cover|copy)\b/iu.test(issue))
        && review.issues.every((issue: string) => /^final_(?:content|attribution|visuals)_not_passed$/u.test(issue)
            || /标题|封面|文案|简介|\b(?:title|cover|copy)\b/iu.test(issue))
        && !review.issues.some((issue: string) => /source_window|结尾|片尾|收尾|边界|上下文不完整/u.test(issue));
}

export async function repairOwnPublicCopy(artifact: Artifact, config: PublicationConfig & Data,
    required: Data, io: CopyRepairIO): Promise<Artifact> {
    if (!copyRepairEligible(artifact, config)) return artifact;
    const initial = await io.snapshot(artifact), inputIdentity = identity(artifact, initial);
    const coverLayout = ['content', 'attribution', 'subtitles', 'policy'].every(key => artifact.publicationReview.checks?.[key] === true)
        && artifact.publicationReview.checks.visuals === false
        && artifact.publicationReview.issues.some((issue: string) => /封面.*(?:遮|挡|布局|排版)/u.test(issue))
        && artifact.publicationReview.issues.every((issue: string) => issue === 'final_visuals_not_passed' || /封面.*(?:遮|挡|布局|排版)/u.test(issue));
    if (coverLayout ? artifact.automaticCoverLayoutRepair : artifact.automaticCopyRepair?.resultIdentity === inputIdentity) return artifact;
    const pending: Artifact = { ...artifact, attributionRequired: true,
        ...(required.qaRequired ? { qaRequired: true } : {}),
        automaticCopyRepair: { version: 1, authority: 'automatic', method: 'copy_only', inputIdentity,
            before: { copy: artifact.copy, coverPath: artifact.output.coverPath, attributionRequired: artifact.attributionRequired,
                qaRequired: artifact.qaRequired, publicationReview: artifact.publicationReview },
            attemptedAt: new Date().toISOString(), status: 'reviewing' } };
    const attributionRepair = artifact.publicationReview.issues.some((issue: string) => /^attribution_/u.test(issue));
    let updated = coverLayout && artifact.attributionReview?.status === 'passed'
        || prerequisiteRepairEligible(artifact, config) && !attributionRepair ? pending
        : await io.reviewCopy(pending, artifact.publicationReview.issues);
    if (!same(updated.window, artifact.window) || !same(updated.source, artifact.source)
        || updated.output.mediaPath !== artifact.output.mediaPath || updated.output.srtPath !== artifact.output.srtPath
        || updated.output.metadataPath !== artifact.output.metadataPath || updated.ownStreamHumanReview || updated.humanReview) {
        throw new Error('Copy repair changed media, boundaries, source or review authority');
    }
    if (updated.attributionRequired !== true || pending.qaRequired && !updated.qaRequired) throw new Error('Copy repair removed required review');
    if (updated.attributionReview?.status !== 'passed' || updated.publicCopyPending) {
        const failed = await io.snapshot(updated);
        if (!same(initial.source, failed.source) || initial.digests.video !== failed.digests.video
            || initial.digests.subtitles !== failed.digests.subtitles) throw new Error('Source or media changed during copy repair');
        return { ...updated, automaticCopyRepair: { ...pending.automaticCopyRepair, status: 'needs_review', resultIdentity: identity(updated, failed) } };
    }
    if (!same(updated.copy, artifact.copy) || coverLayout) {
        const coverPath = await io.renderCover(updated, coverLayout ? { textPosition: 'bottom' } : undefined);
        if (!coverPath || coverPath === artifact.output.coverPath) throw new Error('Copy repair requires a new cover artifact');
        updated = { ...updated, output: { ...updated.output, coverPath } };
    } else if (!prerequisiteRepairEligible(artifact, config)) return artifact;
    const revised = await io.snapshot(updated);
    if (!same(initial.source, revised.source) || initial.digests.video !== revised.digests.video
        || initial.digests.subtitles !== revised.digests.subtitles) throw new Error('Source or media changed during copy repair');
    updated.automaticCopyRepair = { ...pending.automaticCopyRepair, status: 'repaired', resultIdentity: identity(updated, revised) };
    if (coverLayout) updated.automaticCoverLayoutRepair = { version: 1, authority: 'automatic', inputIdentity,
        resultIdentity: identity(updated, revised), issues: artifact.publicationReview.issues };
    // The final reviewer receives the actual revised cover and copy and binds a fresh approval.
    const reviewed = await io.reviewFinal(updated);
    if (updated.qaRequired && reviewed.publicationDecision?.action === 'auto_queue'
        && (reviewed.qaResult?.version !== 1 || reviewed.qaResult.status !== 'passed' || reviewed.qaResult.issues?.length
            || ['video', 'subtitles', 'cover', 'copy'].some(key => reviewed.qaResult.digests?.[key] !== revised.digests[key as keyof typeof revised.digests]))) {
        throw new Error('Required quality review was not completed for the revised artifacts');
    }
    return reviewed;
}
