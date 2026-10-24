import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminAsrStatus, asrQueueStatus } from './AdminAsrStatus';
import { atomicJson } from './AdminFiles';

const now = Date.parse('2026-10-24T16:01:00Z');
const task = (id: string, extra = {}) => ({ id, roomId: '100', mediaPath: 'D:\\recordings\\100_测试主播\\2026_10_24\\录制-100-20261024-195854-591-游戏直播_merged.flv',
  status: 'pending', addedTime: now - 600000, ...extra });
const line = (offset: number, text: string) => `${new Date(now + offset).toISOString()} INFO [MikufansSummaryQueueWorker] [Mikufans队列Worker] ${text}`;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('matches worker priority and FIFO ordering, including legacy room defaults and tie breaking', () => {
  const result = asrQueueStatus({ tasks: [task('z'), task('b'), task('a'), task('sui', { roomId: '25788785' }),
    task('explicit', { priority: 200 }), task('configured', { roomId: '101' }), task('done', { status: 'completed' }), task('failed', { status: 'failed' })] }, '',
  { ai: { roomSettings: { '101': { whisperPriority: 150 } } } }, now);
  expect(result.queue.map(row => row.id)).toEqual(['explicit', 'configured', 'sui', 'a', 'b', 'z']);
  expect(result.queue.map(row => row.position)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(result).toMatchObject({ activeJobs: 0, queuedJobs: 6, failedJobs: 1 });
  expect(result.queue[3]).toMatchObject({ streamerName: '测试主播', title: '游戏直播', recordedAt: '2026-10-24T19:58:54+08:00', waitSeconds: 600 });
});

it('shows actual CPU progress and elapsed time without exposing logs, paths or model credentials', () => {
  const running = task('current', { status: 'processing', startTime: now - 300000, ownerPid: 123 });
  const log = [line(-400000, '开始 ASR batch (GPU) #99'), line(-60000, '[ASR] GPU 繁忙：使用低优先级 CPU ASR（2 线程）'),
    line(-5000, '[ASR] 开始 ASR batch (CPU) #3355'), line(-1000, 'Authorization: Bearer secret-token')].join('\n');
  const result = asrQueueStatus({ tasks: [task('waiting'), running] }, log, { asr: { cpu_fallback: { enabled: true } } }, now, () => true);
  expect(result.queue[0]).toMatchObject({ id: 'current', ownerAlive: true, waitSeconds: 300, elapsedSeconds: 300,
    activity: { device: 'cpu', phase: '转写中', batch: 3355, stale: false } });
  expect(result.policy).toMatchObject({ cpuFallbackEnabled: true, minAvailableMemoryGb: 10 });
  expect(JSON.stringify(result)).not.toMatch(/secret-token|D:|Authorization/);
  expect(result.queue[1].activity).toBeUndefined();
});

it('tracks device changes from evidence and labels old progress instead of inventing a percentage', () => {
  const running = task('current', { status: 'processing', startTime: now - 600000 });
  const log = [line(-500000, '[ASR] 开始 ASR batch (CPU) #1'), line(-240000, '[ASR] 开始 ASR batch (GPU) #2')].join('\n');
  expect(asrQueueStatus({ tasks: [running] }, log, {}, now).queue[0].activity)
    .toMatchObject({ device: 'gpu', batch: 2, stale: true });
});

it('tracks segmented device handoff and checkpoints without carrying forward an old batch', () => {
  const running = task('current', { status: 'processing', startTime: now - 600000 });
  const log = [line(-10000, '开始 ASR batch (CPU) #20'), line(-2000, 'ASR 分段接力: cpu → cuda，剩余 800.0s 音频')].join('\n');
  expect(asrQueueStatus({ tasks: [running] }, log, {}, now).queue[0].activity)
    .toMatchObject({ device: 'gpu', phase: '切换转写设备', batch: undefined, stale: false });
  expect(asrQueueStatus({ tasks: [running] }, log + '\n' + line(-1000, 'ASR 接力已保存: 600.0/1400.0s，device=cuda'), {}, now).queue[0].activity)
    .toMatchObject({ device: 'gpu', phase: '已保存分段进度', stale: false });
});

it('does not attribute prior, future, unrelated or another invocation logs to a running task', () => {
  const running = task('current', { status: 'processing', startTime: now - 10000 });
  const log = [line(-11000, '开始 ASR batch (CPU) #90'), line(-9000, 'ASR module CPU secret'),
    line(-8000, 'Mikufans队列Worker开始执行: other.flv (taskId=other)'), line(-1000, '开始 ASR batch (GPU) #99'), line(6000, '开始 ASR batch (CPU) #100')].join('\n');
  expect(asrQueueStatus({ tasks: [running] }, log, {}, now).queue[0].activity).toBeUndefined();
  expect(asrQueueStatus({ tasks: [running, task('other', { status: 'processing', startTime: now - 10000 })] }, log, {}, now).queue.every(row => !row.activity)).toBe(true);
});

it('separates completed ASR with ongoing downstream work from the next transcription', () => {
  const first = task('first', { status: 'processing', startTime: now - 300000 });
  const second = task('second', { status: 'processing', startTime: now - 10000 });
  const log = [line(-20000, '开始 ASR batch (CPU) #99'),
    line(-11000, '[[ASR_PHASE_DONE]] taskId=first media=first.flv'),
    line(-10000, 'Mikufans队列Worker开始执行: second.flv (taskId=second)'),
    line(-1000, '开始 ASR batch (GPU) #1')].join('\n');
  const result = asrQueueStatus({ tasks: [first, second] }, log, {}, now);
  expect(result.queue.map(row => row.id)).toEqual(['second', 'first']);
  expect(result.queue[0].activity).toMatchObject({ device: 'gpu', batch: 1 });
  expect(result.queue[1].activity).toMatchObject({ device: 'cpu', asrCompleted: true, phase: '字幕已生成，后续处理中' });
  expect(asrQueueStatus({ tasks: [first, second] }, line(-1000, '开始 ASR batch (GPU) #1'), {}, now).queue[1].activity).toBeUndefined();
});

it('reports a dead owner and missing logs without presenting stale device evidence as current execution', () => {
  const running = task('current', { status: 'processing', startTime: now - 10000, ownerPid: 123 });
  const result = asrQueueStatus({ tasks: [running] }, line(-1000, '开始 ASR batch (CPU) #1'), {}, now, () => false);
  expect(result.queue[0]).toMatchObject({ ownerAlive: false });
  expect(result.queue[0].activity).toBeUndefined();
  expect(asrQueueStatus({ tasks: [running] }, undefined, {}, now).logAvailable).toBe(false);
});

it('reads a bounded log tail and existing queue without modifying either or loading the queue singleton', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-asr-')); roots.push(root);
  const queueFile = path.join(root, 'queue.json'), logFile = path.join(root, 'worker.log');
  atomicJson(queueFile, { tasks: [task('current', { status: 'processing', startTime: now - 10000 })] });
  atomicJson(path.join(root, 'config/default.json'), { asr: { cpu_fallback: { enabled: false, min_available_memory_gb: 20 } } });
  atomicJson(path.join(root, 'config/production.json'), { asr: { cpu_fallback: { enabled: true }, device_handoff: { enabled: true } } });
  fs.writeFileSync(logFile, 'x'.repeat(400000) + '\n' + line(-1000, '开始 ASR batch (CPU) #42'));
  const before = fs.readFileSync(queueFile, 'utf8'), logSize = fs.statSync(logFile).size;
  const result = new AdminAsrStatus(root, { queueFile, logFile, now: () => now }).status();
  expect(result.queue[0].activity?.batch).toBe(42);
  expect(result.policy).toMatchObject({ cpuFallbackEnabled: true, minAvailableMemoryGb: 10, deviceHandoffEnabled: true });
  expect(fs.readFileSync(queueFile, 'utf8')).toBe(before);
  expect(fs.statSync(logFile).size).toBe(logSize);
  expect(Object.keys(require.cache).some(file => /whisper_queue_manager\.[jt]s$/u.test(file))).toBe(false);
});

