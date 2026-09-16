const fs = require('fs');
const os = require('os');
const path = require('path');
const topicCompilation = require('./topic_compilation');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'topic-compilation-'));
}

function writeSourceFiles(root: string) {
  const srtPath = path.join(root, '录制-20260824-200000-测试.srt');
  const xmlPath = path.join(root, '录制-20260824-200000-测试.xml');
  fs.writeFileSync(srtPath, [
    '1',
    '00:00:10,000 --> 00:00:12,000',
    '我觉得冷恋萌很有意思',
    '',
    '2',
    '00:00:12,100 --> 00:00:14,000',
    '然后它就这样了',
    '',
    '3',
    '00:00:30,000 --> 00:00:32,000',
    '冷恋萌真的很可爱',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(xmlPath, [
    '<i>',
    '<d p="10,1,25,16777215,1710000000,0,user-a,0">冷脸萌</d>',
    '<d p="30,1,25,16777215,1710000001,0,user-b,0">冷脸萌</d>',
    '</i>'
  ].join(''), 'utf8');
  return { srtPath, xmlPath };
}

describe('topic_compilation', () => {
  test('discovers timestamp from a recording filename', () => {
    expect(topicCompilation.inferRecordedAt(
      'D:/录播/2026_08_24/录制-25788785-20260824-201856-405-直播.flv'
    )).toBe('2026-08-24 20:18:56');
  });

  test('extracts ASR-like aliases near a topic', () => {
    expect(topicCompilation.extractCandidateTerms('我觉得冷恋萌很可爱', '冷脸萌')).toContain('冷恋萌');
  });

  test('uses danmaku evidence to promote a repeated ASR alias', () => {
    const aliases = topicCompilation.discoverAsrAliases([
      {
        sourceId: 'source-a',
        aliasEvidence: [
          { evidenceId: 'a-1', eventTime: 10, danmakuText: '冷脸萌', srtText: '我觉得冷恋萌很可爱' },
          { evidenceId: 'a-2', eventTime: 30, danmakuText: '冷脸萌', srtText: '冷恋萌真的很可爱' }
        ]
      }
    ], '冷脸萌', ['冷脸萌'], topicCompilation.DEFAULT_PROFILES.compact);

    expect(aliases.find(item => item.term === '冷恋萌')).toMatchObject({
      evidenceCount: 2,
      accepted: true
    });
  });

  test('finds a topic through XML-guided ASR aliases', async () => {
    const root = makeTempDir();
    try {
      const files = writeSourceFiles(root);
      const result = await topicCompilation.searchTopic([{
        id: 'source-a',
        sourceKey: files.srtPath,
        mediaPath: null,
        srtPath: files.srtPath,
        xmlPath: files.xmlPath,
        recordedAt: '2026-08-24 20:00:00',
        streamTitle: '测试直播'
      }], '冷脸萌', {});

      expect(result.searchTerms.autoAliases.some(item => item.term === '冷恋萌')).toBe(true);
      expect(result.sourceResults[0].matches).toHaveLength(2);
      expect(result.searchableTerms).toContain('冷恋萌');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('merges nearby hits and extends an unfinished sentence only within the profile', () => {
    const profile = topicCompilation.resolveProfile('compact');
    const windows = topicCompilation.buildSourceWindows({
      id: 'source-a',
      mediaPath: 'D:/test.flv',
      srtPath: 'D:/test.srt',
      recordedAt: '2026-08-24 20:00:00',
      streamTitle: '测试直播'
    }, [
      { start: 10, end: 11, text: '我觉得' },
      { start: 11.1, end: 12, text: '冷脸萌' },
      { start: 12.1, end: 13, text: '然后呢' },
      { start: 13.1, end: 14, text: '真的很可爱。' },
      { start: 20, end: 21, text: '无关内容' }
    ], [
      { segmentIndex: 1, start: 11.1, end: 12, text: '冷脸萌', matchedTerms: ['冷脸萌'], evidence: ['srt_keyword'] },
      { segmentIndex: 2, start: 12.1, end: 13, text: '然后呢', matchedTerms: [], evidence: ['danmaku_guided'] }
    ], profile);

    expect(windows).toHaveLength(1);
    expect(windows[0].start).toBeLessThanOrEqual(10);
    expect(windows[0].end).toBeGreaterThanOrEqual(14);
    expect(windows[0].end).toBeLessThan(22);
    expect(windows[0].boundaryAdjusted).toBe(true);
  });

  test('flags a long source subtitle block for re-ASR before building', () => {
    const profile = topicCompilation.resolveProfile('compact');
    const windows = topicCompilation.buildSourceWindows({
      id: 'source-a',
      mediaPath: 'D:/test.flv',
      srtPath: 'D:/test.srt',
      recordedAt: '2026-08-24 20:00:00',
      streamTitle: '测试直播'
    }, [
      { start: 100, end: 112, text: '前后多个话题被错误合在一个字幕块里' },
      { start: 112.2, end: 113, text: '目标词' }
    ], [
      { segmentIndex: 1, start: 112.2, end: 114.5, text: '目标词', matchedTerms: ['目标词'], evidence: ['srt_keyword'] }
    ], profile);

    expect(windows).toHaveLength(1);
    expect(windows[0].needsReAsr).toBe(true);
    expect(windows[0].reAsrReason).toContain('12.0 秒');
  });

  test('does not pull an unrelated next topic after a complete short keyword', () => {
    const profile = topicCompilation.resolveProfile('compact');
    const windows = topicCompilation.buildSourceWindows({
      id: 'source-a',
      mediaPath: 'D:/test.flv',
      srtPath: 'D:/test.srt',
      recordedAt: '2026-08-24 20:00:00',
      streamTitle: '测试直播'
    }, [
      { start: 10, end: 11.5, text: '冷脸萌' },
      { start: 12.5, end: 14, text: '巨人怎么打。' }
    ], [
      { segmentIndex: 0, start: 10, end: 11.5, text: '冷脸萌', matchedTerms: ['冷脸萌'], evidence: ['srt_keyword'] }
    ], profile);

    expect(windows).toHaveLength(1);
    expect(windows[0].end).toBeLessThan(12.5);
  });

  test('keeps the higher quality overlapping recording and records the duplicate', () => {
    const sources = new Map([
      ['raw', { id: 'raw', priority: 0, isMerged: false, mediaPath: null }],
      ['merged', { id: 'merged', priority: 10, isMerged: true, mediaPath: null }]
    ]);
    const result = topicCompilation.dedupeCrossSourceWindows([
      { sourceId: 'raw', start: 10, end: 20, duration: 10, absoluteStart: 100000, absoluteEnd: 110000, evidence: [], subtitlePreview: 'raw' },
      { sourceId: 'merged', start: 11, end: 21, duration: 10, absoluteStart: 101000, absoluteEnd: 111000, evidence: ['srt_keyword'], subtitlePreview: 'merged' }
    ], sources, topicCompilation.DEFAULT_PROFILES.compact);

    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].sourceId).toBe('merged');
    expect(result.removed[0].duplicateOf).toBe('merged');
  });

  test('parses repeatable CLI terms and profile overrides', () => {
    const args = topicCompilation.parseArgs([
      'search', '--topic', '冷脸萌', '--keyword', '冷脸梦', '--danmaku-keyword', '冷脸萌',
      '--profile', 'balanced', '--merge-gap', '7', '--no-auto-aliases'
    ]);

    expect(args).toMatchObject({
      command: 'search',
      topic: '冷脸萌',
      keywords: ['冷脸梦'],
      danmakuKeywords: ['冷脸萌'],
      profile: 'balanced',
      mergeGapSeconds: '7',
      autoAliases: false
    });
  });

  test('supports a custom media adapter and overlay template', () => {
    const parseSrt = jest.fn();
    const writeSrt = jest.fn();
    const cutMedia = jest.fn();
    const runFfmpeg = jest.fn();
    const adapter = topicCompilation.resolveCompilationMediaAdapter({
      rootConfig: {},
      parseSrt,
      writeSrt,
      cutMedia,
      runFfmpeg,
      buildMediaConfig: () => ({ encoder: 'test' }),
      createScheduler: () => ({ enabled: false })
    });

    expect(adapter.parseSrt).toBe(parseSrt);
    expect(adapter.writeSrt).toBe(writeSrt);
    expect(adapter.cutMedia).toBe(cutMedia);
    expect(adapter.runFfmpeg).toBe(runFfmpeg);
    expect(adapter.buildMediaConfig()).toEqual({ encoder: 'test' });
    expect(topicCompilation.formatOverlayLabel(
      { id: 'event-1', sequence: 3, eventDateTime: '2026-08-24 20:00:00' },
      { overlayTemplate: '{id} / {sequence} / {eventDateTime}' }
    )).toBe('event-1 / 3 / 2026-08-24 20:00:00');
  });

  test('uses an injected SRT parser when assembling the compilation subtitle', () => {
    const root = makeTempDir();
    try {
      const outputPath = path.join(root, 'compilation.srt');
      const parseSrt = jest.fn(() => ({
        segments: [{ start: 0, end: 1.25, text: 'custom parser output' }]
      }));

      const result = topicCompilation.writeCompilationSrt([
        { srtPath: 'adapter-owned.srt', actualDuration: 1.5 }
      ], outputPath, { parseSrt });

      expect(parseSrt).toHaveBeenCalledWith('adapter-owned.srt');
      expect(result).toEqual({ duration: 1.5, segmentCount: 1 });
      expect(fs.readFileSync(outputPath, 'utf8')).toContain('custom parser output');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an empty compilation plan before invoking media tools', async () => {
    await expect(topicCompilation.buildCompilation({ clips: [], sources: [] }, 'empty.mp4'))
      .rejects.toThrow('计划没有可编译片段');
  });
});
