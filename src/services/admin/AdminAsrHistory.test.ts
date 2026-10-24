import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { asrHistoryMetrics, readAsrHistory } from './AdminAsrHistory';
import { atomicJson } from './AdminFiles';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('counts only newly processed audio and separates tiers, transcription wall time and postprocessing', () => {
  const result = asrHistoryMetrics({ elapsedSeconds: 300, mediaDurationSeconds: 10000,
    stageTimings: { handoff_cpu_audio_s: 1000, handoff_gpu_audio_s: 5000, handoff_reused_audio_s: 4000,
      handoff_gpu_low_impact_audio_s: 2000, handoff_gpu_low_impact_window_s: 80, handoff_gpu_low_impact_batch_s: 30,
      handoff_gpu_throughput_audio_s: 3000, handoff_gpu_throughput_window_s: 30,
      handoff_transcription_s: 200, speaker_total_s: 80 }, speakerProcessing: { status: 'success' } });
  expect(result).toMatchObject({ speedX: 30, elapsedSeconds: 300, transcriptionSeconds: 200, reusedSeconds: 4000, speakerState: 'processed', speakerSeconds: 80 });
  expect(result.tiers.map(tier => [tier.tier, tier.speedX])).toEqual([
    ['cpu_background', undefined], ['gpu_low_impact', 25], ['gpu_throughput', 100] ]);
});

it('does not invent legacy device/tier or use full duration to inflate resumed speed', () => {
  expect(asrHistoryMetrics({ mediaDurationSeconds: 10000, elapsedSeconds: 10, backend: 'paraformer' })).toMatchObject({ tiers: [], speedX: undefined, speakerState: 'unknown' });
  expect(asrHistoryMetrics({ stageTimings: { handoff_gpu_audio_s: 500, handoff_cpu_audio_s: 0, handoff_gpu_window_s: 10,
    handoff_transcription_s: 20, handoff_reused_audio_s: 9500 }, speakerProcessing: { status: 'disabled' } }))
    .toMatchObject({ speedX: 25, speakerState: 'skipped', tiers: [{ tier: 'gpu_unknown', speedX: 50 }] });
});

it('reads bounded queue-linked sidecars without exposing paths or touching queue and metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-history-')); roots.push(root);
  const recording = path.join(root, '100_主播'), outside = path.join(root, 'outside'); fs.mkdirSync(recording); fs.mkdirSync(outside);
  const queue = path.join(root, 'queue.json'), meta = path.join(recording, '场次.asr_meta.json');
  atomicJson(meta, { elapsedSeconds: 10, secret: 'private-token', generatedAt: '2026-10-24T00:00:00Z' });
  atomicJson(path.join(outside, 'private.asr_meta.json'), { elapsedSeconds: 99 });
  const task = (id: string, file: string, completedTime: number) => ({ id, mediaPath: file, status: 'completed', roomId: '100', completedTime });
  atomicJson(queue, { tasks: [task('known', path.join(recording, '场次.flv'), 3), task('missing', path.join(recording, 'missing.flv'), 2),
    task('outside', path.join(outside, 'private.flv'), 1), { id: 'pending', status: 'pending' }] });
  const before = fs.readFileSync(queue, 'utf8'), metaBefore = fs.readFileSync(meta, 'utf8');
  const result = readAsrHistory(queue, [recording], 1, 2);
  expect(result).toMatchObject({ total: 3, page: 1, pageSize: 2, items: [{ id: 'known', metadata: 'available', elapsedSeconds: 10, streamerName: '主播' }, { id: 'missing', metadata: 'missing' }] });
  expect(readAsrHistory(queue, [recording], 2, 2).items[0]).toMatchObject({ id: 'outside', metadata: 'unavailable' });
  expect(JSON.stringify(result)).not.toMatch(/private-token|asr_meta|mediaPath/);
  expect(fs.readFileSync(queue, 'utf8')).toBe(before); expect(fs.readFileSync(meta, 'utf8')).toBe(metaBefore);
  for (const page of [0, -1, 'oops', 10001]) expect(() => readAsrHistory(queue, [recording], page)).toThrow('历史分页参数无效');
  expect(() => readAsrHistory(queue, [recording], 1, 51)).toThrow('历史分页参数无效');
  fs.writeFileSync(meta, '{'); expect(readAsrHistory(queue, [recording]).items[0].metadata).toBe('unavailable');
  fs.writeFileSync(queue, '{'); expect(() => readAsrHistory(queue, [recording])).toThrow('字幕历史暂时无法读取');
});
