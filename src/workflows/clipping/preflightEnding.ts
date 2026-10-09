interface Cue { id: string; start: number; end: number; rawRef?: string }
interface RawSpan { id: string; start: number; end: number; timingPrecision?: string }
interface Bounds { start: number; end: number; endCueId: string }

/** A display row split from one coarse ASR segment cannot prove an acoustic cut. */
export function endingTimingIssues(bounds: Bounds, input: { subtitles: Cue[]; originalAsrSpans?: RawSpan[] }): string[] {
  const cue = input.subtitles.find(row => row.id === bounds.endCueId);
  const span = input.originalAsrSpans?.find(row => row.id === cue?.rawRef);
  if (!span || span.timingPrecision === 'word' || span.end <= bounds.end + .002) return [];
  return [`收尾仍在原始ASR段内：${bounds.endCueId} / ${span.id} 延续至 ${span.end}，需保留完整原段或核实独立语音边界`];
}

/** Add only available source breathing room, never include excluded speech. */
export function withPreflightEndingHold<T extends { start: number; end: number; status: string }>(
  clip: T, cues: Cue[], contextEnd: number, maxSeconds: number, nextClipStart = Infinity
) {
  if (clip.status !== 'ready' || !Number.isFinite(contextEnd) || !Number.isFinite(maxSeconds)) return clip;
  const nextSpeech = cues.filter(cue => cue.end > clip.end + .001)
    .reduce((earliest, cue) => Math.min(earliest, cue.start), Infinity);
  const end = Math.round(Math.max(clip.end, Math.min(clip.end + 3, contextEnd,
    clip.start + maxSeconds, nextClipStart, nextSpeech - .08)) * 1000) / 1000;
  return { ...clip, end, duration: end - clip.start,
    endingHold: { speechEnd: clip.end, seconds: Math.round((end - clip.end) * 1000) / 1000, requestedSeconds: 3 } };
}
