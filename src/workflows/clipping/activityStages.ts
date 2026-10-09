export type ActivityKind = 'songs' | 'watch';
type ActivityEvent = { kind: string };
type StagePlan = {
  status?: string;
  calibratedKinds?: ActivityKind[];
};
type ManifestClip = { reviewIndex: number; metadataPath: string };
type VerifiedEvent = ActivityEvent & { id: string; verification?: { decision?: string } };

/** Resume an early stage only after its shared prerequisite recovered. No generation retry loop. */
export async function runArchiveStages(run: (kind: string, reuseSummaryOnly?: boolean) => Promise<any>,
  completed: (kind: string, result: any) => void, failed: (kind: string, error: any) => void): Promise<void> {
  let songsNeedSummary = false;
  for (const kind of ['songs', 'games', 'watch']) {
    try {
      const result = await run(kind);
      completed(kind, result);
      if (kind === 'watch' && result.status === 'rendered' && songsNeedSummary) {
        try { completed('songs', await run('songs', true)); }
        catch (error) { failed('songs', error); }
      }
    } catch (error) {
      if (kind === 'songs') songsNeedSummary = (error as any).code === 'ACTIVITY_SUMMARY_NOT_READY';
      failed(kind, error);
    }
  }
}

/** Reject conflicting intervals before rendering. Never trim evidence to fit. */
export function assertOrderedActivityParts(parts: Array<{ start: number; end: number }>): void {
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!Number.isFinite(part.start) || !Number.isFinite(part.end) || part.start < 0 || part.end <= part.start
      || (i > 0 && part.start < parts[i - 1].end)) {
      throw new Error(`Activity P${i + 1} has invalid or overlapping source intervals; resolve boundaries before rendering`);
    }
  }
}

/** Explicit recovery selects unresolved candidates only, preserving confirmed siblings. */
export function retryBoundaryEvents<T extends VerifiedEvent>(raw: T[], events: VerifiedEvent[], selected: ActivityKind[], rejected: VerifiedEvent[] = [], feedback: any[] = []): T[] {
  const represented = new Set([...events, ...rejected].map(event => event.id));
  if (selectEvents(raw, selected).some(event => !represented.has(event.id))) {
    throw new Error('Original activity identities were merged or lost; use an explicit reviewed revision');
  }
  const ids = new Set(selectEvents(events, selected).filter(event => event.verification?.decision === 'uncertain').map(event => event.id));
  for (const item of feedback) ids.add(item.id);
  const candidates = raw.filter(event => ids.has(event.id));
  if (candidates.length !== ids.size) throw new Error('Boundary retry is missing original candidate identities');
  if (!candidates.length) throw new Error('No unresolved activity boundaries to retry');
  return candidates.map(event => feedback.some(item => item.id === event.id)
    ? { ...event, boundaryFeedback: feedback.find(item => item.id === event.id) } : event);
}

/** A failed final P may reopen its own boundary for new independent evidence, never grant approval. */
export function activityBoundaryFeedback(row: any, proof: any, registered: any, ids: string[]): any[] {
  assertPendingBoundaryRetry(row, registered);
  if (!registered || registered.automaticPublicationAuthorization || registered.uploadState?.bvid || registered.uploadState?.aid
    || row.activityAutomaticPublicationRequired !== true || row.activityReview?.authority !== 'automatic'
    || row.activityReview?.status !== 'pending' || row.activityReview?.checks?.boundaries !== false
    || proof?.status !== 'needs_review' || proof.evidenceVersion !== 3
    || JSON.stringify(proof.checks) !== JSON.stringify(row.activityReview.checks)
    || !ids.length || new Set(ids).size !== ids.length || !Array.isArray(proof.responses)) {
    throw new Error('Boundary feedback requires an unpublished current final boundary rejection');
  }
  return ids.map(id => {
    const event = row.activities.find((event: any) => event.id === id);
    const failures = proof.responses.filter((response: any) => response.checks?.boundaries === false
      && response.reviewScope?.partNumbers?.some((number: number) => Number.isInteger(number)
        && row.output.parts[number - 1]?.activityId === id));
    if (!event || !failures.length) throw new Error(`Activity ${id} is not in a failed final boundary partition`);
    return { id, previousStart: event.start, previousEnd: event.end, proofPath: row.activityReview.proofPath,
      issues: [...new Set(failures.flatMap((response: any) => response.issues))] };
  });
}

