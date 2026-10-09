const fs = require('fs');
const os = require('os');
const path = require('path');
const backgroundClipQueue = require('./background_clip_queue');

describe('background_clip_queue', () => {
  let queueDirectory: string;
  const envKeys = [
    'DANMAKU_BACKGROUND_CLIP_QUEUE_DIR',
    'DANMAKU_BACKGROUND_CLIP_QUEUE_ENABLED',
    'DANMAKU_BACKGROUND_CLIP_QUEUE_POLL_MS',
    'DANMAKU_BACKGROUND_CLIP_QUEUE_IDLE_GRACE_MS',
    'DANMAKU_BACKGROUND_CLIP_QUEUE_STALE_LOCK_MS'
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    queueDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'danmaku-background-clip-queue-test-'));
    savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    fs.rmSync(queueDirectory, { recursive: true, force: true });
  });

  function enqueue(id: string) {
    const payloadPath = path.join(queueDirectory, `${id}.payload.json`);
    const logPath = path.join(queueDirectory, `${id}.log`);
    fs.writeFileSync(payloadPath, JSON.stringify({ id }), 'utf8');
    return backgroundClipQueue.enqueueJob({
      payloadPath,
      logPath,
      roomId: id
    }, {
      directory: queueDirectory,
      pollMs: 1,
      idleGraceMs: 0,
      staleLockMs: 1000
    });
  }

  test('serializes jobs even when multiple workers are started together', async () => {
    enqueue('room-one');
    enqueue('room-two');
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const processJob = async (entry: { payloadPath: string }) => {
      const payload = JSON.parse(fs.readFileSync(entry.payloadPath, 'utf8'));
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(payload.id);
      await new Promise(resolve => setTimeout(resolve, 15));
      active -= 1;
    };

    const results = await Promise.all([
      backgroundClipQueue.runQueueWorker({
        directory: queueDirectory,
        pollMs: 1,
        idleGraceMs: 0,
        staleLockMs: 1000
      }, processJob),
      backgroundClipQueue.runQueueWorker({
        directory: queueDirectory,
        pollMs: 1,
        idleGraceMs: 0,
        staleLockMs: 1000
      }, processJob)
    ]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(['room-one', 'room-two']);
    expect(results.reduce((sum, result) => sum + result.processed, 0)).toBe(2);
    expect(backgroundClipQueue.countQueueEntries(queueDirectory)).toBe(0);
  });

  test('requeues a working job left by a worker that exited', async () => {
    const job = enqueue('recovered-room');
    const workingPath = job.pendingPath.replace(/\.pending\.json$/i, '.working.json');
    fs.renameSync(job.pendingPath, workingPath);

    const processed: string[] = [];
    const result = await backgroundClipQueue.runQueueWorker({
      directory: queueDirectory,
      pollMs: 1,
      idleGraceMs: 0,
      staleLockMs: 1000
    }, async entry => {
      processed.push(JSON.parse(fs.readFileSync(entry.payloadPath, 'utf8')).id);
    });

    expect(result.processed).toBe(1);
    expect(processed).toEqual(['recovered-room']);
    expect(fs.existsSync(workingPath)).toBe(false);
    expect(backgroundClipQueue.countQueueEntries(queueDirectory)).toBe(0);
  });

  test('only claims one worker launch marker at a time', () => {
    const first = backgroundClipQueue.claimWorkerLaunch(queueDirectory, 1000);
    const second = backgroundClipQueue.claimWorkerLaunch(queueDirectory, 1000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    first.release();
    const third = backgroundClipQueue.claimWorkerLaunch(queueDirectory, 1000);
    expect(third).not.toBeNull();
    third.commit();
    expect(fs.existsSync(path.join(queueDirectory, 'worker.launch'))).toBe(true);

    return backgroundClipQueue.runQueueWorker({
      directory: queueDirectory,
      pollMs: 1,
      idleGraceMs: 0,
      staleLockMs: 1000
    }, async () => {
      throw new Error('queue should be empty');
    }).then(() => {
      expect(fs.existsSync(path.join(queueDirectory, 'worker.launch'))).toBe(false);
    });
  });

  test('failure survives restart, backs off, and becomes a visible terminal failure after three attempts', async () => {
    const job = enqueue('fails');
    const options = { directory: queueDirectory, pollMs: 1, idleGraceMs: 0, staleLockMs: 1000 };
    const fail = jest.fn(async () => { throw new Error('encoder unavailable'); });
    const run = () => backgroundClipQueue.runQueueWorker(options, fail, { log: () => {} });
    await run();
    expect(fs.existsSync(job.payloadPath)).toBe(true);
    const pending = JSON.parse(fs.readFileSync(job.pendingPath, 'utf8'));
    expect(pending.attempts).toBe(1);
    expect(pending.lastError).toBe('encoder unavailable');
    await run(); expect(fail).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      const next = JSON.parse(fs.readFileSync(job.pendingPath, 'utf8'));
      fs.writeFileSync(job.pendingPath, JSON.stringify({ ...next, nextAttemptAt: 0 }));
      await run();
    }
    expect(fail).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(job.pendingPath)).toBe(false);
    const failed = JSON.parse(fs.readFileSync(job.pendingPath.replace('.pending.', '.failed.'), 'utf8'));
    expect(failed.attempts).toBe(3);
    await run(); expect(fail).toHaveBeenCalledTimes(3);
  });

  test('the same explicit activity identity cannot recreate an already completed job', async () => {
    const payloadPath = path.join(queueDirectory, 'activity.json');
    fs.writeFileSync(payloadPath, '{}');
    const options = { directory: queueDirectory, idleGraceMs: 0 };
    const first = backgroundClipQueue.enqueueJob({ jobId: 'activity-1', payloadPath }, options);
    await backgroundClipQueue.runQueueWorker(options, async () => {});
    const second = backgroundClipQueue.enqueueJob({ jobId: 'activity-1', payloadPath }, options);
    expect(second.jobId).toBe(first.jobId);
    expect(second.status).toBe('done');
    expect(second.reused).toBe(true);
    expect(backgroundClipQueue.countQueueEntries(queueDirectory)).toBe(0);
  });

  test('a replacement worker recovers the same job after the owning process exits without cleanup', async () => {
    const job = enqueue('interrupted');
    const script = `const queue = require(process.argv[1]);
      queue.runQueueWorker({directory: process.argv[2], idleGraceMs: 0, staleLockMs: 1000},
        async () => process.exit(77));`;
    const child = require('child_process').spawnSync(process.execPath,
      ['-e', script, require.resolve('./background_clip_queue'), queueDirectory], { timeout: 10000, windowsHide: true });
    expect(child.status).toBe(77);
    expect(fs.existsSync(job.pendingPath.replace('.pending.', '.working.'))).toBe(true);
    const expired = new Date(Date.now() - 2000);
    fs.utimesSync(path.join(queueDirectory, 'worker.lock'), expired, expired);
    const resumed = jest.fn(async () => {});
    await backgroundClipQueue.runQueueWorker({ directory: queueDirectory, idleGraceMs: 0, staleLockMs: 1000 }, resumed);
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(resumed.mock.calls[0][0].jobId).toBe(job.jobId);
    expect(fs.existsSync(job.pendingPath.replace('.pending.', '.done.'))).toBe(true);
  });
});
