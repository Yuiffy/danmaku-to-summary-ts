import * as path from 'path';
import { createHash } from 'crypto';

type Data = Record<string, any>;
export const candidateDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export function campaignCandidateId(row: Data): string {
  return candidateDigest(`${candidateDigest(path.resolve(row.sourceMediaPath).toLowerCase())}:${row.selectionKey}`);
}
export function campaignCandidatePath(media: string, id: string): string {
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid campaign candidate ID');
  return path.join(path.dirname(media), 'own_stream_fun_clips', 'campaign_candidates', id, 'candidate.json');
}

/** A selected recall becomes an unapproved source-only own-stream candidate. */
export function campaignCandidateMetadata(row: Data, context: Data, evidence: Data, upload: Data): Data {
  const start = row.start ?? row.candidate?.start, end = row.end ?? row.candidate?.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('候选时间不完整');
  if (row.sourceSha256 && row.sourceSha256 !== evidence.sourceSha256) throw new Error('候选原文证据已变化，请重新选材');
  const id = campaignCandidateId(row), metadataPath = campaignCandidatePath(row.sourceMediaPath, id);
  const index = parseInt(id.slice(0, 8), 16) + 1000000;
  const window = { index, start, end, duration: end - start };
  return {
    version: 1, mode: 'own_stream_fun_review', status: 'selection_rejected', reviewIndex: index,
    generatedAt: new Date().toISOString(),
    roomId: context.roomId, streamerName: context.streamerName, recordedAt: context.recordedAt, streamTitle: context.streamTitle,
    source: { ...context.source, mediaPath: row.sourceMediaPath, srtPath: row.sourceSrtPath }, window,
    selectionSource: 'campaign_candidate',
    campaignCandidate: { id, selectionKey: row.selectionKey, label: row.label },
    reviewPresentation: { title: row.title || row.candidate?.event || row.label, window, windowAuthority: 'recall_context', sourceSha256: evidence.sourceSha256 },
    copy: { title: row.title || row.candidate?.event || row.label, description: '', coverText: '' },
    publicCopyPending: true, uploadReady: false, upload,
    selectionRejection: { reason: 'deferred_campaign_candidate', originalReason: row.reason, candidateIndex: row.candidateIndex ?? row.index, sourceSha256: evidence.sourceSha256 },
    grounding: { sourceSha256: evidence.sourceSha256, issues: ['deferred_campaign_candidate'],
      subtitles: evidence.cues.filter((cue: Data) => cue.start >= start && cue.end <= end).slice(0, 3) },
    output: { metadataPath, mediaPath: null, srtPath: path.join(path.dirname(metadataPath), 'candidate.srt'), coverPath: null, burnedSubtitles: false }
  };
}
