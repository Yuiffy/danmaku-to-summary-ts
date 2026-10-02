const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { renderGamePart } = require('./stream_game_media');
const { detectGames } = require('./stream_game_clipper');
const { sourceSnapshot } = require('./source_snapshot');
const { getGameConfig } = require('./stream_game_plan');
const execFileAsync = promisify(execFile);

describe('game cuts preserve original media and publication identity', () => {
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
          { audio: { ffmpeg: { path: 'ffmpeg' } } }, { mode: 'idle' }, { runFfmpeg,
            renderFallback: () => { throw new Error('This valid cut must retain the original bitstream'); } });
        expect(result.processing).toMatchObject({ originalStreamCopy: true, videoEncoder: 'copy', audioEncoder: 'copy' });
        expect(Math.abs(result.actualDuration - 1.7)).toBeLessThanOrEqual(.25);
        expect(result.burnedSubtitles).toBe(false);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);

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
