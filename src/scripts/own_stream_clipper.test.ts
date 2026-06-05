const fs = require('fs');
const os = require('os');
const path = require('path');
const ownStreamClipper = require('./own_stream_clipper');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'own-stream-clipper-'));
}

describe('own_stream_clipper', () => {
  test('parses bilibili danmaku xml rows', async () => {
    const dir = makeTempDir();
    const xmlPath = path.join(dir, 'danmaku.xml');
    fs.writeFileSync(xmlPath, [
      '<i>',
      '<d p="12.5,1,25,16777215,1710000000,0,user-a,0">哈哈好可爱</d>',
      '<d p="42,1,25,16777215,1710000001,0,user-b,0">啊？</d>',
      '</i>'
    ].join(''), 'utf8');

    const rows = await ownStreamClipper.parseDanmakuXml(xmlPath);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ time: 12.5, text: '哈哈好可爱', uid: 'user-a' });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('builds upload description with source live and clip time', () => {
    const description = ownStreamClipper.buildClipDescription({
      streamerName: '宀佸繁SUI',
      streamTitle: '鎮犲搲鎮犲搲澶滄櫄锛?',
      recordedAt: '2026-06-05 19:43:31',
      start: 112.5,
      end: 145.2,
      reason: '宀佸繁鍏堣嚜鎴戞媿鎵嬪彨琛?'
    });

    expect(description).toContain('录制时间 2026-06-05 19:43:31');
    expect(description).toContain('片段时间 00:01:52-00:02:25');
    expect(description).toContain('宀佸繁鍏堣嚜鎴戞媿鎵嬪彨琛?');
  });

  test('builds candidates from danmaku density and reaction keywords', () => {
    const parsed = {
      segments: [
        { start: 10, end: 12, text: '普通内容' },
        { start: 80, end: 84, text: '等一下我刚刚是不是做错了' }
      ]
    };
    const danmaku = Array.from({ length: 18 }, (_, index) => ({
      time: 30 + index * 0.5,
      text: index % 3 === 0 ? '哈哈好傻' : '可爱',
      uid: `u${index}`
    }));
    const config = ownStreamClipper.getOwnStreamClipsConfig({
      ownStreamClips: {
        prePaddingSeconds: 10,
        postPaddingSeconds: 10,
        windowSeconds: 60,
        minClipSeconds: 20,
        maxCandidates: 5,
        minDanmakuCount: 5
      }
    });

    const candidates = ownStreamClipper.buildCandidateWindows(parsed, danmaku, config, 180);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0].score).toBeGreaterThan(0);
    expect(candidates.some(candidate => String(candidate.reason).includes('danmaku'))).toBe(true);
  });

  test('builds numbered review notification markdown', () => {
    const markdown = ownStreamClipper.buildNotifyMarkdown([
      {
        window: { start: 75, duration: 90 },
        copy: { title: '岁己：弹幕觉得这里很有趣' },
        output: { mediaPath: 'D:/clips/one.mp4' }
      },
      {
        window: { start: 180, duration: 45 },
        copy: { title: '岁己：很有岁己想法的一段' },
        output: { mediaPath: 'D:/clips/two.mp4' }
      }
    ], {
      streamTitle: '悠哉悠哉夜晚！',
      recordedAt: '2026-06-05 19:43:31',
      outputRoot: 'D:/clips'
    });

    expect(markdown).toContain('1. 岁己：弹幕觉得这里很有趣 | 00:01:15 | 00:01:30');
    expect(markdown).toContain('2. 岁己：很有岁己想法的一段 | 00:03:00 | 00:00:45');
    expect(markdown).not.toContain('D:/clips/one.mp4');
  });

  test('filters planned clips by one-based selection', () => {
    const clips = [{ title: 'a' }, { title: 'b' }, { title: 'c' }];

    expect(ownStreamClipper.filterClipsBySelection(clips, [1, 3]).map(c => c.title)).toEqual(['a', 'c']);
    expect(ownStreamClipper.filterClipsBySelection(clips, [])).toEqual(clips);
  });

  test('aligns clip end forward to the next subtitle silence gap', () => {
    const aligned = ownStreamClipper.alignClipToSubtitleBoundaries(
      { start: 100, end: 115, title: 'airport story' },
      [
        { start: 99, end: 101, text: '开头' },
        { start: 112, end: 115, text: '这抬头瞟了眼' },
        { start: 116, end: 119, text: '发现有好几个男的在往那边走' },
        { start: 120, end: 122, text: '我想说为什么会这么多男的呢' },
        { start: 126, end: 127, text: '下一个话题' }
      ],
      {
        alignBoundaries: true,
        boundaryStartBacktrackSeconds: 5,
        boundaryEndExtendSeconds: 30,
        boundarySilenceGapSeconds: 2
      },
      200
    );

    expect(aligned.start).toBe(99);
    expect(aligned.end).toBe(122);
    expect(aligned.boundaryAligned).toBe(true);
  });

  test('does not extend forever when no silence gap appears soon', () => {
    const aligned = ownStreamClipper.alignClipToSubtitleBoundaries(
      { start: 10.5, end: 20, title: 'continuous talk' },
      [
        { start: 10, end: 12, text: '句子开头' },
        { start: 12.2, end: 18, text: '持续说话' },
        { start: 18.1, end: 24, text: '继续说完一句' },
        { start: 24.1, end: 40, text: '太远的内容' }
      ],
      {
        alignBoundaries: true,
        boundaryStartBacktrackSeconds: 3,
        boundaryEndExtendSeconds: 5,
        boundarySilenceGapSeconds: 2
      },
      200
    );

    expect(aligned.start).toBe(10);
    expect(aligned.end).toBe(24);
  });

  test('trims trailing new-topic tail when a silence gap appears near the AI end', () => {
    const aligned = ownStreamClipper.alignClipToSubtitleBoundaries(
      { start: 100, end: 140, title: 'tail starts new topic' },
      [
        { start: 98, end: 101, text: '话题前文' },
        { start: 110, end: 128, text: '完整有趣话题' },
        { start: 132, end: 135, text: '新话题开头' },
        { start: 135.1, end: 139, text: '新话题继续' }
      ],
      {
        alignBoundaries: true,
        minClipSeconds: 20,
        boundaryStartBacktrackSeconds: 5,
        boundaryEndExtendSeconds: 30,
        boundarySilenceGapSeconds: 2,
        boundaryTrailingSilenceLookbackSeconds: 14
      },
      200
    );

    expect(aligned.end).toBe(128);
    expect(aligned.boundaryTrimmedAtTrailingSilence).toBe(true);
  });

  test('crosses a short silence gap when following subtitles continue the same story', () => {
    const aligned = ownStreamClipper.alignClipToSubtitleBoundaries(
      { start: 3563, end: 3615, title: 'airport story' },
      [
        { start: 3552.929, end: 3553.974, text: '男厕所' },
        { start: 3554.1, end: 3560.288, text: '我那天在那个机场的时候' },
        { start: 3560.4, end: 3564.2, text: '不知道怎么跟你形容这个机场是 t 字型' },
        { start: 3598.611, end: 3601.672, text: '我说为什么这么多男的这个什么在门口这个聚集着' },
        { start: 3603.903, end: 3607.244, text: '然后我就退出退出了' },
        { start: 3610.861, end: 3612.379, text: '没有看到' },
        { start: 3612.39, end: 3613.95, text: '因为我在低头玩手机' },
        { start: 3614.32, end: 3615.642, text: '这抬头瞟了眼' },
        { start: 3616.0, end: 3619.5, text: '发现有好几个男的在往那边走' },
        { start: 3620.2, end: 3622.4, text: '我想说为什么会这么多男的呢' },
        { start: 3626.2, end: 3629.2, text: '我还没有走进他那个门呢' },
        { start: 3629.5, end: 3631.875, text: '还好没有酿成八醉' },
        { start: 3634.1, end: 3637.2, text: '谢谢礼物' }
      ],
      {
        alignBoundaries: true,
        minClipSeconds: 35,
        boundaryStartBacktrackSeconds: 12,
        boundaryEndExtendSeconds: 45,
        boundarySilenceGapSeconds: 2,
        boundaryTrailingSilenceLookbackSeconds: 14
      },
      4000
    );

    expect(aligned.start).toBe(3552.929);
    expect(aligned.end).toBe(3631.875);
  });
});
