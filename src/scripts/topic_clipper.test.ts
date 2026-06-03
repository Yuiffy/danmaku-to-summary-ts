const fs = require('fs');
const os = require('os');
const path = require('path');
const topicClipper = require('./topic_clipper');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'topic-clipper-'));
}

function writeSrt(filePath: string) {
  fs.writeFileSync(filePath, [
    '1',
    '00:00:10,000 --> 00:00:12,000',
    '今天提到了岁己',
    '',
    '2',
    '00:00:40,000 --> 00:00:42,000',
    '也可以叫小岁姐',
    '',
    '3',
    '00:03:20,000 --> 00:03:22,000',
    '这句没有关键词',
    ''
  ].join('\n'), 'utf8');
}

describe('topic_clipper', () => {
  test('finds keyword matches and ignores unrelated segments', () => {
    const segments = [
      { start: 0, end: 1, text: '普通内容' },
      { start: 2, end: 3, text: '提到岁己和小岁' }
    ];

    const matches = topicClipper.findKeywordMatches(segments, ['岁己', '小岁']);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedKeywords).toEqual(['岁己', '小岁']);
  });

  test('merges nearby hit windows and respects max clip duration', () => {
    const segments = [
      { start: 10, end: 12, text: '岁己' },
      { start: 40, end: 42, text: '小岁' },
      { start: 220, end: 222, text: '饼干岁' }
    ];
    const matches = topicClipper.findKeywordMatches(segments, ['岁己', '小岁', '饼干岁']);

    const windows = topicClipper.buildClipWindows(segments, matches, {
      prePaddingSeconds: 20,
      postPaddingSeconds: 35,
      mergeGapSeconds: 45,
      maxClipSeconds: 180
    });

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      start: 0,
      end: 77,
      matchedKeywords: ['岁己', '小岁'],
      matchCount: 2
    });
    expect(windows[1].duration).toBeLessThanOrEqual(180);
  });

  test('clamps padding to media duration boundaries', () => {
    const segments = [{ start: 4, end: 6, text: '小岁' }];
    const matches = topicClipper.findKeywordMatches(segments, ['小岁']);

    const windows = topicClipper.buildClipWindows(segments, matches, {
      prePaddingSeconds: 20,
      postPaddingSeconds: 35,
      totalDurationSeconds: 25
    });

    expect(windows[0].start).toBe(0);
    expect(windows[0].end).toBe(25);
  });

  test('parses recording metadata and falls back to template title', () => {
    const info = topicClipper.parseRecordingInfo('D:/录制-25788785-20260603-201530-001-聊天回.flv');
    const title = topicClipper.buildDefaultTitle({ start: 15 }, info);

    expect(info).toMatchObject({
      roomId: '25788785',
      recordedAt: '2026-06-03 20:15:30',
      streamTitle: '聊天回'
    });
    expect(title).toBe('提到岁己的小片段 06-03 20:15');
  });

  test('writes shifted clip srt for overlapping segments', () => {
    const dir = makeTempDir();
    const srtPath = path.join(dir, 'clip.srt');

    const result = topicClipper.writeClipSrt([
      { start: 10, end: 12, text: '提到岁己' },
      { start: 20, end: 22, text: '后续内容' }
    ], { start: 8, end: 18, duration: 10 }, srtPath);

    const content = fs.readFileSync(srtPath, 'utf8');
    expect(result.segmentCount).toBe(1);
    expect(content).toContain('00:00:02,000 --> 00:00:04,000');
    expect(content).toContain('提到岁己');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('disabled config does not generate topic clips', async () => {
    const dir = makeTempDir();
    const mediaPath = path.join(dir, '录制-25788785-20260603-201530-001-聊天回.m4a');
    const srtPath = path.join(dir, '录制-25788785-20260603-201530-001-聊天回.srt');
    fs.writeFileSync(mediaPath, 'not real media');
    writeSrt(srtPath);

    const results = await topicClipper.generateTopicClips({
      config: { clipTopics: { enabled: false } },
      originalMediaPath: mediaPath,
      processedMediaPath: mediaPath,
      srtPath
    });

    expect(results).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'topic_clips'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('ignored room id skips clip generation even when keywords match', async () => {
    const dir = makeTempDir();
    const mediaPath = path.join(dir, '录制-25788785-20260603-201530-001-聊天回.m4a');
    const srtPath = path.join(dir, '录制-25788785-20260603-201530-001-聊天回.srt');
    fs.writeFileSync(mediaPath, 'not real media');
    writeSrt(srtPath);

    const results = await topicClipper.generateTopicClips({
      config: {
        clipTopics: {
          enabled: true,
          ignoredRoomIds: ['25788785'],
          keywords: ['岁己', '小岁']
        }
      },
      originalMediaPath: mediaPath,
      processedMediaPath: mediaPath,
      srtPath
    });

    expect(results).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'topic_clips'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('audio-only input keeps review metadata and marks upload as not ready', async () => {
    const dir = makeTempDir();
    const mediaPath = path.join(dir, '录制-25788785-20260603-201530-001-聊天回.m4a');
    const srtPath = path.join(dir, '录制-25788785-20260603-201530-001-聊天回.srt');
    fs.writeFileSync(mediaPath, 'not real media');
    writeSrt(srtPath);

    const results = await topicClipper.generateTopicClips({
      config: {
        clipTopics: {
          enabled: true,
          burnSubtitles: true,
          keywords: ['岁己', '小岁'],
          prePaddingSeconds: 1,
          postPaddingSeconds: 1,
          mergeGapSeconds: 45
        },
        ai: {
          roomSettings: {
            '25788785': { anchorName: '小岁' }
          }
        }
      },
      originalMediaPath: mediaPath,
      processedMediaPath: mediaPath,
      srtPath,
      ffmpegPath: 'ffmpeg-command-that-does-not-exist',
      titleGenerator: async () => '岁己话题小切片'
    });

    expect(results).toHaveLength(1);
    expect(results[0].uploadReady).toBe(false);
    expect(results[0].copy.title).toBe('岁己话题小切片');
    expect(results[0].output.mediaError).toBeTruthy();
    expect(fs.existsSync(results[0].output.srtPath)).toBe(true);
    expect(fs.existsSync(results[0].output.metadataPath)).toBe(true);
    expect(fs.existsSync(results[0].output.copyPath)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('builds a readable topic notification markdown', () => {
    const markdown = topicClipper.buildTopicNotifyMarkdown([
      {
        window: { start: 10, end: 42, matchedKeywords: ['岁己', '小岁'] },
        output: { mediaPath: 'D:/clips/one.mp4', copyPath: 'D:/clips/one_投稿文案.md' }
      },
      {
        window: { start: 100, end: 140, matchedKeywords: ['岁己'] },
        output: { mediaPath: 'D:/clips/two.mp4', copyPath: 'D:/clips/two_投稿文案.md' }
      }
    ], {
      streamerName: '岁己SUI',
      streamTitle: '今天聊点什么',
      roomId: '25788785',
      recordedAt: '2026-06-03 20:15:30',
      outputRoot: 'D:/clips',
      sourceFileName: '录制-25788785-20260603-201530-001-聊天回.flv'
    });

    expect(markdown).toContain('话题切片提醒');
    expect(markdown).toContain('岁己SUI');
    expect(markdown).toContain('今天聊点什么');
    expect(markdown).toContain('找到其中 **2** 段提到岁己的地方');
    expect(markdown).toContain('D:/clips');
    expect(markdown).toContain('D:/clips/one.mp4');
    expect(markdown).toContain('D:/clips/two.mp4');
    expect(markdown).toContain('D:/clips/one_投稿文案.md');
  });
});
