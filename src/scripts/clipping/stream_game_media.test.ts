const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { renderGamePart } = require('./stream_game_media');
const { detectGames } = require('./stream_game_clipper');
const { sourceSnapshot } = require('./source_snapshot');
const { getGameConfig } = require('./stream_game_plan');
const { renderGames } = require('./stream_game_render');
const { PROTOCOL_VERSION } = require('./stream_game_verification');
const execFileAsync = promisify(execFile);

describe('game cuts preserve original media and publication identity', () => {
  test('an unpublished approved event can be re-reviewed, while completed media keeps its submission identity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-draft-review-'));
    try {
      const mediaPath = path.join(dir, 'source.flv'), srtPath = path.join(dir, 'source.srt');
      fs.writeFileSync(mediaPath, 'original recording');
      fs.writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:03,000\n我要打开游戏了\n');
      const source = sourceSnapshot({ source: { mediaPath, srtPath } });
      const event = { id: 'game-1', gameId: 'elden-ring', start: 1, end: 30, chapters: [],
        verification: { version: 4, protocolVersion: PROTOCOL_VERSION, evidenceMethod: 'independent_local_asr', decision: 'keep' } };
      const verify = jest.fn(async () => ({ decision: 'uncertain', reason: 'Revised draft still requires original evidence' }));
      const options = { mediaPath, srtPath, config: {}, reviewEventIds: ['game-1'], verify, registerUpload: false,
        boundaryEvidenceMethod: 'independent_local_asr',
        capabilities: { collectionAllowed: true, externalSubtitlesAllowed: true } };
      const files = { directory: dir, plan: path.join(dir, 'PLAN.json') }, config = getGameConfig({});
      const plan = { source, events: [event], status: 'planned' };
      await expect(renderGames(plan, options, config, files)).rejects.toThrow(/Revised draft still requires original evidence/);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fs.readFileSync(files.plan, 'utf8')).events[0].verification.decision).toBe('uncertain');
      verify.mockClear();
      const manifestPath = path.join(dir, 'UPLOAD_MANIFEST.json'), metadataPath = path.join(dir, 'bundle.json');
      fs.writeFileSync(metadataPath, JSON.stringify({ output: { parts: [{ mediaPath: 'kept.mp4' }] } }));
      fs.writeFileSync(manifestPath, JSON.stringify({ clips: [{ metadataPath }] }));
      const complete = { ...plan, status: 'rendered', uploadManifestPath: manifestPath, uploadIds: [123] };
      expect(await renderGames(complete, options, config, files)).toMatchObject({ status: 'rendered', uploadIds: [123] });
      expect(verify).not.toHaveBeenCalled();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('real H264/AAC cuts at non-keyframe timestamps keep source frames without re-encoding', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-original-copy-'));
    const runFfmpeg = (args: string[]) => execFileAsync('ffmpeg', args, { windowsHide: true, timeout: 30000 });
    try {
      const source = path.join(dir, 'source.mp4');
      await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30', '-f', 'lavfi', '-i',
        'sine=frequency=1000:sample_rate=48000', '-t', '4.4', '-c:v', 'libx264', '-threads', '1', '-g', '90',
        '-c:a', 'aac', source]);
      for (const [i, start] of [.47, 2.17].entries()) {
        const result = await renderGamePart(source, { start, end: start + 1.7, duration: 1.7 }, path.join(dir, `p${i}.mp4`),
          { audio: { ffmpeg: { path: 'ffmpeg' } }, streamGameClips: { requireOriginalStreamCopy: true } }, { mode: 'idle' }, { runFfmpeg,
            renderFallback: () => { throw new Error('This valid cut must retain the original bitstream'); } });
        expect(result.processing).toMatchObject({ originalStreamCopy: true, videoEncoder: 'copy', audioEncoder: 'copy' });
        expect(Math.abs(result.actualDuration - 1.7)).toBeLessThanOrEqual(.25);
        expect(result.burnedSubtitles).toBe(false);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);

  test.each(['copy failure', 'duration mismatch', 'opening mismatch'])('required original streams stop on %s without re-encoding', async (failure: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-copy-required-'));
    try {
      const outputPath = path.join(dir, 'part.mp4');
      const renderFallback = jest.fn();
      const runFfmpeg = jest.fn(async (args: string[]) => {
        if (failure === 'copy failure') throw new Error('Original stream cannot be muxed');
        const destination = args.at(-1)!;
        fs.writeFileSync(destination, args.includes('framemd5')
          ? `0, 0, 0, 1, 100, ${destination.endsWith('.source.framemd5') ? 'source' : 'different'}\n`
          : 'original stream');
      });
      const result = renderGamePart('source.flv', { start: 10, duration: 20 }, outputPath,
        { streamGameClips: { requireOriginalStreamCopy: true } }, { mode: 'idle' },
        { runFfmpeg, probe: async () => failure === 'duration mismatch' ? 22 : 20, renderFallback });
      await expect(result).rejects.toMatchObject({ code: 'GAME_ORIGINAL_STREAM_COPY_REQUIRED',
        cause: expect.any(Error), message: expect.stringContaining('forbids re-encoding') });
      expect(renderFallback).not.toHaveBeenCalled();
      expect(runFfmpeg.mock.calls.every(([args]) => !args.includes('h264_nvenc') && !args.includes('libx264'))).toBe(true);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('configurations allowing re-encoding retain the existing fallback and its failure reason', async () => {
    const failure = new Error('Original stream cannot be muxed');
    const renderFallback = jest.fn(async () => ({ processing: { videoEncoder: 'h264_nvenc' } }));
    const result = await renderGamePart('source.flv', { start: 10, duration: 20 }, 'part.mp4',
      { streamGameClips: { requireOriginalStreamCopy: false } }, { mode: 'idle' },
      { runFfmpeg: async () => { throw failure; }, renderFallback });
    expect(renderFallback).toHaveBeenCalledTimes(1);
    expect(result.processing).toMatchObject({ videoEncoder: 'h264_nvenc', originalStreamCopy: false,
      copyFallbackReason: failure.message });
  });

  test('changing subtitles cannot create another submission for an already rendered recording', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-publication-identity-'));
    try {
      const mediaPath = path.join(dir, 'source.flv'), srtPath = path.join(dir, 'source.srt'), planPath = path.join(dir, 'PLAN.json');
      fs.writeFileSync(mediaPath, 'original recording');
      fs.writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:03,000\n我要打开游戏了\n');
      const original = sourceSnapshot({ source: { mediaPath, srtPath } });
      const old = { status: 'rendered', source: original, uploadManifestPath: path.join(dir, 'UPLOAD_MANIFEST.json') };
      fs.writeFileSync(planPath, JSON.stringify(old));
      fs.writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:03,000\n打开艾尔登法环\n');
      const request = jest.fn();
      await expect(detectGames({ mediaPath, srtPath, probe: async () => 60, request, config: {} }, getGameConfig({}),
        sourceSnapshot({ source: { mediaPath, srtPath } }), { roomId: '25788785' }, { plan: planPath }))
        .rejects.toThrow(/already rendered or queued/);
      expect(request).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(planPath, 'utf8'))).toEqual(old);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('rebuilding an unpublished transcript keeps the recording episode identity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-pending-identity-'));
    try {
      const mediaPath = path.join(dir, 'source.flv'), srtPath = path.join(dir, 'source.srt'), planPath = path.join(dir, 'PLAN.json');
      fs.writeFileSync(mediaPath, 'original recording');
      fs.writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:03,000\n我要打开游戏了\n');
      fs.writeFileSync(planPath, JSON.stringify({ status: 'planned', signature: 'old-transcript', sessionId: 'reserved-episode-identity',
        source: sourceSnapshot({ source: { mediaPath, srtPath } }) }));
      fs.writeFileSync(srtPath, '1\n00:00:01,000 --> 00:00:03,000\n打开艾尔登法环\n');
      const result = await detectGames({ mediaPath, srtPath, probe: async () => 60,
        request: async () => ({ text: '{"events":[]}' }), config: {} }, getGameConfig({}),
        sourceSnapshot({ source: { mediaPath, srtPath } }), { roomId: '25788785' }, { directory: dir, plan: planPath });
      expect(result.sessionId).toBe('reserved-episode-identity');
      expect(result.coverage.status).toBe('complete');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
