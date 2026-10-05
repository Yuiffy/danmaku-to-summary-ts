import { createHash } from 'crypto';

type Data = Record<string, any>;
export const ACTIVITY_REVIEW_EVIDENCE_VERSION = 3;
export interface ActivityTextReaders {
    read(file: string): Buffer;
    parse(file: string): Array<{ start: number; end: number; text: string }>;
    audience(file: string): Promise<Array<{ time: number; text: string }>>;
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
    const activities = row.activities.map((event: Data) => ({ id: event.id, start: event.start, end: event.end,
        cues: cues.filter(cue => cue.end > event.start && cue.start < event.end),
        before: cues.filter(cue => cue.end > event.start - 90 && cue.end <= event.start),
        after: cues.filter(cue => cue.start >= event.end && cue.start < event.end + 90),
        // Viewer reactions corroborate context; they never establish host speech or identity.
        audience: audience.filter(cue => cue.time >= event.start && cue.time <= event.end)
    }));
    if (activities.some((event: Data) => !event.cues.length)) throw new Error('Activity final review has no retained text');
    verify(transcript.path, transcript.sha256);
    if (source.xmlPath) verify(source.xmlPath, source.xmlSha256);
    return { version: ACTIVITY_REVIEW_EVIDENCE_VERSION, timeBasis: 'absolute_recording_seconds',
        transcript: { path: transcript.path, sha256: transcript.sha256, mode: transcript.mode },
        xml: source.xmlPath ? { path: source.xmlPath, sha256: source.xmlSha256 } : null, activities };
}

/** The union of review batches covers every P and cue; outer context accompanies each batch. */
export function activityPublicationBatchText(text: Data, parts: Data[]): Data {
    if (!parts.length || parts.some(part => !Number.isFinite(part.start) || !Number.isFinite(part.end) || part.end <= part.start)) {
        throw new Error('Missing activity review P text intervals');
    }
    return { ...text, coverage: 'complete_sampled_P_text', reviewedIntervals: parts.map(part => ({start:part.start,end:part.end})),
        activities: text.activities.map((event: Data) => ({ ...event,
            cues: event.cues.filter((cue: Data) => parts.some(part => cue.end > part.start && cue.start < part.end)),
            audience: event.audience.filter((cue: Data) => parts.some(part => cue.time >= part.start && cue.time <= part.end)) })) };
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
