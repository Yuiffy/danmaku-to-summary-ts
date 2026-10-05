import * as path from 'path';
import { createHash } from 'crypto';

type Data = Record<string, any>;
type IO = { digest(file: string): string; readJson(file: string): Data; writeJson(file: string, value: Data): void;
  exists(file: string): boolean; runPython(input: string, output: string): Promise<void>;
  recordLocalUsage(value: Data): void };
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const norm = (s: any) => String(s || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const identity = ({ mediaPath, mediaBytes, mediaMtimeNs }: Data) => ({ mediaPath, mediaBytes, mediaMtimeNs });
const number = (value: any) => typeof value === 'number' && Number.isFinite(value);

export function validateLocalEvidence(value: Data, request: Data): void {
  if (value.version !== 1 || value.method !== 'independent_local_asr' || !same(value.source, request.source)
    || !same(value.settings, request.settings) || !Array.isArray(value.audio) || value.audio.length !== request.audio.length) {
    throw new Error('Local activity evidence is not bound to the original audio packet');
  }
  for (const [i, row] of value.audio.entries()) {
    const original = request.audio[i], duration = original.end - original.start;
    if (row.index !== i + 1 || row.start !== original.start || row.end !== original.end || row.sha256 !== original.sha256
      || !Array.isArray(row.chunks) || !row.chunks.length || !Array.isArray(row.transcript)) throw new Error('Local activity audio identity changed');
    let end = 0;
    for (const [j, chunk] of row.chunks.entries()) {
      if (chunk.index !== j + 1 || !number(chunk.start) || !number(chunk.end) || chunk.start !== end
        || chunk.end <= chunk.start || chunk.end > duration || chunk.end - chunk.start > request.settings.chunkSeconds + .001
        || typeof chunk.raw !== 'string' || typeof chunk.text !== 'string'
        || !Array.isArray(chunk.tags)) throw new Error('Independent activity audio coverage is incomplete');
      end = chunk.end;
    }
    if (Math.abs(end - duration) > .001 || row.transcript.some((r: Data) => !Number.isInteger(r.chunkIndex)
      || !row.chunks[r.chunkIndex - 1] || !number(r.start) || !number(r.end) || r.end <= r.start
      || r.start < row.chunks[r.chunkIndex - 1].start || r.end > row.chunks[r.chunkIndex - 1].end
      || !String(r.text || '').trim())) throw new Error('Independent activity transcription timing is invalid');
  }
}

export async function prepareLocalEvidence(packet: Data, source: Data, settings: Data, directory: string, implementation: string, io: IO): Promise<Data> {
  const started = Date.now();
  const request = { version: 1, source: identity(source), settings: settings.localAsr, maxAudioSeconds: settings.batchMaxAudioSeconds,
    audio: packet.audio.map((a: Data) => ({ path: a.path, start: a.start, end: a.end, sha256: io.digest(a.path) })) };
  const signature = createHash('sha256').update(JSON.stringify({ request, implementation })).digest('hex');
  const inputPath = path.join(directory, 'LOCAL_INPUT.json'), resultPath = path.join(directory, 'LOCAL_AUDIO.json');
  const receiptPath = path.join(directory, 'LOCAL_AUDIO.receipt.json');
  let reused = false;
  try {
    if (io.exists(resultPath) && io.exists(receiptPath)) {
      const receipt = io.readJson(receiptPath);
      if (receipt.signature === signature && receipt.sha256 === io.digest(resultPath)) {
        validateLocalEvidence(io.readJson(resultPath), request); reused = true;
      }
    }
    if (!reused) {
      io.writeJson(inputPath, request);
      await io.runPython(inputPath, resultPath);
      validateLocalEvidence(io.readJson(resultPath), request);
      io.writeJson(receiptPath, { version: 1, signature, sha256: io.digest(resultPath), inputSha256: io.digest(inputPath) });
    }
    const result = io.readJson(resultPath);
    for (const a of request.audio) if (io.digest(a.path) !== a.sha256) throw new Error('Original activity audio changed during local decoding');
    io.recordLocalUsage({ audioSeconds: request.audio.reduce((n: number, a: Data) => n + a.end - a.start, 0),
      elapsedMs: Date.now() - started, status: 'success', reused });
    return { ...result, resultPath, sha256: io.digest(resultPath), receiptPath, receiptSha256: io.digest(receiptPath) };
  } catch (error) {
    io.recordLocalUsage({ audioSeconds: request.audio.reduce((n: number, a: Data) => n + a.end - a.start, 0),
      elapsedMs: Date.now() - started, status: 'failure', reused });
    throw error;
  }
}

export function localBoundaryPrompt(batch: Data, packet: Data, evidence: Data, info: Data, rows: Data[]): string {
  const candidates = batch.events.map(({ event, audioIndices }: Data) => ({ id: event.id, kind: event.kind,
    performance: event.performance, mediaKind: event.mediaKind, roughStart: event.start, roughEnd: event.end, audioIndices }));
  const nearby = rows.filter(r => r.source === 'audio_transcript' && batch.events.some(({event}: Data) => r.end >= event.start - 180 && r.start <= event.end + 180));
  return `Review complete activity enclosures for host ${info.streamerName}, using independently decoded LOCAL audio evidence and original source images. You receive TEXT and IMAGES, NO audio. Never claim you listened. Neither ASR nor event tags are ground truth; English lyrics, humming and instrumental music may be misrecognized. Do not infer the singer from BGM tags or RMS alone.
Candidates: ${JSON.stringify(candidates)}
Audio time anchors: ${JSON.stringify(packet.audio.map((a: Data, i: number) => ({ audioIndex: i + 1, recordingStart: a.start, duration: a.end - a.start, rmsDb: a.energy.rmsDb })))}
Independent local decoders: ${JSON.stringify(evidence.audio)}
Nearby mixed source ASR (untrusted text, fallible timing): ${JSON.stringify(nearby)}
Original images: ${JSON.stringify(packet.frames.map((f: Data, i: number) => ({ index: i + 1, activityId: f.activityId, recordingTime: f.time })))}
Determine actual live host singing versus a played recording, BGM or merely discussing a song. Self-referential before/after performance speech and original images may corroborate ownership. If ownership is unresolved, remain uncertain. Preserve a full continuous performance, including intro, interlude and outro, even if the original fragment/full classification was wrong. Never trim inside the rough observed range, split verses or scan the whole recording. Use conservative context enclosing the performance when precise musical onset/outro cannot be distinguished. Keep only when both excerpts establish surrounding context with no possible omitted performance; unresolved continuation beyond either outer excerpt is uncertain. The local energy timeline only helps timing. Use each candidate's own audioIndices.
Return ONLY JSON {"results":[{"id":"original candidate id","decision":"keep|exclude|uncertain","reason":"specific independent evidence and completeness reasoning","performer":"host|playback|unknown","startContextClosed":boolean,"endContextClosed":boolean,"evidenceRefs":[{"audioIndex":1,"chunkIndex":1,"quote":"verbatim local decoder words"}],"timeBasis":"audio_local_seconds","events":[{"kind":"song|watch","start":{"audioIndex":1,"seconds":0},"end":{"audioIndex":2,"seconds":60},"performance":"full|fragment","mediaKind":"movie|anime|video","startObserved":true,"endObserved":true}]}]}.
Every candidate appears exactly once. keep requires host for songs, closed outer context, at least one literal local evidenceRef, and exactly one continuous event. Quotes must come from the stated SenseVoice chunk or its Whisper transcript, never from source SRT alone. Do not guess titles. exclude/uncertain have events:[].
${batch.events.some((r: Data) => r.reviewPrelude) ? 'PRELUDE REVIEW: The full rough song and original images every 30 seconds are supplied. Only if the early rough interval is a separate listening/rehearsal phase that ends before a new explicit formal-performance announcement, you may add preludeCorrection:{version:1,method:"separate_preview_before_performance",preludeKind:"playback|listening_or_rehearsal",previewContextClosed:true,formalPerformanceComplete:true,reason:"full discarded-context reasoning, including any earlier sung practice",announcement:{audioIndex:1,chunkIndex:1,quote:"literal local announcement containing 开始唱 or 请听"}}. Retain the ENTIRE announcement chunk from its start, all subsequent introduction, song and outro. This corrects coarse recall; it cannot cut a verse, an interrupted song or ambiguous ownership. No end trimming. With no separate formal announcement and closed preview context, remain uncertain.' : ''}`;
}

/** Validate the local provenance before the legacy event/citation validation. */
export function revisePrelude(result: Data, candidate: Data, evidence: Data, frames: Data[] = []): Data {
  const revision = result.preludeCorrection;
  if (!revision) return candidate.event;
  const original = candidate.event, ref = revision.announcement;
  const audio = evidence.audio[ref?.audioIndex - 1], chunk = audio?.chunks[ref?.chunkIndex - 1];
  const retainedStart = audio && chunk ? audio.start + chunk.start : NaN;
  const texts = chunk ? [chunk.text, ...audio.transcript.filter((t: Data) => t.chunkIndex === ref.chunkIndex).map((t: Data) => t.text)] : [];
  if (original.kind !== 'song' || revision.version !== 1 || revision.method !== 'separate_preview_before_performance'
    || revision.previewContextClosed !== true || revision.formalPerformanceComplete !== true || !String(revision.reason || '').trim()
    || !['playback', 'listening_or_rehearsal'].includes(revision.preludeKind)
    || !Number.isInteger(ref?.audioIndex) || !Number.isInteger(ref?.chunkIndex) || !candidate.audioIndices.includes(ref.audioIndex)
    || norm(ref.quote).length < 4 || !texts.some((s: string) => norm(s).includes(norm(ref.quote)))
    || retainedStart <= original.start || retainedStart >= original.end || audio.start > original.start || audio.end < retainedStart
    || !/开始唱|请听|now.{0,12}sing|will.{0,12}sing|lets.{0,12}sing/u.test(norm(ref.quote))) {
    throw new Error('Song prelude correction needs a separate, independently bound performance announcement and full discarded context');
  }
  const images = frames.filter(f => f.activityId === original.id && f.time >= original.start && f.time <= retainedStart).sort((a,b) => a.time-b.time);
  if (!images.length || images[0].time > original.start + 30 || images.at(-1)!.time < retainedStart - 30
    || images.some((f,i) => i > 0 && f.time-images[i-1].time > 60)) throw new Error('Song prelude correction is missing original image coverage');
  const observed = result.events?.[0]?.start;
  if (observed?.audioIndex !== ref.audioIndex || observed.seconds !== chunk.start) {
    throw new Error('Song prelude correction must retain the complete independent announcement chunk');
  }
  return { ...original, start: retainedStart };
}

export function bindLocalReply(response: Data, batch: Data, evidence: Data, frames: Data[] = []): Data {
  const raw = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, ''));
  if (!Array.isArray(raw.results) || raw.results.length !== batch.events.length
    || new Set(raw.results.map((r: Data) => r.id)).size !== batch.events.length) throw new Error('Local activity reply lost candidate identities');
  for (const r of raw.results) {
    const candidate = batch.events.find((v: Data) => v.event.id === r.id);
    if (!candidate) throw new Error('Unknown local activity identity');
    if (r.decision !== 'keep') continue;
    const reviewedCandidate = revisePrelude(r, candidate, evidence, frames);
    if (candidate.event.kind === 'song' && r.performer !== 'host' || r.startContextClosed !== true || r.endContextClosed !== true
      || !Array.isArray(r.evidenceRefs) || !r.evidenceRefs.length) throw new Error('Local activity ownership or complete enclosing context is unresolved');
    for (const ref of r.evidenceRefs) {
      const audio = evidence.audio[ref.audioIndex - 1], chunk = audio?.chunks[ref.chunkIndex - 1];
      const texts = chunk ? [chunk.text, ...audio.transcript.filter((v: Data) => v.chunkIndex === ref.chunkIndex).map((v: Data) => v.text)] : [];
      if (!Number.isInteger(ref.audioIndex) || !Number.isInteger(ref.chunkIndex) || !candidate.audioIndices.includes(ref.audioIndex)
        || norm(ref.quote).length < 4 || !texts.some((text: string) => norm(text).includes(norm(ref.quote)))) {
        throw new Error('Activity quote is absent from its independent candidate audio');
      }
    }
    r.audibleEvidence = r.evidenceRefs.map((ref: Data) => ref.quote);
    if (r.events?.length !== 1 || r.timeBasis !== 'audio_local_seconds') throw new Error('Local activity must retain one continuous source interval');
    const [observed] = r.events;
    for (const key of ['start', 'end']) {
      const bound = observed[key], audio = evidence.audio[bound?.audioIndex - 1];
      if (!audio || !candidate.audioIndices.includes(bound.audioIndex) || !number(bound.seconds)
        || bound.seconds < 0 || bound.seconds > audio.end - audio.start) throw new Error('Local activity boundary references an invalid independent audio window');
      const absolute = audio.start + bound.seconds;
      if (key === 'start' ? absolute > reviewedCandidate.start + .5 : absolute < reviewedCandidate.end - .5) {
        throw new Error('Local activity enclosure would omit observed performance');
      }
    }
  }
  return { ...response, text: JSON.stringify(raw) };
}

export function independentRows(evidence: Data): Data[] {
  return evidence.audio.flatMap((a: Data) => a.chunks.map((c: Data) => ({ id: `LOCAL-${a.index}-${c.index}`,
    source: 'audio_transcript', start: a.start + c.start, end: a.start + c.end,
    text: [c.text, ...a.transcript.filter((r: Data) => r.chunkIndex === c.index).map((r: Data) => r.text)].join(' ')})));
}
