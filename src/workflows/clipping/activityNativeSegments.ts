import * as path from 'path';

type Data = Record<string, any>;

export function reusableNativeListening(batch: Data, packet: Data, source: Data, references: Data[], model: string, io: {
  digest(file: string): string; read(file: string): Data;
}): Data | null {
  const inputs = [...packet.audio, ...packet.frames].map(input => ({ path: input.path, sha256: io.digest(input.path),
    ...(input.start !== undefined ? { start: input.start, end: input.end } : { time: input.time, activityId: input.activityId }) }));
  for (const reference of references) {
    try {
      if (io.digest(reference.path) !== reference.sha256) continue;
      const value = io.read(reference.path);
      if (value.protocolVersion !== 3 || value.response?.meta?.model !== model
        || JSON.stringify(value.source) !== JSON.stringify(source) || JSON.stringify(value.inputs) !== JSON.stringify(inputs)
        || JSON.stringify(value.observations.map((row: Data) => row.id).sort()) !== JSON.stringify(batch.events.map((row: Data) => row.event.id).sort())
        || value.segments.listening.inputs.some((input: Data) => io.digest(input.path) !== input.sha256)) continue;
      return value;
    } catch { /* Missing or changed media requires a fresh observation. */ }
  }
  return null;
}

/** Keep the original decoder packet intact while giving the listener short clocks. */
export async function prepareSegmentedListening(batch: Data, packet: Data, source: Data, directory: string, io: {
  extract(file: string, start: number, end: number): Promise<void>;
  digest(file: string): string;
  listen(batch: Data, packet: Data, source: Data): Promise<Data>;
}): Promise<Data> {
  const originalInputs = [...packet.audio, ...packet.frames].map(input => ({ path: input.path, sha256: io.digest(input.path),
    ...(input.start !== undefined ? { start: input.start, end: input.end } : { time: input.time, activityId: input.activityId }) }));
  const segments: Data[] = [];
  for (const [index, audio] of packet.audio.entries()) {
    if (!Number.isFinite(audio.start) || !Number.isFinite(audio.end) || audio.end <= audio.start) throw new Error('Invalid listening audio span');
    for (let start = audio.start; start < audio.end; start += 60) {
      const end = Math.min(start + 60, audio.end);
      const file = path.join(directory, `listening-${segments.length + 1}.mp3`);
      await io.extract(file, start, end);
      segments.push({ path: file, mimeType: 'audio/mpeg', start, end, originalAudioIndex: index + 1 });
    }
  }
  const segmentBatch = { ...batch, events: batch.events.map((row: Data) => ({ ...row,
    audioIndices: segments.flatMap((s, i) => row.audioIndices.includes(s.originalAudioIndex) ? [i + 1] : []) })) };
  const listening = await io.listen(segmentBatch, { audio: segments, frames: packet.frames, segmented: true }, source);
  const observations = listening.observations.map((observation: Data) => {
    const candidate = segmentBatch.events.find((row: Data) => row.event.id === observation.id);
    const seen = new Set(observation.chronology.map((phase: Data) => phase.audioIndex));
    if (candidate.audioIndices.some((index: number) => !seen.has(index))) throw new Error('Segmented listening omitted original audio');
    return { ...observation, chronology: observation.chronology.map((phase: Data) => {
      const segment = segments[phase.audioIndex - 1], original = packet.audio[segment.originalAudioIndex - 1];
      return { ...phase, audioIndex: segment.originalAudioIndex,
        start: segment.start - original.start + phase.start, end: segment.start - original.start + phase.end };
    }) };
  });
  if (originalInputs.some(input => io.digest(input.path) !== input.sha256)) throw new Error('Native listening source changed');
  return { version: 1, protocolVersion: 3, source, inputs: originalInputs, response: listening.response, observations,
    segments: { audio: segments.map(({ path: file, start, end, originalAudioIndex }) => ({ path: file, start, end, originalAudioIndex })), listening } };
}
