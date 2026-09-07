const fs = require('fs');
const os = require('os');
const path = require('path');
const { runComicWithConcurrentClips, resolveComicSourceVideo, automaticComicOptions } = require('./pipeline');

describe('comic and clip scheduling', () => {
  test('preserves the original room-specific image retry options', () => {
    expect(automaticComicOptions('25788785')).toEqual({ tuziRetryMaxAttempts: 4, tuziBypassCooldown: false,
      tuziRetryMaxTotalSeconds: 1500, tuziRetryMaxCooldownWaitSeconds: 300,
      tuziSkipChatFallbackOnImageApiFailure: true, allowComicScriptFallback: true });
    expect(automaticComicOptions('other')).toEqual({ tuziRetryMaxAttempts: 2, tuziBypassCooldown: false });
  });

  test('resolves the same video while excluding processed audio and ambiguous sources', () => {
    const isAudio = file => file.endsWith('.m4a');
    expect(resolveComicSourceVideo(['/data/a.flv', '/data/b.flv', '/data/a.m4a'], '/data/a.speaker_AI_HIGHLIGHT.txt', isAudio)).toBe('/data/a.flv');
    expect(resolveComicSourceVideo(['/data/a.flv', '/data/b.flv'], '/data/missing_AI_HIGHLIGHT.txt', isAudio)).toBeNull();
    expect(resolveComicSourceVideo(['/data/a.flv'], '/data/other_AI_HIGHLIGHT.txt', isAudio)).toBe('/data/a.flv');
  });

  test('starts clips before summary preparation without deleting the comic input', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'comic-overlap-'));
    const source = path.join(directory, 'source.flv');
    fs.writeFileSync(source, 'original video bytes');
    const events = [];
    let alias;
    const onSchedule = jest.fn();
    const startClips = jest.fn(async () => { events.push('clips'); fs.unlinkSync(source); });
    try {
      const result = await runComicWithConcurrentClips({ sourceVideoPath: source, tempRoot: path.join(directory, 'temp'),
        overlapEnabled: true, startClips, log: jest.fn(), onSchedule,
        prepareComic: async () => { events.push('summary'); expect(fs.existsSync(source)).toBe(false); },
        generateComic: async options => {
          events.push('comic'); alias = options.sourceVideoPath;
          expect(fs.readFileSync(alias, 'utf8')).toBe('original video bytes');
          await options.onComicScriptReady();
          await options.onComicScriptReady();
          return 'image.png';
        } });
      expect(result).toBe('image.png');
      expect(events).toEqual(['clips', 'summary', 'comic']);
      expect(startClips).toHaveBeenCalledTimes(1);
      expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ requestedOverlap: true, overlapUsed: true,
        clipLaunchRequestedAt: expect.any(String), comicPreparationMs: expect.any(Number), comicGenerationMs: expect.any(Number) }));
      expect(fs.existsSync(alias)).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test.each([false, true])('keeps the original schedule when disabled or retaining input fails: %s', async overlapEnabled => {
    const events = [];
    const retainSource = jest.fn().mockResolvedValue(null);
    const startClips = jest.fn(async () => { events.push('clips'); });
    await runComicWithConcurrentClips({ overlapEnabled, retainSource, sourceVideoPath: 'video.flv', tempRoot: 'temp', startClips,
      prepareComic: async () => { events.push('summary'); },
      generateComic: async options => {
        events.push('comic');
        expect(options.sourceVideoPath).toBe('video.flv');
        await options.onComicScriptReady();
        return 'image.png';
      } });
    expect(events).toEqual(['summary', 'comic', 'clips']);
    expect(retainSource).toHaveBeenCalledTimes(overlapEnabled ? 1 : 0);
  });

  test.each(['prepare', 'generate'])('releases the alias on %s failure', async phase => {
    const retained = { path: 'retained.flv', release: jest.fn(), readerStarting: jest.fn(), registerReader: jest.fn() };
    await expect(runComicWithConcurrentClips({ overlapEnabled: true, sourceVideoPath: 'source.flv',
      retainSource: async () => retained, startClips: jest.fn(),
      prepareComic: async () => { if (phase === 'prepare') throw new Error('summary failed'); },
      generateComic: async () => { throw new Error('image failed'); } })).rejects.toThrow('failed');
    expect(retained.release).toHaveBeenCalledTimes(1);
  });

  test('returns to the old sequence if registering the pending launch fails', async () => {
    const retained = { path: 'alias.flv', release: jest.fn(), readerStarting() { throw new Error('disk failed'); } };
    const events = [];
    await runComicWithConcurrentClips({ overlapEnabled: true, sourceVideoPath: 'source.flv', log: jest.fn(),
      retainSource: async () => retained, startClips: () => { events.push('clips'); },
      prepareComic: () => { events.push('prepare'); }, generateComic: async options => {
        events.push('comic'); expect(options.sourceVideoPath).toBe('source.flv');
        await options.onComicScriptReady();
      } });
    expect(events).toEqual(['prepare', 'comic', 'clips']);
    expect(retained.release).toHaveBeenCalledTimes(1);
  });

  test('records fallback explicitly and does not let metrics failure change the comic result', async () => {
    const onSchedule = jest.fn(() => { throw new Error('log failed'); });
    const result = await runComicWithConcurrentClips({ overlapEnabled: true, sourceVideoPath: 'source.flv', log: jest.fn(),
      retainSource: async () => null, startClips: jest.fn(), prepareComic: jest.fn(),
      generateComic: async options => { await options.onComicScriptReady(); return 'image.png'; }, onSchedule });
    expect(result).toBe('image.png');
    expect(onSchedule).toHaveBeenCalledWith(expect.objectContaining({ requestedOverlap: true, overlapUsed: false }));
  });

  test('clip startup failure does not suppress the comic and reader registration is forwarded', async () => {
    const retained = { path: 'retained.flv', release: jest.fn(), readerStarting: jest.fn(), registerReader: jest.fn() };
    const result = await runComicWithConcurrentClips({ overlapEnabled: true, sourceVideoPath: 'source.flv', log: jest.fn(),
      retainSource: async () => retained, startClips: async () => { throw new Error('worker failed'); },
      prepareComic: jest.fn(), generateComic: async options => { options.onProcessStarted(123); return 'image.png'; } });
    expect(result).toBe('image.png');
    expect(retained.readerStarting).toHaveBeenCalledTimes(1);
    expect(retained.registerReader).toHaveBeenCalledWith(123);
    expect(retained.release).toHaveBeenCalledTimes(1);
  });

  test('replays the measured wait removal without claiming model or rendering speed changes', async () => {
    jest.useFakeTimers();
    const durations = { summary: 71609, script: 95409, image: 140284, clips: 2357706 };
    const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const replay = async overlapEnabled => {
      jest.setSystemTime(0);
      const times: any = {};
      let clipTask;
      const startClips = jest.fn(() => {
        times.clipStart = Date.now();
        clipTask = wait(durations.clips).then(() => { times.clipEnd = Date.now(); });
      });
      const run = runComicWithConcurrentClips({ overlapEnabled, sourceVideoPath: 'source.flv',
        retainSource: async () => ({ path: 'alias.flv', readerStarting() {}, registerReader() {}, release() {} }),
        startClips, prepareComic: () => wait(durations.summary), generateComic: async options => {
          await wait(durations.script);
          await options.onComicScriptReady();
          await wait(durations.image);
          times.imageEnd = Date.now();
          return 'unchanged image';
        } }).then(async result => { await clipTask; return result; });
      await jest.advanceTimersByTimeAsync(3000000);
      expect(await run).toBe('unchanged image');
      expect(startClips).toHaveBeenCalledTimes(1);
      return times;
    };
    try {
      const sequential = await replay(false);
      const overlapping = await replay(true);
      expect(sequential.clipStart).toBe(167018);
      expect(overlapping.clipStart).toBe(0);
      expect(sequential.clipEnd - overlapping.clipEnd).toBe(167018);
      expect(overlapping.imageEnd).toBe(sequential.imageEnd);
    } finally { jest.useRealTimers(); }
  });
});
