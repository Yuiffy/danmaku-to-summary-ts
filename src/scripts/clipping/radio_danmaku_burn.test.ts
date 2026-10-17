jest.mock('./media_runtime', () => ({ runFfmpeg: jest.fn(), resolveFfprobePath: () => 'ffprobe',
  probeRoughCutSourceStart: jest.fn().mockResolvedValue(12), probeRoughCutTimeOrigin: jest.fn().mockResolvedValue(12) }));
jest.mock('./video_probe', () => ({ getVideoResolution: jest.fn().mockResolvedValue({ width: 1080, height: 1920 }) }));

const fs = require('fs');
const os = require('os');
const path = require('path');
const media = require('./media_runtime');
const topic = require('../topic_clipper');

describe('radio overlays in the shared subtitle renderer', () => {
  let dir: string, source: string, srt: string, output: string;
  beforeEach(() => {
    jest.clearAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-burn-'));
    source = path.join(dir, '录制-25788785-test.flv');
    srt = path.join(dir, 'clip.srt');
    output = path.join(dir, 'clip.mp4');
    fs.writeFileSync(source.replace('.flv', '.xml'), '<i><d p="21,4,25,16777215">hello</d></i>');
    fs.writeFileSync(srt, '1\n00:00:01,000 --> 00:00:03,000\n字幕\n');
    media.runFfmpeg.mockResolvedValue({});
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = { burnSubtitles: true, ffmpegThreads: 2, radioDanmaku: { enabled: true, fps: 30, fontScale: 2 },
    subtitleVideoEncoder: 'h264_nvenc', subtitleHwaccel: 'cuda', twoStageMode: 'copy' };

  test('copy rough-cut rebasing places resampling and animated comments before speech subtitles', async () => {
    const result = await topic.cutClipMedia({ kind: 'video', mediaPath: source },
      { start: 20, duration: 5 }, srt, output, config);
    expect(result).toMatchObject({ burnedSubtitles: true, radioDanmaku: { commentCount: 1, fps: 30, fontSize: 80 } });
    const args = media.runFfmpeg.mock.calls[1][0];
    expect(args.slice(0, args.indexOf('-i'))).toEqual(['-y', '-threads', '2', '-hwaccel', 'cuda']);
    const graph = args[args.indexOf('-filter_complex') + 1];
    expect(graph).toContain('trim=start=8:end=13,setpts=PTS-STARTPTS');
    expect(graph).toMatch(/\[sub_v\]fps=fps=30:round=near,tpad=stop_mode=clone:stop_duration=5,trim=duration=5,ass='.*\.danmaku.ass',subtitles='.*\.burn.ass'\[vout\]/u);
    expect(fs.existsSync(output.replace('.mp4', '.danmaku.ass'))).toBe(false);
  });

  test('NVENC failure preserves overlays on the CPU retry instead of emitting an unburned fallback', async () => {
    media.runFfmpeg.mockRejectedValueOnce(new Error('NVENC unavailable'));
    const result = await topic.cutClipMedia({ kind: 'video', mediaPath: source },
      { start: 20, duration: 5 }, srt, output, { ...config, twoStageMode: 'direct' });
    expect(result).toMatchObject({ burnedSubtitles: true, fallbackUsed: true, subtitleVideoEncoder: 'libx264' });
    const args = media.runFfmpeg.mock.calls.at(-1)[0];
    expect(args).toContain('libx264');
    expect(args).not.toContain('cuda');
    expect(args[args.indexOf('-vf') + 1]).toMatch(/^fps=fps=30:round=near,tpad=.*ass=.*subtitles=/u);
  });

  test('a missing XML blocks requested radio rendering without silently dropping comments', async () => {
    fs.unlinkSync(source.replace('.flv', '.xml'));
    await expect(topic.cutClipMedia({ kind: 'video', mediaPath: source },
      { start: 20, duration: 5 }, srt, output, config)).rejects.toThrow();
    expect(media.runFfmpeg).not.toHaveBeenCalled();
  });

  test('edit and creative paths also resample after timeline composition before drawing comments', async () => {
    const window = { start: 20, end: 25, duration: 5 };
    const edit = require('../workflow-runtime').loadWorkflow('clipping/editPlan').continuousPlan('source', window);
    await topic.cutClipMedia({ kind: 'video', mediaPath: source }, window, srt, output,
      { ...config, editPlan: edit, editSourceId: 'source' });
    let args = media.runFfmpeg.mock.calls.at(-1)[0];
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[sub_v]fps=fps=30:round=near,tpad=');
    fs.writeFileSync(source.replace('.flv', '.xml'), '<i><d p="21,1,25,1">omitted</d><d p="24,1,25,1">kept</d></i>');
    const timeline = { version: 1, sourceDuration: 5, duration: 3, keep: [{ start: 0, end: 1 }, { start: 3, end: 5 }] };
    const result = await topic.cutClipMedia({ kind: 'video', mediaPath: source }, window, srt, output,
      { ...config, creativePlan: { version: 2, workflow: 'creative', style: 'compact', duration: 3, timeline, effects: [] },
        creativeSettings: { style: 'compact' }, creativeAssets: {} });
    expect(result.radioDanmaku.commentCount).toBe(1);
    args = media.runFfmpeg.mock.calls.at(-1)[0];
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[cv0]fps=fps=30:round=near,tpad=stop_mode=clone:stop_duration=3,trim=duration=3,ass=');
  });
});
