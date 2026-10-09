import { createHash } from 'crypto';
import { titleItems } from './activityTitles';

type Data = Record<string, any>;
export const ACTIVITY_REVIEW_EVIDENCE_VERSION = 3;
export const ACTIVITY_TITLE_EVIDENCE_VERSION = 1;
export interface ActivityTextReaders {
    read(file: string): Buffer;
    parse(file: string): Array<{ start: number; end: number; text: string }>;
    audience(file: string): Promise<Array<{ time: number; text: string }>>;
}

/** Shared decoder/assessment artifacts occur once, with explicit per-event references. No observation is truncated. */
export function activityPublicationBoundaries(activities: Data[], read: (file: string) => Data): Data {
    const artifacts: Data = {}, byPath = new Map<string, string>();
    const reference = (file: string): string => {
        let id = byPath.get(file);
        if (!id) {
            id = `B${byPath.size + 1}`;
            artifacts[id] = { path: file, evidence: read(file) };
            byPath.set(file, id);
        }
        return id;
    };
    const events = activities.map(event => ({ id: event.id,
        independentAudioRef: reference(event.verification.localAudioEvidence.resultPath),
        boundaryAssessmentRef: reference(event.verification.responsePath) }));
    return { events, artifacts };
}

/** Keep decisions and integrity references; the full decoder payload is supplied in boundaryEvidence once. */
export function activityPublicationEvents(activities: Data[]): Data[] {
    return activities.map(event => {
        const { audio: _audio, ...localAudioEvidence } = event.verification.localAudioEvidence;
        return { ...event, verification: { ...event.verification, localAudioEvidence } };
    });
}

/** Full activity text and both outer contexts, with no silent cue truncation. */
export async function activityPublicationText(row: Data, readers: ActivityTextReaders): Promise<Data> {
    const transcript = row.transcript, source = row.sourceSnapshot;
    const verify = (file: string, sha: string) => {
        if (!file || !sha || createHash('sha256').update(readers.read(file)).digest('hex') !== sha) {
            throw new Error('Activity final review text evidence changed or is missing');
        }
    };
    verify(transcript?.path, transcript?.sha256);
    if (source.xmlPath) verify(source.xmlPath, source.xmlSha256);
    const cues = readers.parse(transcript.path).map((cue, index) => ({ id: `T${index + 1}`, ...cue }));
    if (!cues.length || cues.some(cue => !Number.isFinite(cue.start) || !Number.isFinite(cue.end)
        || cue.end <= cue.start || !cue.text.trim())) throw new Error('Invalid complete activity transcript');
    const audience = source.xmlPath ? await readers.audience(source.xmlPath) : [];
    const titles = titleItems(row.presentation?.titleEvidence || null);
    const activities = row.activities.map((event: Data) => ({ id: event.id, start: event.start, end: event.end,
        cues: cues.filter(cue => cue.end > event.start && cue.start < event.end),
        before: cues.filter(cue => cue.end > event.start - 90 && cue.end <= event.start),
        after: cues.filter(cue => cue.start >= event.end && cue.start < event.end + 90),
        // Viewer reactions corroborate context; they never establish host speech or identity.
        audience: audience.filter(cue => cue.time >= event.start && cue.time <= event.end),
        // Naming often happens before the song. Match the maintained title-binding
        // window, preserving actual source text rather than trusting a review note.
        ...(titles.some(item => item.activityId === event.id) ? { titleContext: {
            before: cues.filter(cue => cue.end > event.start - 300 && cue.end <= event.start),
            after: cues.filter(cue => cue.start >= event.end && cue.start < event.end + 60),
            audience: audience.filter(cue => cue.time >= event.start - 300 && cue.time <= event.end + 60)
        } } : {})
    }));
    if (activities.some((event: Data) => !event.cues.length)) throw new Error('Activity final review has no retained text');
    verify(transcript.path, transcript.sha256);
    if (source.xmlPath) verify(source.xmlPath, source.xmlSha256);
    return { version: ACTIVITY_REVIEW_EVIDENCE_VERSION, titleEvidenceVersion: ACTIVITY_TITLE_EVIDENCE_VERSION,
        titleEvidence: row.presentation?.titleEvidence || null, timeBasis: 'absolute_recording_seconds',
        transcript: { path: transcript.path, sha256: transcript.sha256, mode: transcript.mode },
        xml: source.xmlPath ? { path: source.xmlPath, sha256: source.xmlSha256 } : null, activities };
}

