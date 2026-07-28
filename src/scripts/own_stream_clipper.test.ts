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

  test('prefers the AI two-line cover copy over the longer upload title', () => {
    expect(ownStreamClipper.buildCoverTitle(
      '提建议被当成找茬？小岁委屈控诉：你们不宠我了，只会从我身上找问题！',
      '你们不宠我了\\n只会找我问题！'
    )).toBe('你们不宠我了\n只会找我问题！');
  });

  test('passes copy-mode two-stage burn settings to media cutter by default', () => {
    const config = ownStreamClipper.getOwnStreamClipsConfig({
      ownStreamClips: {
        burnSubtitles: true
      }
    });

    expect(ownStreamClipper.buildCutClipMediaConfig(config, { ffmpegPath: 'ffmpeg-test' })).toMatchObject({
      burnSubtitles: true,
      twoStageSubtitleBurn: true,
      twoStageMode: 'copy',
      twoStagePreRollSeconds: 8,
      twoStagePostRollSeconds: 2,
      preserveCoverSource: true,
      ffmpegPath: 'ffmpeg-test'
    });
  });

  test('selects the densest reaction burst as the preferred cover time', () => {
    const danmaku = [
      { time: 12, text: '普通' },
      { time: 40, text: '哈哈' },
      { time: 41, text: '哈哈好可爱' },
      { time: 42, text: '绷不住了' },
      { time: 43, text: '啊？' },
      { time: 75, text: '普通收尾' }
    ];
    const peak = ownStreamClipper.selectCoverPreferredTime(
      danmaku,
      { start: 10, end: 80 },
      ['哈哈', '绷不住']
    );

    expect(peak).toBeGreaterThanOrEqual(40);
    expect(peak).toBeLessThanOrEqual(43);
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

    expect(markdown).toContain('来源统计: 本地规则 2');
    expect(markdown).toContain('1. 岁己：弹幕觉得这里很有趣 | 00:01:15 | 00:01:30');
    expect(markdown).toContain('2. 岁己：很有岁己想法的一段 | 00:03:00 | 00:00:45');
    expect(markdown).not.toContain('D:/clips/one.mp4');
  });

  test('review and notify markdown remain compatible when participant info is present', () => {
    const results = [
      {
        window: { start: 75, duration: 90 },
        copy: { title: '岁己：弹幕觉得这里很有趣' },
        output: { mediaPath: 'D:/clips/one.mp4' },
        participantInfo: {
          rosterStreamerIds: ['sui', 'shiori'],
          appearedDisplayNames: ['岁己SUI']
        }
      }
    ];
    const metadata = {
      streamTitle: '悠哉悠哉夜晚！',
      recordedAt: '2026-06-05 19:43:31',
      outputRoot: 'D:/clips',
      participantInfo: {
        rosterStreamerIds: ['sui', 'shiori'],
        appearedDisplayNames: ['岁己SUI']
      }
    };

    const review = ownStreamClipper.buildReviewMarkdown(results, metadata);
    const notify = ownStreamClipper.buildNotifyMarkdown(results, metadata);
    expect(review).toContain('岁己：弹幕觉得这里很有趣');
    expect(notify).toContain('岁己：弹幕觉得这里很有趣');
  });

  test('includes upload registry short ids in review and notification markdown', () => {
    const results = [
      {
        window: { start: 75, duration: 90 },
        copy: { title: '岁己：弹幕觉得这里很有趣' },
        output: { mediaPath: 'D:/clips/one.mp4', coverPath: 'D:/clips/one_cover.jpg' }
      },
      {
        window: { start: 180, duration: 45 },
        copy: { title: '岁己：很有岁己想法的一段' },
        output: { mediaPath: 'D:/clips/two.mp4' }
      }
    ];
    const metadata = {
      streamTitle: '悠哉悠哉夜晚！',
      recordedAt: '2026-06-05 19:43:31',
      outputRoot: 'D:/clips',
      uploadRegistry: { clipIds: [17, 18] }
    };

    const review = ownStreamClipper.buildReviewMarkdown(results, metadata);
    const notify = ownStreamClipper.buildNotifyMarkdown(results, metadata);

    expect(review).toContain('上传短ID: 17,18');
    expect(review).toContain('1. 岁己：弹幕觉得这里很有趣 | 00:01:15 | 00:01:30 | D:/clips/one.mp4');
    expect(review).toContain('   上传ID: 17');
    expect(review).toContain('   上传ID: 18');
    expect(notify).toContain('上传短ID: 17,18');
    expect(notify).toContain('1. ID 17 | 岁己：弹幕觉得这里很有趣 | 00:01:15 | 00:01:30');
    expect(notify).toContain('2. ID 18 | 岁己：很有岁己想法的一段 | 00:03:00 | 00:00:45');
  });

  test('normalizes Windows backslashes in own-stream notification paths', () => {
    const markdown = ownStreamClipper.buildNotifyMarkdown([
      {
        window: { start: 75, duration: 90 },
        copy: { title: '岁己：弹幕觉得这里很有趣' },
        output: { mediaPath: 'D:\\files\\videos\\DDTV录播\\25788785_岁己SUI\\clip.mp4' }
      }
    ], {
      streamTitle: '悠哉悠哉夜晚！',
      recordedAt: '2026-06-16 19:55:18',
      outputRoot: 'D:\\files\\videos\\DDTV录播\\25788785_岁己SUI\\2026_06_16\\own_stream_fun_clips',
      reviewPath: 'D:\\files\\videos\\DDTV录播\\25788785_岁己SUI\\2026_06_16\\own_stream_fun_clips\\REVIEW.md'
    });

    expect(markdown).toContain('切片目录: D:/files/videos/DDTV录播/25788785_岁己SUI/2026_06_16/own_stream_fun_clips');
    expect(markdown).toContain('Review: D:/files/videos/DDTV录播/25788785_岁己SUI/2026_06_16/own_stream_fun_clips/REVIEW.md');
    expect(markdown).not.toContain('D:\\files');
  });

  test('includes AI fallback status in own-stream notification markdown', () => {
    const markdown = ownStreamClipper.buildNotifyMarkdown([
      {
        window: { start: 75, duration: 90 },
        copy: { title: '岁己：弹幕突然很在意的片段' },
        output: { mediaPath: 'D:/clips/one.mp4' }
      }
    ], {
      streamTitle: '悠哉悠哉夜晚！',
      recordedAt: '2026-06-20 19:56:59',
      outputRoot: 'D:/clips',
      aiStatus: {
        usedFallback: true,
        fallbackReason: 'TuZi 余额不足'
      }
    });

    expect(markdown).toContain('AI状态: AI 规划未成功（TuZi 余额不足）');
    expect(markdown).toContain('已回退到本地弹幕规则候选');
  });

  test('filters planned clips by one-based selection', () => {
    const clips = [{ title: 'a' }, { title: 'b' }, { title: 'c' }];

    expect(ownStreamClipper.filterClipsBySelection(clips, [1, 3]).map(c => c.title)).toEqual(['a', 'c']);
    expect(ownStreamClipper.filterClipsBySelection(clips, [])).toEqual(clips);
  });

  test('continues remaining clip jobs when one concurrent job fails', async () => {
    const results = await ownStreamClipper.runJobsWithConcurrency([
      async () => ({ index: 1 }),
      async () => { throw new Error('simulated clip failure'); },
      async () => ({ index: 3 }),
      async () => ({ index: 4 })
    ], 3);

    expect(results).toEqual([
      { index: 1 },
      { index: 3 },
      { index: 4 }
    ]);
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

  test('merges identical nearby danmaku while preserving distant repeats', () => {
    const aggregated = ownStreamClipper.aggregateDanmakuForFullContext([
      { time: 10, text: '哈哈' },
      { time: 12, text: ' 哈哈 ' },
      { time: 41, text: '哈哈' },
      { time: 15, text: '太可爱了' }
    ], 30);

    expect(aggregated).toEqual([
      { text: '哈哈', count: 2, firstTime: 10, lastTime: 12 },
      { text: '太可爱了', count: 1, firstTime: 15, lastTime: 15 },
      { text: '哈哈', count: 1, firstTime: 41, lastTime: 41 }
    ]);
  });

  test('builds full context without truncating subtitles or aggregated danmaku', () => {
    const source = ownStreamClipper.buildFullContextSource({
      segments: [
        { start: 1, end: 2, text: '第一句' },
        { start: 61, end: 63, text: '最后一句' }
      ]
    }, [
      { time: 1.2, text: '笑死' },
      { time: 1.8, text: '笑死' }
    ], { fullContextDanmakuMergeWindowSeconds: 30 });

    expect(source.sourceText).toContain('00:00:01-00:00:02 第一句');
    expect(source.sourceText).toContain('00:01:01-00:01:03 最后一句');
    expect(source.sourceText).toContain('笑死 (x2)');
    expect(source.sourceText).toContain('=== 30秒弹幕热度表 ===');
    expect(source.heatLines[0]).toContain('count=2');
    expect(source.heatLines[0]).toContain('baselineRatio=1');
    expect(source.subtitleLines).toHaveLength(2);
    expect(source.danmakuLines).toHaveLength(1);
  });

  test('removes overlaps after subtitle alignment and keeps the higher-scored clip', () => {
    const clips = ownStreamClipper.removeOverlappingClips([
      { start: 100, end: 180, score: 80, title: 'lower' },
      { start: 170, end: 240, score: 95, title: 'higher' },
      { start: 240, end: 300, score: 70, title: 'touching is allowed' }
    ]);

    expect(clips.map((clip: any) => clip.title)).toEqual(['higher', 'touching is allowed']);
  });

  test('production full-context own-stream clipping is scoped only to Sui room', () => {
    const production = require('../../config/production.json');

    expect(production.ownStreamClips.enabled).toBe(true);
    expect(production.ownStreamClips.roomIds).toEqual(['25788785']);
    expect(production.ownStreamClips.ai.strategy).toBe('full_context');
    expect(production.ownStreamClips.ai.model).toBe('gpt-5.6-luna');
    expect(production.ownStreamClips.parallel.enabled).toBe(false);
  });

  test('combines separately configured heat and model routes and prefers model on overlap', () => {
    const heat = [
      { start: 100, end: 180, score: 90, selectionSource: 'danmaku_heat' },
      { start: 300, end: 380, score: 80, selectionSource: 'danmaku_heat' },
      { start: 500, end: 580, score: 70, selectionSource: 'danmaku_heat' }
    ];
    const model = [
      { start: 110, end: 175, score: 95, selectionSource: 'model_full_context' },
      { start: 700, end: 790, score: 85, selectionSource: 'model_full_context' }
    ];

    const combined = ownStreamClipper.combineParallelClipPlans(heat, model, {
      danmakuHeatClips: 2,
      modelClips: 2,
      dedupeAcrossSources: true,
      overlapToleranceSeconds: 12,
      preferModelOnOverlap: true
    });

    expect(combined.map((clip: any) => [clip.start, clip.selectionSource])).toEqual([
      [110, 'model_full_context'],
      [300, 'danmaku_heat'],
      [500, 'danmaku_heat'],
      [700, 'model_full_context']
    ]);
  });

  test('ranks the heat route from danmaku signals instead of subtitle-inflated total score', () => {
    const heat = ownStreamClipper.buildDanmakuHeatClips([
      { index: 1, start: 10, end: 60, duration: 50, reason: 'subtitle_keyword+danmaku_density', score: 999, danmakuCount: 3, reactionCount: 0 },
      { index: 2, start: 100, end: 160, duration: 60, reason: 'danmaku_density', score: 20, danmakuCount: 15, reactionCount: 3 }
    ], 1);

    expect(heat).toHaveLength(1);
    expect(heat[0].candidateIndex).toBe(2);
    expect(heat[0].score).toBe(39);
    expect(heat[0].selectionSource).toBe('danmaku_heat');
  });

  test('shows heat/model source counts once above the WeChat clip list', () => {
    const markdown = ownStreamClipper.buildNotifyMarkdown([
      {
        window: { start: 75, duration: 90 },
        copy: { title: '弹幕热度片段' },
        candidate: { selectionSource: 'danmaku_heat' },
        output: { mediaPath: 'D:/clips/one.mp4' }
      },
      {
        window: { start: 180, duration: 45 },
        copy: { title: '模型决定片段' },
        candidate: { selectionSource: 'model_full_context' },
        output: { mediaPath: 'D:/clips/two.mp4' }
      }
    ], {
      streamTitle: '双路实验',
      recordedAt: '2026-07-14 12:00:00',
      outputRoot: 'D:/clips'
    });

    expect(markdown).toContain('来源统计: 弹幕热度 1，模型全量 1');
    expect(markdown).toContain('1. 弹幕热度片段');
    expect(markdown).toContain('2. 模型决定片段');
    expect(markdown).not.toContain('[弹幕热度]');
    expect(markdown).not.toContain('[模型全量]');
  });

  test('keeps source labels out of compacted WeChat clip lists', () => {
    const results = Array.from({ length: 30 }, (_, index) => ({
      window: { start: index * 90, duration: 60 },
      copy: { title: `模型片段 ${index + 1} ${'很有趣'.repeat(60)}` },
      candidate: { selectionSource: 'model_full_context' },
      output: { mediaPath: `D:/clips/${index + 1}.mp4` }
    }));

    const markdown = ownStreamClipper.buildNotifyMarkdown(results, {
      streamTitle: '超长通知测试',
      recordedAt: '2026-07-29 12:00:00',
      outputRoot: 'D:/clips'
    });

    expect(markdown).toContain('来源统计: 模型全量 30');
    expect(markdown).toContain('1. 模型片段 1');
    expect(markdown).toContain('请看 Review');
    expect(markdown).not.toContain('[模型全量]');
  });
});