it('uses the worker production file selection rather than inheriting omitted defaults', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-asr-')); roots.push(root);
  const queueFile = path.join(root, 'queue.json'), reader = new AdminAsrStatus(root, { queueFile });
  atomicJson(queueFile, { tasks: [] });
  atomicJson(path.join(root, 'config/default.json'), { asr: { cpu_fallback: { enabled: true }, device_handoff: { enabled: true } } });
  expect(reader.status().policy.cpuFallbackEnabled).toBe(true);
  atomicJson(path.join(root, 'config/production.json'), { asr: { cpu_fallback: { enabled: true } } });
  expect(reader.status().policy).toMatchObject({ cpuFallbackEnabled: true, deviceHandoffEnabled: false });
});

it('distinguishes missing or corrupt queues from an empty queue and tolerates an unavailable log', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-asr-')); roots.push(root);
  const queueFile = path.join(root, 'queue.json'), reader = new AdminAsrStatus(root, { queueFile });
  expect(() => reader.status()).toThrow('字幕队列暂时无法读取');
  fs.writeFileSync(queueFile, '{'); expect(() => reader.status()).toThrow('字幕队列暂时无法读取');
  atomicJson(queueFile, {}); expect(() => reader.status()).toThrow('字幕队列数据无效');
  atomicJson(queueFile, { tasks: [] }); expect(reader.status()).toMatchObject({ activeJobs: 0, queuedJobs: 0, logAvailable: false });
});