/** A single explicit upgrade repairs omitted, already-bound naming evidence only. */
export function omittedActivityTitleEvidenceReview(row: Data, proof: Data): boolean {
    const review = row.activityReview;
    const otherChecks = ['content', 'boundaries', 'visuals', 'policy'];
    return row.uploadReady === false && review?.status === 'pending' && review.authority === 'automatic'
        && titleItems(row.presentation?.titleEvidence || null).length > 0
        && proof.version === 1 && proof.evidenceVersion === ACTIVITY_REVIEW_EVIDENCE_VERSION
        && proof.titleEvidenceVersion === undefined && proof.completeText?.titleEvidenceVersion === undefined
        && proof.status === 'needs_review' && proof.checks?.titles === false
        && JSON.stringify(proof.checks) === JSON.stringify(review.checks)
        && otherChecks.every(key => proof.checks?.[key] === true)
        && Array.isArray(proof.responses) && proof.responses.length > 0
        && proof.responses.every((response: Data) => response.status !== 'rejected'
            && otherChecks.every(key => response.checks?.[key] === true));
}

/** The union of review batches covers every P and cue; outer context accompanies each batch. */
export function activityPublicationBatchText(text: Data, parts: Data[]): Data {
    if (!parts.length || parts.some(part => !Number.isFinite(part.start) || !Number.isFinite(part.end) || part.end <= part.start)) {
        throw new Error('Missing activity review P text intervals');
    }
    return { ...text, coverage: 'complete_sampled_P_text', reviewedIntervals: parts.map(part => ({start:part.start,end:part.end})),
        activities: text.activities.map((event: Data) => ({ ...event,
            cues: event.cues.filter((cue: Data) => parts.some(part => cue.end > part.start && cue.start < part.end)),
            audience: event.audience.filter((cue: Data) => parts.some(part => cue.time >= part.start && cue.time <= part.end)),
            ...(event.titleContext ? { titleContext: { ...event.titleContext,
                // Retained audience is already in this batch's audience field. Naming context outside
                // the activity accompanies every batch; all interior entries still receive review.
                audience: event.titleContext.audience.filter((cue: Data) => cue.time < event.start || cue.time > event.end)
            } } : {}) })) };
}

/** One explicit evidence upgrade for legacy text omissions; actual content/visual/title rejection remains held. */
export function legacyActivityEvidenceReview(row: Data, proof: Data): boolean {
    const review = row.activityReview;
    return row.uploadReady === false && review?.status === 'pending' && review.authority === 'automatic'
        && proof.version === 1 && proof.evidenceVersion === undefined && proof.status === 'needs_review'
        && JSON.stringify(proof.checks) === JSON.stringify(review.checks)
        && ['content', 'titles', 'visuals'].every(key => proof.checks?.[key] === true)
        && ['boundaries', 'policy'].some(key => proof.checks?.[key] === false)
        && Array.isArray(proof.responses) && proof.responses.length > 0
        && proof.responses.every((response: Data) => response.status !== 'rejected'
            && ['content', 'titles', 'visuals'].every(key => response.checks?.[key] === true));
}

/** One explicit upgrade adds labelled sample sheets and a precise partition contract; rejected content stays held. */
export function partitionedActivityEvidenceReview(row: Data, proof: Data): boolean {
    const review = row.activityReview;
    return row.uploadReady === false && review?.status === 'pending' && review.authority === 'automatic'
        && proof.version === 1 && proof.evidenceVersion === 2 && proof.status === 'needs_review'
        && proof.completeText?.version === 2 && proof.completeText.activities?.length > 0
        && JSON.stringify(proof.checks) === JSON.stringify(review.checks)
        && Array.isArray(proof.responses) && proof.responses.length > 0
        && proof.responses.every((response: Data) => response.status !== 'rejected' && response.checks?.boundaries === true);
}
