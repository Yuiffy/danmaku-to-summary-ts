import { createHash } from 'crypto';
import { titleItems } from './activityTitles';

type Data = Record<string, any>;
export const ACTIVITY_REVIEW_EVIDENCE_VERSION = 3;
export const ACTIVITY_TITLE_EVIDENCE_VERSION = 1;
export const ACTIVITY_SAMPLE_EVIDENCE_VERSION = 1;
export interface ActivityTextReaders {
    read(file: string): Buffer;
    parse(file: string): Array<{ start: number; end: number; text: string }>;
    audience(file: string): Promise<Array<{ time: number; text: string }>>;
}

/** Keep the original anchors; viewing neighbours reveal brief transitions without hiding black frames. */
export function activityPublicationSamples(kind: string, part: Data): Data[] {
    const duration = part.end - part.start;
    if (!Number.isFinite(part.start) || !Number.isFinite(duration) || duration <= 0) throw new Error('Invalid activity sample interval');
    const last = Math.max(0, duration - .25);
    const anchors = [{ label: 'BEGIN', time: Math.min(.25, last) },
        { label: 'MIDDLE', time: Math.min(duration / 2, last) }, { label: 'END', time: last }];
    const samples = kind === 'watch' ? [anchors[0], { label: 'BEGIN AFTER', time: anchors[0].time + 2 },
        { label: 'MIDDLE BEFORE', time: anchors[1].time - 2 }, anchors[1], { label: 'MIDDLE AFTER', time: anchors[1].time + 2 },
        { label: 'END BEFORE', time: anchors[2].time - 2 }, anchors[2]] : anchors;
    return samples.map(sample => {
        const localSeconds = Math.max(0, Math.min(last, sample.time));
        return { label: sample.label, localSeconds, recordingSeconds: part.start + localSeconds };
    });
}

/** One explicit upgrade adds temporal context to black-aligned viewing; no other failed check or rejection qualifies. */
export function temporalActivityEvidenceReview(row: Data, proof: Data): boolean {
    const review = row.activityReview, parts = row.output?.parts;
    const otherChecks = ['content', 'boundaries', 'titles', 'policy'];
    if (row.kind !== 'watch' || row.uploadReady !== false || review?.status !== 'pending' || review.authority !== 'automatic'
        || proof.version !== 1 || proof.evidenceVersion !== ACTIVITY_REVIEW_EVIDENCE_VERSION || proof.sampleEvidenceVersion !== undefined
        || proof.completeText?.version !== ACTIVITY_REVIEW_EVIDENCE_VERSION || !proof.completeText.activities?.length
        || proof.status !== 'needs_review' || proof.checks?.visuals !== false
        || JSON.stringify(proof.checks) !== JSON.stringify(review.checks) || !otherChecks.every(key => proof.checks?.[key] === true)
        || !Array.isArray(parts) || !parts.length || !Array.isArray(proof.responses) || !proof.responses.length) return false;
    const numbers: number[] = [];
    for (const response of proof.responses) {
        const scope = response.reviewScope;
        if (!['passed', 'needs_review'].includes(response.status) || typeof response.checks?.visuals !== 'boolean'
            || !otherChecks.every(key => response.checks?.[key] === true)
            || !Array.isArray(scope?.partNumbers) || !scope.partNumbers.length || !Array.isArray(scope.imageManifest)) return false;
        for (const number of scope.partNumbers) {
            const part = parts[number - 1], sheet = scope.imageManifest.find((image: Data) => image.kind === 'P_sample_sheet' && image.partNumber === number);
            if (!Number.isInteger(number) || !part || !Array.isArray(sheet?.samples) || sheet.samples.length !== 3
                || !['BEGIN', 'MIDDLE', 'END'].every((label, index) => sheet.samples[index].label === label)) return false;
            numbers.push(number);
        }
        if (response.checks?.visuals === false && !scope.partNumbers.some((number: number) => parts[number - 1]?.blackAlignmentEvidence)) return false;
    }
    return numbers.length === parts.length && new Set(numbers).size === parts.length
        && proof.responses.some((response: Data) => response.checks.visuals === false);
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
        ...(event.verification.nativeListening ? { nativeListeningRef: reference(event.verification.nativeListening.path) } : {}),
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
