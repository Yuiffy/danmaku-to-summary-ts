export type ActivityKind = 'songs' | 'watch';
type ActivityEvent = { kind: string };
type StagePlan = {
  status?: string;
  calibratedKinds?: ActivityKind[];
};
type ManifestClip = { reviewIndex: number; metadataPath: string };
type VerifiedEvent = ActivityEvent & { id: string; verification?: { decision?: string } };

/** Explicit recovery selects unresolved candidates only, preserving confirmed siblings. */
export function retryBoundaryEvents<T extends VerifiedEvent>(raw: T[], events: VerifiedEvent[], selected: ActivityKind[], rejected: VerifiedEvent[] = []): T[] {
  const represented = new Set([...events, ...rejected].map(event => event.id));
  if (selectEvents(raw, selected).some(event => !represented.has(event.id))) {
    throw new Error('Original activity identities were merged or lost; use an explicit reviewed revision');
  }
  const ids = new Set(selectEvents(events, selected).filter(event => event.verification?.decision === 'uncertain').map(event => event.id));
  const candidates = raw.filter(event => ids.has(event.id));
  if (candidates.length !== ids.size) throw new Error('Boundary retry is missing original candidate identities');
  if (!candidates.length) throw new Error('No unresolved activity boundaries to retry');
  return candidates;
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