export function replaceRetriedEvents<T extends VerifiedEvent>(previous: T[], next: T[], ids: string[]): T[] {
  return [...previous.filter(event => !ids.includes(event.id)), ...next];
}

export function assertPendingBoundaryRetry(row: { activityReview?: { status?: string }; uploadReady?: boolean },
  registered?: { id?: unknown; status?: string; bvid?: unknown; aid?: unknown }): void {
  if (row.activityReview?.status === 'approved' || row.uploadReady) throw new Error('Approved activity cannot retry boundaries');
  if (registered && (!['needs_review', 'review'].includes(registered.status || '') || registered.bvid || registered.aid)) {
    throw new Error(`Activity ID ${registered.id} is not pending review; boundary retry is refused`);
  }
}

export function samePlannedParts(planned: Array<{ activityId: string; start: number; end: number }>,
  rendered: Array<{ activityId: string; start: number; end: number }>): boolean {
  return planned.length === rendered.length && planned.every((part, i) => part.activityId === rendered[i].activityId
    && part.start === rendered[i].start && part.end === rendered[i].end);
}

/** A changed transcript invalidates both kinds. Keep bundle identities while rebuilding from fresh shared evidence. */
export function activityTimingRevision(previous: any, next: any, revision: any): any {
  if (!previous.uploadManifestPath || previous.transcript?.timingReliable !== false
      || next.transcript?.mode !== 'repaired_source_audio' || !revision?.note?.trim()
      || JSON.stringify(previous.source) !== JSON.stringify(next.source)) {
    throw new Error('Timing revision requires a pending source-bound unreliable transcript and completed repair');
  }
  return { ...next, signature: previous.signature, timingSignature: next.signature, uploadManifestPath: previous.uploadManifestPath,
    timingRevision: revision, timingRevisions: [...(previous.timingRevisions || []), { ...revision,
      previousTranscript: previous.transcript, transcript: next.transcript, previousSummary: previous.summary, summary: next.summary,
      previousEfficiency: previous.efficiency }], uploadIds: previous.uploadIds, calibratedKinds: [] };
}

export function activityKinds(kind?: unknown): ActivityKind[] {
  if (kind == null) return ['songs', 'watch'];
  if (kind !== 'songs' && kind !== 'watch') throw new Error('Activity kind must be songs or watch');
  return [kind];
}

export function calibratedKinds(plan: StagePlan): ActivityKind[] {
  return plan.calibratedKinds ?? (['planned', 'rendered'].includes(plan.status || '') ? ['songs', 'watch'] : []);
}

export function pendingKinds(plan: StagePlan, selected: ActivityKind[]): ActivityKind[] {
  const complete = calibratedKinds(plan);
  return selected.filter(kind => !complete.includes(kind));
}

export function selectEvents<T extends ActivityEvent>(events: T[], selected: ActivityKind[]): T[] {
  return events.filter(event => selected.includes(event.kind === 'song' ? 'songs' : 'watch'));
}

export function combineEvents<T extends ActivityEvent>(previous: T[], next: T[], selected: ActivityKind[]): T[] {
  return [...previous.filter(event => !selected.includes(event.kind === 'song' ? 'songs' : 'watch')), ...next];
}

export function completeKinds(plan: StagePlan, selected: ActivityKind[]): ActivityKind[] {
  return [...new Set([...calibratedKinds(plan), ...selected])];
}

export function songRecordStatus(plan: StagePlan): string | undefined {
  if (!plan.calibratedKinds) return plan.status;
  if (!plan.calibratedKinds.includes('songs')) return plan.status === 'failed' ? 'failed' : 'awaiting_songs';
  return ['planned', 'rendered'].includes(plan.status || '') ? plan.status : 'planned';
}

/** Keep existing indices, including legacy watch-only manifests whose first ID was 1. */
export function mergeManifestClips(existing: ManifestClip[], metadataPaths: string[]): ManifestClip[] {
  const clips = existing.map(clip => ({ ...clip }));
  let nextIndex = Math.max(0, ...clips.map(clip => clip.reviewIndex)) + 1;
  for (const metadataPath of metadataPaths) {
    if (!clips.some(clip => clip.metadataPath === metadataPath)) clips.push({ reviewIndex: nextIndex++, metadataPath });
  }
  return clips;
}
