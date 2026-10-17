import { radioEnabled, parseComments, buildRadioAss, overlayFilter, prepareRadioDanmaku, projectComments } from './radioDanmaku';

const resolution = { width: 1080, height: 1920 };
const window = { start: 10, duration: 12 };
const settings = { enabled: true, mode: 'portrait' as const, fontScale: 2, fps: 30 };

test('radio default covers the configured portrait recording, with explicit landscape radio and opt-out', () => {
  expect(radioEnabled('D:/录制-25788785-20261014_merged.flv', resolution, settings)).toBe(true);
  expect(radioEnabled('录制-123456-abc.flv', resolution, settings)).toBe(false);
  expect(radioEnabled('录制-25788785-abc.flv', { width: 1920, height: 1080 }, settings)).toBe(false);
  expect(radioEnabled('other.mp4', resolution, { ...settings, mode: 'radio' })).toBe(true);
  expect(radioEnabled('录制-25788785-abc.flv', resolution, { ...settings, enabled: false })).toBe(false);
});

test('legacy preview markup is ignored, entities decode once, and window/color/text stay bound', async () => {
  const rows = await parseComments('<i><script><a target=_blank></script>'
    + '<d p="9,4,25,1">before</d><d p="10.25,4,25,16711680">A &amp; B</d>'
    + '<d p="11,1,25,16777215">[岁己收藏集表情包_哈哈]</d><d p="22,1,25,1">after</d></i>');
  const result = buildRadioAss(rows, window, resolution, settings);
  expect(result).toMatchObject({ commentCount: 2, fontSize: 80, fps: 30 });
  expect(result.ass).toContain('0:00:00.25,0:00:08.25');
  expect(result.ass).toContain('\\c&H0000FF&}A & B');
  expect(result.ass).toContain('[哈哈]');
  expect(result.ass).not.toContain('before');
  expect(result.ass).not.toContain('after');
  expect(buildRadioAss([{ time: 21, text: 'tail', color: 1 }], window, resolution, settings).ass)
    .toContain('0:00:11.00,0:00:19.00');
});

test('concurrent comments get different lanes; controls cannot inject ASS tags', () => {
  const result = buildRadioAss([
    { time: 10, text: 'first', color: 16777215 },
    { time: 10, text: '{\\pos(0,0)}\nsecond', color: 16777215 }
  ], window, resolution, settings);
  expect(result.ass).toContain('\\move(1080,0,');
  expect(result.ass).toContain('\\move(1080,92,');
  expect(result.ass).toContain('｛＼pos(0,0)｝ second');
  expect(overlayFilter('safe.ass', 30, 12)).toBe("fps=fps=30:round=near,tpad=stop_mode=clone:stop_duration=12,trim=duration=12,ass='safe.ass'");
  expect(() => buildRadioAss([], window, resolution, { fps: 2 })).toThrow('frame rate');
});

test('runtime reads the source sidecar, not a rough-preview XML, and fails on missing requested evidence', async () => {
  const read = jest.fn().mockResolvedValue('<i><d p="10,1,25,1">hello</d></i>');
  const write = jest.fn().mockResolvedValue(undefined);
  const input = { mediaPath: 'D:/录制-25788785-test.flv', assPath: 'clip.danmaku.ass', window, resolution, settings };
  expect(await prepareRadioDanmaku(input, { read, write })).toMatchObject({ commentCount: 1, fps: 30 });
  expect(read).toHaveBeenCalledWith('D:/录制-25788785-test.xml');
  read.mockRejectedValue(new Error('missing XML'));
  await expect(prepareRadioDanmaku(input, { read, write })).rejects.toThrow('missing XML');
  read.mockClear();
  expect(await prepareRadioDanmaku({ ...input, settings: { enabled: false } }, { read, write })).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

test('edited comments follow retained spans and reaction holds without leaking cut-away reactions', () => {
  const comments = [10.5, 11, 12, 14].map(time => ({ time, text: String(time), color: 1 }));
  const edit = projectComments(comments, window, [{ start: 10, end: 11 }, { start: 13, end: 15 }]);
  expect(edit.comments.map(c => c.time)).toEqual([.5, 2]);
  expect(edit.window).toEqual({ start: 0, duration: 3 });
  const creative = projectComments(comments, window, undefined, { version: 1, sourceDuration: 12, duration: 3.8,
    keep: [{ start: 0, end: 1 }, { start: 3, end: 5 }], holds: [{ after: 1, seconds: .8, cueId: 'S1' }] });
  expect(creative.comments.map(c => c.time)).toEqual([.5, 2.8]);
  expect(creative.window.duration).toBe(3.8);
});
