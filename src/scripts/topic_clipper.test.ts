const fs = require('fs');
const os = require('os');
const path = require('path');
const topicClipper = require('./topic_clipper');
const aiTextGenerator = require('./ai_text_generator');

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
  test('builds participant metadata from ASR speaker sidecar', () => {
    const participantInfo = topicClipper.buildParticipantMetadata({
      hostStreamerId: 'sui',
      plannedParticipantIds: ['shiori'],
      rosterStreamerIds: ['sui', 'shiori'],
      participants: [
        { streamerId: 'sui', displayName: '岁己SUI', appeared: true },
        { streamerId: 'shiori', displayName: '栞栞', appeared: false }
      ]
    });

    expect(participantInfo).toMatchObject({
      hostStreamerId: 'sui',
      plannedParticipantIds: ['shiori'],
      rosterStreamerIds: ['sui', 'shiori'],
      appearedDisplayNames: ['岁己SUI']
    });
  });

  test('keeps a mentioned streamer separate from the current streamer in title prompts', () => {
    const prompt = aiTextGenerator.buildClipTitlePromptLines({
      outputMode: 'jsonTitle',
      streamerName: '瑞娅'
    }).join('\n');

    expect(prompt).toContain('本段录播的主播是“瑞娅”');
    expect(prompt).toContain('不能改写为本段主播、其粉丝团体或其发言');
    expect(prompt).not.toContain('小岁');
    expect(prompt).not.toContain('饼干岁');
  });

  test('uses configured upload prefix and upload tags for a room', () => {
    const config = {
      ai: {
        roomSettings: { '23260993': { clipTitlePrefix: '小瑞' } },
        streamerRegistry: {
          rhea: {
            roomIds: ['23260993'],
            displayName: '瑞娅',
            speakerLabels: ['瑞娅', 'Rhea'],
            uploadTags: ['瑞瑞']
          }
        }
      }
    };
    expect(topicClipper.resolveUploadPrefix(config, '23260993', '瑞瑞')).toBe('【小瑞】');
    expect(topicClipper.resolveStreamerTags(config, '23260993')).toEqual(['瑞瑞']);
  });

  test('derives 小X upload prefixes by default for every streamer', () => {
    expect(topicClipper.deriveUploadPrefix('瑞瑞')).toBe('【小瑞】');
    expect(topicClipper.deriveUploadPrefix('岁己SUI')).toBe('【小岁】');
    expect(topicClipper.deriveUploadPrefix('米汀Nagisa')).toBe('【小米】');
    expect(topicClipper.deriveUploadPrefix('小栞')).toBe('【小栞】');
  });

  test('finds keyword matches and ignores unrelated segments', () => {
    const segments = [
      { start: 0, end: 1, text: '普通内容' },
      { start: 2, end: 3, text: '提到岁己和小岁' }
    ];

    const matches = topicClipper.findKeywordMatches(segments, ['岁己', '小岁']);

    expect(matches).toHaveLength(1);
    expect(matches[0].matchedKeywords).toEqual(['岁己', '小岁']);
  });

  test('ignores embedded and low-signal topic keyword hits', () => {
    const segments = [
      { start: 0, end: 1, text: '今天晚上是瑞瑞和小小岁小康三里' },
      { start: 2, end: 3, text: '谢谢小岁的灯牌' },
      { start: 4, end: 5, text: '小岁今天直播了吗' }
    ];

    const matches = topicClipper.findKeywordMatches(segments, ['小岁']);

    expect(matches).toHaveLength(1);
    expect(matches[0].segment.text).toBe('小岁今天直播了吗');
  });

  test('AI clip selections must include the matched segment', () => {
    const burst = {
      start: 100,
      end: 500,
      matchSegments: [
        { start: 300, end: 305, text: '小岁今天直播了吗', matchedKeywords: ['小岁'] }
      ]
    };

    expect(topicClipper.normalizeAiClipSelection(
      { startTime: '00:02:00', endTime: '00:02:40', title: 'unrelated' },
      burst
    )).toBeNull();

    expect(topicClipper.normalizeAiClipSelection(
      { startTime: '00:04:50', endTime: '00:05:20', title: 'related' },
      burst
    )).toMatchObject({ start: 290, end: 320 });
  });

  test('extends an AI end past unfinished ASR lines and the minimum clip duration', () => {
    const burst = {
      start: 5760,
      end: 6060,
      minClipSeconds: 30,
      boundaryEndExtensionSeconds: 60,
      boundarySilenceGapSeconds: 3,
      maxClipSeconds: 180,
      matchSegments: [
        { start: 5770.699, end: 5773.212, text: '我和小康还有小岁三个人在睡在那个频道', matchedKeywords: ['小岁'] },
        { start: 5779.84, end: 5782.6, text: '小岁就说那我我没接话', matchedKeywords: ['小岁'] }
      ],
      allSegments: [
        { start: 5770.699, end: 5773.212, text: '我和小康还有小岁三个人在睡在那个频道' },
        { start: 5773.212, end: 5775.725, text: '里面' },
        { start: 5776.25, end: 5778.954, text: '然后他说你今晚播什么' },
        { start: 5779.399, end: 5779.829, text: '然后呢' },
        { start: 5779.84, end: 5782.6, text: '小岁就说那我我没接话' },
        { start: 5782.8, end: 5783.309, text: '然后呢' },
        { start: 5783.319, end: 5786.234, text: '小翠就说你在跟谁说话呀' },
        { start: 5786.579, end: 5789.845, text: '然后那个小康就说你呀这好' },
        { start: 5792.43, end: 5794.199, text: '夏天因为我太尴尬啊' }
      ]
    };

    const selection = topicClipper.normalizeAiClipSelection(
      { startTime: '01:36:01', endTime: '01:36:23.309', title: '完整对话' },
      burst
    );

    expect(selection).toMatchObject({
      start: 5761,
      end: 5794.199,
      boundaryAdjusted: true
    });
  });

  test('dedupes AI clips with the same start and keeps the longer range', () => {
    const clips = [
      { window: { index: '1-1', start: 3044, end: 3114 } },
      { window: { index: '1-2', start: 3044, end: 3130 } },
      { window: { index: '2-1', start: 3300, end: 3360 } }
    ];

    const deduped = topicClipper.dedupeClipsByStart(clips);

    expect(deduped).toHaveLength(2);
    expect(deduped[0].window).toMatchObject({ index: '1-2', start: 3044, end: 3130 });
    expect(deduped[1].window).toMatchObject({ index: '2-1', start: 3300, end: 3360 });
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

  test('centers oversized burst context around the keyword and keeps following subtitles', () => {
    const segments = Array.from({ length: 260 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
      text: index === 150 ? '这里提到小岁然后继续说' : `普通内容${index}`
    }));
    const matches = topicClipper.findKeywordMatches(segments, ['小岁']);
    const bursts = topicClipper.buildTopicBursts(segments, matches, {
      contextPaddingSeconds: 200,
      mergeGapSeconds: 10,
      maxSegmentsPerBurst: 100
    });

    expect(bursts).toHaveLength(1);
    expect(bursts[0].allSegments).toHaveLength(100);
    expect(bursts[0].allSegments[0].text).toBe('普通内容110');
    expect(bursts[0].allSegments.some(segment => segment.text === '普通内容200')).toBe(true);
    expect(bursts[0].allSegments.some(segment => segment.text === '这里提到小岁然后继续说')).toBe(true);
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

  test('builds temporary burn ass from srt without changing subtitle content format', () => {
    const dir = makeTempDir();
    const srtPath = path.join(dir, 'clip.srt');
    const assPath = path.join(dir, 'clip.burn.ass');
    writeSrt(srtPath);

    topicClipper.writeTemporaryBurnAssFromSrt(srtPath, assPath, {
      fontName: '汉仪有圆 85简',
      fontSize: 31,
      outline: 2,
      playResX: 1280,
      playResY: 720,
      marginV: 24
    });

    const content = fs.readFileSync(assPath, 'utf8');
    expect(content).toContain('PlayResX: 1280');
    expect(content).toContain('PlayResY: 720');
    expect(content).toContain('Style: Default,汉仪有圆 85简,31');
    expect(content).toContain('Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,今天提到了岁己');
    expect(fs.readFileSync(srtPath, 'utf8')).toContain('00:00:10,000 --> 00:00:12,000');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('wraps long subtitle lines for enlarged burned-in subtitles', () => {
    const dir = makeTempDir();
    const srtPath = path.join(dir, 'wrapped.srt');

    topicClipper.writeClipSrt([
      { start: 0, end: 2, text: '123456789012345678901' }
    ], { start: 0, end: 2, duration: 2 }, srtPath, { maxCharsPerLine: 20 });

    expect(fs.readFileSync(srtPath, 'utf8')).toContain('12345678901234567890\n1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('uses similar burned subtitle proportions across common resolutions while preserving overrides', () => {
    expect(topicClipper.calculateSubtitleStyle(1920, 1080)).toMatchObject({
      fontSize: 68,
      maxCharsPerLine: 19,
      playResX: 1280,
      playResY: 720
    });

    expect(topicClipper.calculateSubtitleStyle(1280, 720)).toMatchObject({
      fontSize: 68,
      maxCharsPerLine: 19,
      playResX: 1280,
      playResY: 720
    });

    expect(topicClipper.calculateSubtitleStyle(1920, 1080, {
      subtitleFontSizeRatio: 0.039
    })).toMatchObject({
      fontSize: 30,
      maxCharsPerLine: 44
    });
  });

  test('selects the input-side seek keyframe at or before the rough cut target', () => {
    expect(topicClipper.selectInputSeekKeyframe([
      354.199,
      358.366,
      362.532,
      366.699
    ], 357.819)).toBe(354.199);

    expect(topicClipper.selectInputSeekKeyframe([
      354.199,
      358.366,
      362.532
    ], 358.366)).toBe(358.366);
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
          aiSegmentBurst: false,
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

  test('builds a compact topic notification markdown', () => {
    const markdown = topicClipper.buildTopicNotifyMarkdown([
      {
        window: {
          start: 10,
          end: 42,
          matchedKeywords: ['岁己', '小岁'],
          matchSegments: [{ index: 1, start: 20, end: 22, text: '这里提到了小岁', matchedKeywords: ['小岁'] }],
          contextSegments: [
            { index: 0, start: 18, end: 20, text: '前一句解释背景' },
            { index: 1, start: 20, end: 22, text: '这里提到了小岁', hit: true },
            { index: 2, start: 22, end: 24, text: '后一句继续补充' }
          ],
          danmakuContext: [
            '[00:00:21] 原来是在说小岁',
            '[00:00:23] 这段可以切'
          ]
        },
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
      aiModels: ['gpt-5.6-luna'],
      outputRoot: 'D:/clips',
      sourceFileName: '录制-25788785-20260603-201530-001-聊天回.flv'
    });

    expect(markdown).toContain('话题切片提醒');
    expect(markdown).toContain('岁己SUI');
    expect(markdown).toContain('今天聊点什么');
    expect(markdown).toContain('AI模型: gpt-5.6-luna');
    expect(markdown).toContain('找到其中 **2** 段提到岁己的地方');
    expect(markdown).toContain('D:/clips');
    expect(markdown).toContain('one.mp4');
    expect(markdown).toContain('two.mp4');
    expect(markdown).not.toContain('D:/clips/one.mp4');
    expect(markdown).not.toContain('投稿文案');
    expect(markdown).toContain('字幕上下文');
    expect(markdown).toContain('[00:00:18] 前一句解释背景');
    expect(markdown).toContain('★ [00:00:20] 这里提到了小岁');
    expect(markdown).toContain('附近弹幕');
    expect(markdown).toContain('[00:00:21] 原来是在说小岁');
  });
  test('respects disabled topic notification context options', () => {
    const markdown = topicClipper.buildTopicNotifyMarkdown([
      {
        window: {
          start: 10,
          end: 42,
          matchSegments: [{ start: 20, end: 22, text: '这里提到了小岁' }],
          danmakuContext: ['[00:00:21] 原来是在说小岁']
        },
        output: { mediaPath: 'D:/clips/one.mp4' }
      }
    ], {
      notify: {
        includeSubtitleContext: false,
        includeDanmakuContext: false
      }
    });

    expect(markdown).not.toContain('字幕上下文');
    expect(markdown).not.toContain('附近弹幕');
    expect(markdown).not.toContain('这里提到了小岁');
    expect(markdown).not.toContain('原来是在说小岁');
  });
  test('normalizes Windows backslashes in topic notification paths', () => {
    const markdown = topicClipper.buildTopicNotifyMarkdown([
      {
        window: { start: 10, end: 42, matchedKeywords: ['keyword'] },
        output: {
          mediaPath: 'D:\\files\\videos\\topic_clips\\one.mp4',
          copyPath: 'D:\\files\\videos\\topic_clips\\one.md'
        }
      }
    ], {
      outputRoot: 'D:\\files\\videos\\topic_clips'
    });

    expect(markdown).toContain('D:/files/videos/topic_clips');
    expect(markdown).toContain('one.mp4');
    expect(markdown).not.toContain('D:/files/videos/topic_clips/one.mp4');
    expect(markdown).not.toContain('one.md');
    expect(markdown).not.toContain('D:\\files');
  });

  test('splits long WeChat markdown without exceeding the content limit', () => {
    const content = [
      '## 话题切片提醒',
      '- 第一段',
      '- 第二段',
      '- 第三段'
    ].join('\n');

    const messages = topicClipper.splitWeChatMarkdown(content, 16);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message: string) => message.length <= 16)).toBe(true);
    expect(messages.join('\n')).toBe(content);
  });
});