const statusLine = (offset: number, done: number, extra = {}) => line(offset, '[[ASR_HANDOFF_STATUS]] ' + JSON.stringify({
  device: 'cuda', state: 'running', audio_done_s: done, audio_total_s: 10000, window_s: 120, batch_size_s: 600, ...extra,
}));

it('measures committed audio across a continuous device interval and estimates only after sixty seconds', () => {
  const running = task('current', { status: 'processing', startTime: now - 600000 });
  const log = [statusLine(-120000, 1000), statusLine(-90000, 4000), statusLine(-60000, 7000)].join('\n');
  const result = asrQueueStatus({ tasks: [running] }, log, {}, now);
  expect(result.queue[0].activity?.progress).toMatchObject({ audioDoneSeconds: 7000, audioTotalSeconds: 10000,
    percent: 70, performanceTier: 'gpu_throughput', windowSeconds: 120, batchSeconds: 600,
    speedX: 100, speedWindowSeconds: 60, speedProvisional: false, etaSeconds: 30 });
  const warming = [statusLine(-20000, 1000), statusLine(-10000, 2000), statusLine(0, 3000)].join('\n');
  expect(asrQueueStatus({ tasks: [running] }, warming, {}, now).queue[0].activity?.progress)
    .toMatchObject({ speedX: 100, speedProvisional: true });
  expect(asrQueueStatus({ tasks: [running] }, warming, {}, now).queue[0].activity?.progress?.etaSeconds).toBeUndefined();
});

it('resets speed for switching, interruption, replay, waiting, changed totals and postprocessing', () => {
  const running = task('current', { status: 'processing', startTime: now - 600000 });
  const stable = [statusLine(-120000, 1000), statusLine(-90000, 4000), statusLine(-60000, 7000)].join('\n');
  for (const last of [statusLine(0, 7000, { device: 'cpu', batch_size_s: 30 }), statusLine(0, 6000),
    statusLine(0, 7000, { state: 'waiting' }), statusLine(0, 7000, { state: 'loading' }),
    statusLine(0, 7000, { performance_tier: 'gpu_low_impact', batch_size_s: 30 }),
    statusLine(0, 7000, { audio_total_s: 20000 }), statusLine(0, 10000, { state: 'postprocessing' }),
    line(0, 'ASR 接力中断: device=cuda, target=cpu, replay_from=7000.0s')]) {
    const progress = asrQueueStatus({ tasks: [running] }, `${stable}\n${last}`, {}, now).queue[0].activity?.progress;
    expect(progress?.speedX).toBeUndefined();
    expect(progress?.etaSeconds).toBeUndefined();
  }
});

it('tolerates malformed telemetry and shows old committed progress without stale speed or fabricated policy', () => {
  const running = task('current', { status: 'processing', startTime: now - 600000 });
  const log = [line(-240000, 'ASR 接力已保存: 1000.0/10000.0s，device=cuda'),
    line(-210000, 'ASR 接力已保存: 4000.0/10000.0s，device=cuda'), line(-180000, 'ASR 接力已保存: 7000.0/10000.0s，device=cuda'),
    statusLine(-1000, -1), statusLine(-1000, 10001), statusLine(-1000, 100, { device: 'secret-token' }),
    line(-1000, '[[ASR_HANDOFF_STATUS]] {invalid}')].join('\n');
  const activity = asrQueueStatus({ tasks: [running] }, log, {}, now).queue[0].activity;
  expect(activity).toMatchObject({ stale: true, progress: { percent: 70 } });
  expect(activity?.progress?.speedX).toBeUndefined();
  expect(activity?.progress?.windowSeconds).toBeUndefined();
  expect(JSON.stringify(activity)).not.toContain('secret-token');
});

it('structured cumulative progress wins over timeline offsets when resuming cached holes', () => {
  const running = task('current', { status: 'processing', startTime: now - 600000 });
  const log = [statusLine(-10000, 5000), line(-1000, 'ASR 接力已保存: 120.0/10000.0s，device=cuda'), statusLine(-1000, 5120)].join('\n');
  expect(asrQueueStatus({ tasks: [running] }, log, {}, now).queue[0].activity?.progress)
    .toMatchObject({ audioDoneSeconds: 5120, percent: 51.2 });
});

it('excludes cold model loading and reused audio from the running speed baseline', () => {
  const running = task('current', { status: 'processing', startTime: now - 600000 });
  const log = [statusLine(-180000, 5000, { state: 'loading' }), statusLine(-60000, 5120),
    statusLine(-30000, 8120), statusLine(0, 10000, { audio_total_s: 10000 })].join('\n');
  expect(asrQueueStatus({ tasks: [running] }, log, {}, now).queue[0].activity?.progress)
    .toMatchObject({ speedX: 4880 / 60, speedWindowSeconds: 60 });
});
