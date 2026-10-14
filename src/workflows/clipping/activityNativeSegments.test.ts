import { prepareSegmentedListening, reusableNativeListening } from './activityNativeSegments';
import { prepareNativeListening } from './activityAudio';

test('short listening clocks map back without losing context or redecoding the original packet', async () => {
  const packet = { audio: [{ path: 'original', start: 100, end: 225 }], frames: [] };
  const batch = { events: [{ event: { id: 'song' }, audioIndices: [1] }] };
  const raw = { timeBasis: 'audio_local_seconds', observations: [{ id: 'song', ownership: 'mixed', chronology: [
    { audioIndex: 1, start: 0, end: 60, kind: 'playback' },
    { audioIndex: 2, start: 0, end: 60, kind: 'host_singing' },
    { audioIndex: 3, start: 0, end: 5, kind: 'speech' }
  ] }] };
  const request = jest.fn(async () => ({ text: JSON.stringify(raw) }));
  const digest = () => 'digest', extract = jest.fn(async () => {});
  const io = { digest, extract, listen: (b: any, p: any, s: any) => prepareNativeListening(b, p, s, { request, digest }) };
  const result = await prepareSegmentedListening(batch, packet, {}, 'scratch', io);
  expect(extract.mock.calls.map(call => (call as any[]).slice(1))).toEqual([[100, 160], [160, 220], [220, 225]]);
  expect(result.observations[0].chronology.map((p: any) => [p.audioIndex, p.start, p.end])).toEqual([[1, 0, 60], [1, 60, 120], [1, 120, 125]]);
  expect(packet.audio).toEqual([{ path: 'original', start: 100, end: 225 }]);
  expect(result.segments.listening.observations).toEqual(raw.observations);
  result.response.meta = { model: 'listener' };
  const references = [{ path: 'evidence', sha256: 'digest' }];
  const cache = { digest, read: () => result };
  expect(reusableNativeListening(batch, packet, {}, references, 'listener', cache)).toBe(result);
  expect(reusableNativeListening(batch, packet, { changed: true }, references, 'listener', cache)).toBeNull();
  expect(reusableNativeListening(batch, packet, {}, references, 'other-model', cache)).toBeNull();
  expect(reusableNativeListening(batch, packet, {}, references, 'listener', { ...cache,
    digest: file => file.includes('listening-') ? 'changed' : 'digest' })).toBeNull();
  raw.observations[0].chronology.pop();
  await expect(prepareSegmentedListening(batch, packet, {}, 'scratch', io)).rejects.toThrow('omitted original audio');
  raw.observations[0].chronology[1].end = 61;
  await expect(prepareSegmentedListening(batch, packet, {}, 'scratch', io)).rejects.toThrow('outside');
});
