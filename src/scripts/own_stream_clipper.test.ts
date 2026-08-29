const fs = require('fs');
const os = require('os');
const path = require('path');
const ownStreamClipper = require('./own_stream_clipper');
const fullLiveContext = require('./full_live_context');
const liveGenerationContext = require('./live_generation_context');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'own-stream-clipper-'));
}

describe('own_stream_clipper', () => {
  test('uses upload aliases and AI切片 for clip tags without the full streamer name', () => {
    const tags = ownStreamClipper.buildClipTags({
      ai: {
        streamerRegistry: {
          viridis: {
            roomIds: ['1727071052'],
            displayName: '小松绿Viridis',
            searchTags: ['小松绿'],
            uploadTags: ['Viridis']
          }
        }
      }
    }, '1727071052', '小松绿Viridis');

    expect(tags).toEqual(['Viridis', '虚拟主播', '直播切片', 'AI切片']);
  });

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
      description: '小岁从只想换显卡一路列出五个必须更换的部件。',
      reason: '字幕有完整铺垫和反转，相关窗口出现多轮刷屏。'
    });

    expect(description).toContain('录制时间 2026-06-05 19:43:31');
    expect(description).toContain('片段时间 00:01:52-00:02:25');
    expect(description).toContain('小岁从只想换显卡一路列出五个必须更换的部件。');
    expect(description).not.toContain('字幕有完整铺垫');
    expect(description).not.toContain('相关窗口');
  });

  test('adds time-weighted emotion composition to upload description', () => {
    const description = ownStreamClipper.buildClipDescription({
      streamerName: '岁己SUI',
      streamTitle: '测试直播',
      recordedAt: '2026-08-12 20:00:00',
      start: 0,
      end: 10,
      description: '小岁讲述升级电脑时发现多个部件都得一起更换。',
      reason: '字幕完整且弹幕反应密集。',
      emotionEvidence: [
        { start: 0, end: 8, emotion: 'ANGRY' },
        { start: 8, end: 10, emotion: 'SURPRISE' }
      ]
    });

    expect(description).toContain('情绪：愤怒：80% 惊讶：20%');
    expect(description).toContain('小岁讲述升级电脑时发现多个部件都得一起更换。');
    expect(description).not.toContain('弹幕反应密集');
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

  test('keeps high-signal local candidates while adding chunk-model recall to one pool', () => {
    const local = Array.from({ length: 80 }, (_, index) => ({
      index: index + 1,
      start: index * 300,
      end: index * 300 + 90,
      duration: 90,
      score: 1000 - index,
      reason: 'danmaku_density',
      danmakuCount: 20 - (index % 5),
      reactionCount: 5
    }));
    const target = local[22];
    const model = [
      {
        start: target.start + 5,
        end: target.end - 5,
        duration: 80,
        score: 190,
        modelScore: 91,
        title: '分块模型发现的持续追问话题',
        reason: '弹幕持续追问主播没说完的内容',
        candidateIndex: 'chunk-3-1',
        base: { reason: 'ai_chunked_plan', score: 91, selectionSource: 'model_chunked' }
      },
      ...Array.from({ length: 39 }, (_, index) => ({
        start: 30000 + index * 300,
        end: 30090 + index * 300,
        duration: 90,
        score: 180 - index,
        modelScore: 80 - index,
        title: `模型候选 ${index + 1}`,
        reason: 'ai_chunked_plan',
        candidateIndex: `chunk-4-${index + 1}`,
        base: { reason: 'ai_chunked_plan', score: 80 - index, selectionSource: 'model_chunked' }
      }))
    ];
    const config = ownStreamClipper.getOwnStreamClipsConfig({
      ownStreamClips: { ai: { maxCandidateLines: 100 } }
    });

    const pool = ownStreamClipper.buildRecallCandidatePool(local, model, config);
    const recalledTarget = pool.find((candidate: any) => (
      candidate.start < target.end && candidate.end > target.start
    ));

    expect(pool).toHaveLength(100);
    expect(pool.filter((candidate: any) => candidate.localScore > 0)).toHaveLength(80);
    expect(recalledTarget.recallSources).toEqual(expect.arrayContaining(['local_signals', 'model_chunked']));
    expect(recalledTarget.title).toBe('分块模型发现的持续追问话题');
  });

  test('samples danmaku across the full window while retaining repeated and reaction lines', () => {
    const danmaku = Array.from({ length: 30 }, (_, index) => ({
      time: index * 3,
      text: index === 0
        ? '开头弹幕'
        : index === 29
        ? '结尾弹幕'
        : index % 5 === 0
        ? '让她说'
        : '普通讨论'
    }));

    const evidence = ownStreamClipper.getWindowDanmakuEvidence(
      danmaku,
      { start: 0, end: 90 },
      ['让她说'],
      10
    );

    expect(evidence.totalCount).toBe(30);
    expect(evidence.reactionCount).toBe(5);
    expect(evidence.repeatedMessageCount).toBe(28);
    expect(evidence.repeatedTextCount).toBe(2);
    expect(evidence.activeSpanSeconds).toBe(87);
    expect(evidence.topTexts[0]).toContain('普通讨论');
    expect(evidence.sampleLines.join('\n')).toContain('开头弹幕');
    expect(evidence.sampleLines.join('\n')).toContain('让她说');
    expect(evidence.sampleLines.join('\n')).toContain('结尾弹幕');
  });

  test('adds strong emotion candidates without turning common happy labels into candidates', () => {
    const config = ownStreamClipper.getOwnStreamClipsConfig({
      ownStreamClips: {
        minClipSeconds: 20,
        maxCandidates: 10,
        prePaddingSeconds: 10,
        windowSeconds: 60
      }
    });
    const analysis = {
      status: 'completed',
      timeline: [
        { start: 20, end: 30, emotion: 'HAPPY', events: [] },
        { start: 90, end: 100, emotion: 'SURPRISE', events: ['Laughter'], text: '怎么会这样' }
      ]
    };

    const candidates = ownStreamClipper.buildCandidateWindows(
      { segments: [] },
      [],
      config,
      180,
      analysis
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].reason).toContain('emotion_signal');
    expect(candidates[0].emotions).toContain('SURPRISE');
    expect(candidates[0].events).toContain('Laughter');
    expect(candidates[0].score).toBeGreaterThanOrEqual(34);
  });

  test('keeps default selection policy inclusive and supports task-specific overrides', () => {
    expect(ownStreamClipper.getOwnStreamClipsConfig({ ownStreamClips: {} }).residualAudit.enabled).toBe(false);
    expect(ownStreamClipper.buildSelectionPolicyPromptLines({})).toEqual([
      '内容类型不做默认排除：电影、感谢、唱歌、普通聊天等，只按是否有独立内容价值、完整事件、观点、反应或反差判断。'
    ]);
    expect(ownStreamClipper.buildSelectionPolicyPromptLines({
      excludedCategories: ['电影'],
      priorityCategories: ['电脑升级'],
      requireTimeCoverage: true
    })).toEqual([
      '内容类型不做默认排除：电影、感谢、唱歌、普通聊天等，只按是否有独立内容价值、完整事件、观点、反应或反差判断。',
      '本次任务明确排除这些类型：电影。',
      '本次任务优先关注这些类型：电脑升级。',
      '本次任务要求覆盖不同时间段；不要把名额全部集中在同一小段话题内。'
    ]);
  });

  test('adds compact emotion evidence to AI context and final clip metadata', () => {
    const config = ownStreamClipper.getOwnStreamClipsConfig({ ownStreamClips: {} });
    const analysis = {
      status: 'completed',
      timeline: [
        { start: 30, end: 40, emotion: 'SURPRISE', events: ['Laughter'], text: '突然笑了' },
        { start: 40, end: 50, emotion: 'SURPRISE', events: ['Laughter'], text: '继续笑' }
      ]
    };
    const source = ownStreamClipper.buildFullContextSource(
      { segments: [{ start: 0, end: 60, text: '字幕' }] },
      [],
      config,
      analysis
    );
    const clips = ownStreamClipper.attachEmotionEvidenceToClips(
      [{ start: 20, end: 55, base: { reason: 'test' } }],
      analysis,
      config.emotionScoring
    );

    expect(source.sourceText).toContain('SenseVoice 情感/声音事件');
    expect(source.sourceText).toContain('emotion=SURPRISE');
    expect(clips[0].base.emotions).toEqual(['SURPRISE']);
    expect(clips[0].base.events).toEqual(['Laughter']);
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
      subtitleFontSizeRatio: 0.094,
      subtitlePortraitFontSizeRatio: 0.044,
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
        recommendationScore: 86,
        output: { mediaPath: 'D:/clips/one.mp4' }
      },
      {
        window: { start: 180, duration: 45 },
        copy: { title: '岁己：很有岁己想法的一段' },
        recommendationScore: 72,
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
    expect(markdown).toContain('1. 岁己：弹幕觉得这里很有趣 | 00:01:15 | 00:01:30 | 86分');
    expect(markdown).toContain('2. 岁己：很有岁己想法的一段 | 00:03:00 | 00:00:45 | 72分');
    expect(markdown).not.toContain('D:/clips/one.mp4');
  });

  test('keeps recommendation scores separate from review path fields', () => {
    const plan = ownStreamClipper.buildPlanReviewMarkdown([
      {
        start: 75,
        end: 165,
        duration: 90,
        title: '高分候选',
        reason: '事件完整',
        score: 95,
        selectionSource: 'model_global_rerank'
      }
    ], {
      streamTitle: '评分测试',
      recordedAt: '2026-06-05 19:43:31',
      outputRoot: 'D:/clips'
    });
    const review = ownStreamClipper.buildReviewMarkdown([
      {
        window: { start: 75, duration: 90 },
        copy: { title: '高分成片' },
        recommendationScore: 95,
        output: { mediaPath: 'D:/clips/one.mp4' }
      }
    ], {
      streamTitle: '评分测试',
      recordedAt: '2026-06-05 19:43:31',
      outputRoot: 'D:/clips'
    });

    expect(plan).toContain('1. 高分候选 | 00:01:15-00:02:45 | 00:01:30 | 事件完整');
    expect(plan).toContain('推荐分数: 95分');
    expect(review).toContain('1. 高分成片 | 00:01:15 | 00:01:30 | D:/clips/one.mp4');
    expect(review).toContain('推荐分数: 95分');
    expect(review).not.toContain('D:/clips/one.mp4 | 95分');
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
    expect(markdown).toContain('已回退到本地字幕/弹幕/情绪信号候选');
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

  test('passes adaptive resource profiles to clip jobs and releases their leases', async () => {
    let inFlight = 0;
    let released = 0;
    const scheduler = {
      maxConcurrency: 2,
      acquire: jest.fn(async () => {
        inFlight += 1;
        return {
          profile: { mode: 'busy', ffmpegThreads: 1 },
          release: () => {
            inFlight -= 1;
            released += 1;
          }
        };
      })
    };

    const results = await ownStreamClipper.runJobsWithConcurrency([
      async profile => ({ mode: profile.mode, threads: profile.ffmpegThreads }),
      async profile => ({ mode: profile.mode, threads: profile.ffmpegThreads })
    ], 2, { scheduler });

    expect(results).toEqual([
      { mode: 'busy', threads: 1 },
      { mode: 'busy', threads: 1 }
    ]);
    expect(scheduler.acquire).toHaveBeenCalledTimes(2);
    expect(inFlight).toBe(0);
    expect(released).toBe(2);
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
    expect(source.sourceText).toContain('=== 全量直播音轨字幕（时间均相对直播开头） ===');
    expect(source.sourceText).toContain('=== 全量观众弹幕（相同文本在短时间窗口内合并，xN 为重复次数） ===');
    expect(source.heatLines[0]).toContain('count=2');
    expect(source.heatLines[0]).toContain('baselineRatio=1');
    expect(source.heatLines[0]).not.toContain('笑死');
    expect(source.sourceText.match(/笑死/gu)).toHaveLength(1);
    expect(source.subtitleLines).toHaveLength(2);
    expect(source.danmakuLines).toHaveLength(1);
  });

  test('builds a stable versioned full-live shared prefix and round-trips its sidecar', () => {
    const input = {
      parsed: {
        segments: [
          { start: 1, end: 2, text: '第一句完整字幕' },
          { start: 61, end: 63, text: '最后一句完整字幕' }
        ]
      },
      danmaku: [
        { time: 1.2, text: '笑死' },
        { time: 1.8, text: ' 笑死 ' },
        { time: 62, text: '结尾也很好笑' }
      ],
      config: {
        fullContextDanmakuMergeWindowSeconds: 30,
        emotionScoring: { maxContextLines: 10 }
      },
      emotionAnalysis: {
        status: 'completed',
        timeline: [
          { start: 60, end: 63, emotion: 'SURPRISE', events: ['Laughter'], text: '突然笑了' }
        ]
      },
      info: { streamTitle: '缓存实验', recordedAt: '2026-08-11 20:00:00' },
      totalDuration: 90
    };

    const first = fullLiveContext.buildFullLiveSharedContext(input);
    const second = fullLiveContext.buildFullLiveSharedContext(structuredClone(input));

    expect(first.sharedPrefix).toBe(second.sharedPrefix);
    expect(first.sharedPrefix.startsWith(liveGenerationContext.SHARED_PROMPT_CACHE_START)).toBe(true);
    expect(first.sharedPrefix.endsWith(liveGenerationContext.SHARED_PROMPT_CACHE_END)).toBe(true);
    expect(first.sharedPrefix).toContain(fullLiveContext.FULL_LIVE_SHARED_PREFIX_LABEL);
    expect(first.sharedPrefix).toContain('00:00:01-00:00:02 第一句完整字幕');
    expect(first.sharedPrefix).toContain('00:01:01-00:01:03 最后一句完整字幕');
    expect(first.sharedPrefix).toContain('00:00:01-00:00:01 笑死 (x2)');
    expect(first.sharedPrefix).toContain('00:01:02 结尾也很好笑');
    expect(first.sharedPrefix).toContain('emotion=SURPRISE events=Laughter');

    const dir = makeTempDir();
    const highlightPath = path.join(dir, '录制-25788785-test_AI_HIGHLIGHT.txt');
    try {
      const saved = fullLiveContext.saveFullLiveContextSidecar(highlightPath, first);
      const loaded = fullLiveContext.loadFullLiveContextSidecar(highlightPath);
      const loadedFromDirectPath = fullLiveContext.loadFullLiveContextSidecar(saved.outputPath);

      expect(saved.outputPath).toBe(path.join(dir, '录制-25788785-test_FULL_LIVE_CONTEXT.json'));
      expect(loaded.sharedPrefix).toBe(first.sharedPrefix);
      expect(loadedFromDirectPath.sharedPrefix).toBe(first.sharedPrefix);
      expect(loaded.sourceText).toBe(first.sourceText);
      expect(loaded.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(loaded.counts).toEqual({
        subtitleLines: 2,
        rawDanmaku: 3,
        mergedDanmaku: 2,
        heatLines: 3,
        emotionLines: 1
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps viewer danmaku separate from streamer actions in the full-context prompt', async () => {
    const generator = require('./ai_text_generator');
    const generateSpy = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({
      text: JSON.stringify({
        clips: [{
          startTime: '00:00:01',
          endTime: '00:00:40',
          title: '从只换显卡到五件套全换，小岁越列越不对劲',
          coverText: '只想换显卡\\n最后全得换',
          description: '小岁从只想换显卡一路列出五个必须更换的部件。',
          reason: '字幕有完整铺垫和反转，相关窗口出现多轮刷屏。',
          score: 95
        }]
      }),
      meta: { model: 'test-model' }
    });
    const config = ownStreamClipper.getOwnStreamClipsConfig({
      ownStreamClips: {
        maxClips: 1,
        ai: { enabled: true, model: 'test-model' }
      }
    });
    const parsedInput = { segments: [{ start: 1, end: 3, text: '他是毒液啊原来如此' }] };
    const danmakuInput = [{ time: 2, text: '我是毒液！我是毒液！' }];
    const prebuiltFullLiveContext = fullLiveContext.buildFullLiveSharedContext({
      parsed: parsedInput,
      danmaku: danmakuInput,
      config,
      info: { streamTitle: '预生成测试直播', recordedAt: '2026-08-05 20:10:39' },
      totalDuration: 60
    });

    try {
      const clips = await ownStreamClipper.planClipsWithAIFullContext(
        parsedInput,
        danmakuInput,
        { roomId: '25788785', streamTitle: '测试直播', recordedAt: '2026-08-05 20:10:39' },
        60,
        config,
        {
          ai: {
            text: { enabled: true, provider: 'daiYu' },
            roomSettings: {
              '25788785': {
                fullLiveContextExperiment: { promptCacheRolloutPercent: 100 }
              }
            }
          }
        },
        null,
        null,
        prebuiltFullLiveContext,
        '花礼Harei'
      );

      const prompt = String(generateSpy.mock.calls[0][0]);
      const callOptions = generateSpy.mock.calls[0][1];
      const cachePlan = generator.getExplicitPromptCachePlan(prompt, {
        ai: { text: { sharedPromptCache: { enabled: true, explicitRolloutPercent: 100 } } }
      }, 'gpt-5.6-luna');
      expect(prompt.startsWith(liveGenerationContext.SHARED_PROMPT_CACHE_START)).toBe(true);
      expect(prompt.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END))
        .toBeLessThan(prompt.indexOf('你是资深直播切片主编'));
      expect(cachePlan.enabled).toBe(true);
      expect(cachePlan.prefix).toBe(prompt.slice(
        0,
        prompt.indexOf(liveGenerationContext.SHARED_PROMPT_CACHE_END)
          + liveGenerationContext.SHARED_PROMPT_CACHE_END.length
      ));
      expect(callOptions.promptCacheRolloutPercent).toBe(100);
      expect(prompt).toContain('直播标题: 预生成测试直播');
      expect(prompt).toContain('花礼Harei本场直播的全量带时间戳字幕和全量弹幕');
      expect(prompt).not.toContain('岁己SUI本场直播的全量带时间戳字幕和全量弹幕');
      expect(prompt).toContain('来源归属必须严格按输入分区：直播音轨字幕与观众弹幕是两类独立来源，标题、封面文案、简介和理由不得把一方的发言或行为归给另一方。');
      expect(prompt).toContain('片段时间与文案必须一一对应：先读取当前 clips 对象 startTime-endTime 范围内的直播音轨字幕和同一范围内的观众弹幕，再填写该对象的 title、coverText、description 和 reason。');
      expect(prompt).toContain('直播标题、录制时间和整场上下文只用于确认来源，不是当前片段的内容证据；禁止把直播标题中的型号、人物、事件或梗直接套进任何片段。');
      expect(prompt).toContain('严格禁止跨窗口串题：每个 clips 对象只能使用自己时间范围内能核实的内容，不得借用其他候选或其他时间窗口的文案。输出前逐条核对，若时间窗口与文案不匹配就删除该对象，不要猜测或保留错误标题。');
      expect(prompt).toContain('description 是公开简介，只写片中具体内容');
      expect(prompt).toContain('reason 是内部选材理由');
      expect(prompt).toContain('不得把 reason 复述或改写进 description');
      expect(prompt).toContain('内容类型不做默认排除：电影、感谢、唱歌、普通聊天等');
      expect(prompt).not.toContain('时间覆盖要求：不要把名额全部用在同一话题或同一小段时间内');
      expect(prompt).not.toContain('遗漏的非重叠窗口会由残余高光审计单独召回');
      expect(prompt).toContain('不要写选片理由或效果评估');
      expect(prompt).toContain('=== 全量直播音轨字幕（时间均相对直播开头） ===\n00:00:01-00:00:03 他是毒液啊原来如此');
      expect(prompt).toContain('=== 全量观众弹幕（相同文本在短时间窗口内合并，xN 为重复次数） ===\n00:00:02 我是毒液！我是毒液！');
      expect(clips[0].description).toBe('小岁从只想换显卡一路列出五个必须更换的部件。');
      expect(clips[0].reason).toBe('字幕有完整铺垫和反转，相关窗口出现多轮刷屏。');
    } finally {
      generateSpy.mockRestore();
    }
  });

  test('globally reranks strongest candidates and keeps sustained viewer follow-up in the prompt', async () => {
    const generator = require('./ai_text_generator');
    const generateSpy = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({
      text: JSON.stringify({
        clips: [{
          candidateIndex: 3,
          startTime: '00:02:40',
          endTime: '00:03:40',
          title: '一句没说完的话让弹幕集体追问后续',
          coverText: '到底想说什么\n弹幕还在追问',
          description: '小岁话说到一半停住，弹幕持续追问她原本想说的内容。',
          reason: '主播反应与观众持续追问形成完整互动。',
          score: 94
        }]
      }),
      meta: { model: 'test-model' }
    });
    const config = ownStreamClipper.getOwnStreamClipsConfig({
      ownStreamClips: {
        maxClips: 50,
        minClipSeconds: 20,
        ai: {
          enabled: true,
          model: 'test-model',
          maxCandidateLines: 2,
          maxCandidateSubtitleChars: 520,
          maxCandidateDanmakuLines: 14
        },
        reactionKeywords: ['算了什么', '让她说', '细说一下']
      }
    });
    const candidates = [
      { index: 1, start: 0, end: 60, score: 10, recallScore: 10, reason: '低信号一' },
      { index: 2, start: 80, end: 140, score: 20, recallScore: 20, reason: '低信号二' },
      {
        index: 3,
        start: 155,
        end: 235,
        score: 99,
        recallScore: 99,
        localScore: 727,
        modelScore: 0,
        recallSources: ['local_signals'],
        recallReasons: ['弹幕持续追问'],
        reason: 'danmaku_density+danmaku_reaction'
      }
    ];
    const parsedInput = {
      segments: [
        { start: 0, end: 10, text: '普通开场' },
        { start: 90, end: 100, text: '普通内容' },
        { start: 160, end: 180, text: '我本来想说一个事情，算了不说了' },
        { start: 180, end: 220, text: '弹幕怎么还在问，我继续解释一下' },
        { start: 240, end: 260, text: '下一个话题' }
      ]
    };
    const danmakuInput = [
      { time: 165, text: '算了什么' },
      { time: 180, text: '让她说' },
      { time: 210, text: '细说一下' }
    ];

    try {
      const clips = await ownStreamClipper.refineCandidatesWithAI(
        candidates,
        parsedInput,
        danmakuInput,
        { streamTitle: '测试直播', recordedAt: '2026-08-17 20:04:16' },
        config,
        { ai: { text: { enabled: true, provider: 'daiYu' } } }
      );

      const prompt = String(generateSpy.mock.calls[0][0]);
      const callOptions = generateSpy.mock.calls[0][1];
      expect(prompt).toContain('#3 00:02:35-00:03:55');
      expect(prompt).not.toContain('#1 00:00:00-00:01:00');
      expect(prompt).toContain('弹幕持续追问或要求细说');
      expect(prompt).toContain('算了什么');
      expect(prompt).toContain('让她说');
      expect(prompt).toContain('细说一下');
      expect(callOptions).toMatchObject({
        wordLimit: 7000,
        primaryModel: 'test-model'
      });
      expect(clips).toHaveLength(1);
      expect(clips[0]).toMatchObject({
        start: 160,
        end: 220,
        score: 94,
        selectionSource: 'model_global_rerank'
      });
    } finally {
      generateSpy.mockRestore();
    }
  });

  test('keeps all 50 globally selected clips without the old 24-clip truncation', async () => {
    const generator = require('./ai_text_generator');
    const candidates = Array.from({ length: 50 }, (_, index) => ({
      index: index + 1,
      start: index * 240,
      end: index * 240 + 60,
      duration: 60,
      score: 100 - index,
      recallScore: 100 - index,
      localScore: 500 - index,
      recallSources: ['local_signals'],
      reason: 'test_signal'
    }));
    const generateSpy = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({
      text: JSON.stringify({
        clips: candidates.map((candidate, index) => ({
          candidateIndex: candidate.index,
          startTime: ownStreamClipper.formatClock(candidate.start),
          endTime: ownStreamClipper.formatClock(candidate.end),
          title: `最终候选 ${index + 1}`,
          coverText: `候选 ${index + 1}`,
          description: `第 ${index + 1} 个独立话题。`,
          reason: '内容完整且可以独立发布。',
          score: 100 - index
        }))
      }),
      meta: { model: 'test-model' }
    });
    const config = ownStreamClipper.getOwnStreamClipsConfig({
      ownStreamClips: {
        maxClips: 50,
        ai: {
          enabled: true,
          model: 'test-model',
          maxCandidateLines: 100
        }
      }
    });
    const parsedInput = {
      segments: candidates.map((candidate, index) => ({
        start: candidate.start,
        end: candidate.end,
        text: `第 ${index + 1} 个完整话题`
      }))
    };

    try {
      const clips = await ownStreamClipper.refineCandidatesWithAI(
        candidates,
        parsedInput,
        [],
        { streamTitle: '五十条上限测试', recordedAt: '2026-08-27 20:00:00' },
        config,
        { ai: { text: { enabled: true, provider: 'daiYu' } } }
      );

      expect(clips).toHaveLength(50);
      expect(clips[24].title).toBe('最终候选 25');
      expect(clips[49].title).toBe('最终候选 50');
      expect(generateSpy.mock.calls[0][1].wordLimit).toBe(7000);
    } finally {
      generateSpy.mockRestore();
    }
  });

  test('removes overlaps after subtitle alignment and keeps the higher-scored clip', () => {
    const clips = ownStreamClipper.removeOverlappingClips([
      { start: 100, end: 180, score: 80, title: 'lower' },
      { start: 170, end: 240, score: 95, title: 'higher' },
      { start: 240, end: 300, score: 70, title: 'touching is allowed' }
    ]);

    expect(clips.map((clip: any) => clip.title)).toEqual(['higher', 'touching is allowed']);
  });

  test('production staged own-stream clipping covers Sui and the activity rooms', () => {
    const production = require('../../config/production.json');

    expect(production.ownStreamClips.enabled).toBe(true);
    expect(production.ownStreamClips.roomIds).toEqual([
      '25788785',
      '1820703922',
      '1713546334',
      '1727074031',
      '23771092'
    ]);
    expect(production.ownStreamClips.maxClips).toBe(50);
    expect(production.ownStreamClips.maxCandidates).toBe(80);
    expect(production.ownStreamClips.ai.strategy).toBe('staged');
    expect(production.ownStreamClips.ai.model).toBe('gpt-5.6-luna');
    expect(production.ownStreamClips.ai.maxCandidateLines).toBe(100);
    expect(production.ownStreamClips.parallel.enabled).toBe(false);
  });

  test('keeps activity streamer and event tags in own-stream upload metadata', () => {
    const production = require('../../config/production.json');
    const expected = {
      '1820703922': ['花礼Harei', '芙娅之魂'],
      '1713546334': ['灰泽满Hazel', '芙娅之魂'],
      '1727074031': ['chu2u', '羽啾chu2u', '芙娅之魂'],
      '23771092': ['又一充电中', '芙娅之魂']
    };

    for (const [roomId, uploadTags] of Object.entries(expected)) {
      const entry = Object.values(production.ai.streamerRegistry)
        .find((candidate: any) => candidate.roomIds?.map(String).includes(roomId));
      expect(entry).toBeDefined();
      expect((entry as any).uploadTags).toEqual(uploadTags);
      expect(ownStreamClipper.buildClipTags(
        production,
        roomId,
        (entry as any).displayName
      )).toEqual(expect.arrayContaining([...uploadTags, '虚拟主播', '直播切片', 'AI切片']));
    }
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

  test('keeps a normal multibyte clip list complete when it only needs two messages', () => {
    const results = Array.from({ length: 32 }, (_, index) => ({
      window: { start: index * 90, duration: 60 },
      copy: { title: `小岁片段 ${index + 1} ${'很有趣'.repeat(20)}` },
      candidate: { selectionSource: 'model_full_context' },
      output: { mediaPath: `D:/clips/${index + 1}.mp4` }
    }));

    const markdown = ownStreamClipper.buildNotifyMarkdown(results, {
      streamTitle: '正常中文通知',
      recordedAt: '2026-08-30 03:00:00',
      outputRoot: 'D:/clips'
    });

    expect(markdown).toContain('32. 小岁片段 32');
    expect(markdown).not.toContain('请看 Review');
    expect(ownStreamClipper.splitWeChatMarkdown(markdown).length).toBeLessThanOrEqual(2);
    expect(ownStreamClipper.splitWeChatMarkdown(markdown).every((part: string) => (
      Buffer.byteLength(part, 'utf8') <= 4096
    ))).toBe(true);
  });

  test('includes clipping duration and CPU/GPU resource statistics in WeChat notifications', () => {
    const stats = ownStreamClipper.buildClipProcessingStats([
      {
        processing: {
          elapsedMs: 30000,
          resourcePeaks: [{
            samples: 3,
            hostCpuAvgPct: 40,
            hostCpuPeakPct: 60,
            gpuAvailable: true,
            gpuSamples: 3,
            gpuUtilAvgPct: 80,
            gpuUtilPeakPct: 90,
            gpuMemoryUsedPeakMb: 4000,
            gpuMemoryTotalMb: 12000
          }]
        }
      },
      {
        processing: {
          elapsedMs: 50000,
          resourcePeaks: [{
            samples: 4,
            hostCpuAvgPct: 20,
            hostCpuPeakPct: 70,
            gpuAvailable: true,
            gpuSamples: 2,
            gpuUtilAvgPct: 60,
            gpuUtilPeakPct: 95,
            gpuMemoryUsedPeakMb: 4500,
            gpuMemoryTotalMb: 12000
          }]
        }
      }
    ], 90000, '2026-08-25T12:00:00.000Z', '2026-08-25T12:01:30.000Z');

    const markdown = ownStreamClipper.buildNotifyMarkdown([
      {
        window: { start: 75, duration: 90 },
        copy: { title: '统计测试片段' },
        candidate: { selectionSource: 'model_full_context' },
        output: { mediaPath: 'D:/clips/one.mp4' },
        processing: { elapsedMs: 30000, resourcePeaks: [] }
      },
      {
        window: { start: 180, duration: 45 },
        copy: { title: '统计测试片段二' },
        candidate: { selectionSource: 'danmaku_heat' },
        output: { mediaPath: 'D:/clips/two.mp4' },
        processing: { elapsedMs: 50000, resourcePeaks: [] }
      }
    ], {
      streamTitle: '统计测试直播',
      recordedAt: '2026-08-25 12:00:00',
      outputRoot: 'D:/clips',
      processingStats: stats
    });

    expect(stats).toMatchObject({
      totalElapsedMs: 90000,
      averageClipElapsedMs: 40000,
      resource: {
        hostCpuAvgPct: 28.57,
        hostCpuPeakPct: 70,
        gpuUtilAvgPct: 72,
        gpuUtilPeakPct: 95,
        gpuMemoryUsedPeakMb: 4500,
        gpuMemoryTotalMb: 12000
      }
    });
    expect(markdown).toContain('切片耗时: 总耗时 1分30秒，平均每个切片 40秒（2 段）');
    expect(markdown).toContain('CPU 平均 28.6% / 峰值 70%');
    expect(markdown).toContain('GPU 平均 72% / 峰值 95%');
    expect(markdown).toContain('显存峰值 4.4 GB/11.7 GB');
  });
});
