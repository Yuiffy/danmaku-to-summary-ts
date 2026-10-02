import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
const plan = require('./stream_game_plan');
const render = require('./stream_game_render');

describe('complete game recordings', () => {
  const config = plan.getGameConfig({});
  const event = (start: number, end: number, extra = {}) => ({ id: 'game-1', gameId: 'elden-ring', start, end,
    startObserved: true, endObserved: true, evidenceIds: ['T1'], chapters: [], excludedRanges: [], windows: [1], ...extra });

  test('keeps gameplay across detection windows and a short unconfirmed break', () => {
    const merged = plan.mergeEvents([event(10, 2000, { endObserved: false }), event(2010, 4000, { startObserved: false })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ start: 10, end: 4000, reviewIssues: [] });
    expect(plan.mergeEvents([event(10, 2000), event(2400, 4000)])).toHaveLength(2);
  });

  test('unknown proper names retain the gameplay with a factual generic chapter', () => {
    const window = { index: 1, start: 0, end: 100, from: 0, to: 100, rows: [
      { id: 'T1', start: 5, end: 10, text: '我们开始玩游戏' }, { id: 'D1', start: 12, end: 12, text: '大树守卫' } ] };
    const raw = { events: [{ ...event(5, 90), chapters: [{ start: 10, title: '女武神', kind: 'boss',
      nameEvidence: '女武神', description: '挑战女武神。', evidenceIds: ['T1'] }] }] };
    const parsed = plan.parseEvents(raw, window, 100, config);
    expect(parsed[0].chapters[0]).toMatchObject({ title: '探索与战斗', titleIssue: 'proper_name_not_grounded' });
    raw.events[0].chapters[0].evidenceIds = ['missing'];
    expect(() => plan.parseEvents(raw, window, 100, config)).toThrow(/citations/);
  });

  test('a premature observed ending cannot truncate a later continuing window', () => {
    const merged = plan.mergeEvents([event(100, 1500), event(1400, 3500, { startObserved: false, endObserved: false })]);
    expect(merged[0]).toMatchObject({ start: 100, end: 3500, startObserved: true, endObserved: false });
    expect(merged[0].reviewIssues).toContain('end_boundary_unconfirmed');
  });

  test('dense audience context shrinks without dropping source rows or leaving coverage gaps', () => {
    const rows = plan.evidenceRows([], Array.from({ length: 12 }, (_, i) => ({ time: i * 10 + 5, text: '弹'.repeat(3000) })));
    const windows = plan.detectionWindows(rows, 120, { ...config, chunkSeconds: 60, contextSeconds: 180, maxEvidenceChars: 19000 });
    expect(windows[0].start).toBe(0);
    expect(windows.at(-1).end).toBe(120);
    expect(windows.every((w: any, i: number) => w.text.length <= 19000 && (!i || w.start === windows[i - 1].end))).toBe(true);
    expect(new Set(windows.flatMap((w: any) => w.rows.map((r: any) => r.id))).size).toBe(rows.length);
  });

  test('all allowed gameplay is covered exactly once, with explicit exclusion gaps', () => {
    const events = [event(0, 5000, { excludedRanges: [{ start: 2000, end: 2100 }], chapters: [
      { start: 0, title: '探索', kind: 'phase', description: '探索地图。', evidenceIds: ['T1'] },
      { start: 3000, title: '挑战 Boss', kind: 'phase', description: '进行挑战。', evidenceIds: ['T1'] } ] })];
    const parts = plan.buildParts(events, config);
    expect(parts.reduce((n: number, p: any) => n + p.duration, 0)).toBeCloseTo(4900);
    expect(parts.every((p: any) => p.end <= 2000 || p.start >= 2100)).toBe(true);
    expect(parts.every((p: any) => p.duration <= config.maxPartSeconds)).toBe(true);
  });

  test('dense tiny chapters remain in a few complete Ps, with verified Boss names preserved', () => {
    const chapters = [0, 10, 13, 320, 950, 950.24, 1600, 2100, 2600, 3000, 3500, 4200].map((start, index) => ({
      start, title: `阶段${index}`, kind: 'phase', description: `阶段${index}的原内容。`, evidenceIds: ['T1'] }));
    Object.assign(chapters[3], { title: '接肢葛瑞克战', kind: 'boss', nameEvidence: '接肢葛瑞克' });
    const parts = plan.buildParts([event(0, 4500, { chapters })], config);
    expect(parts.length).toBeLessThanOrEqual(4);
    expect(parts.every((p: any, i: number) => p.duration >= 300 && p.duration <= config.maxPartSeconds
      && (i === 0 ? p.start === 0 : p.start === parts[i-1].end))).toBe(true);
    expect(parts.at(-1).end).toBe(4500);
    for (const chapter of chapters) expect(parts.some((p: any) => p.chapters.some((c: any) =>
      c.start === chapter.start && c.title === chapter.title))).toBe(true);
    expect(parts.some((p: any) => p.title.includes('接肢葛瑞克战'))).toBe(true);
  });

  test('without multipart permission, episodes retain all footage in hour-long videos', () => {
    const pieces = render.singleParts([event(0, 15000)], config, { maxVideoSeconds: 10800, multipartAllowed: false });
    expect(pieces).toHaveLength(5);
    expect(pieces.every((p: any, i: number) => p.duration <= 3600 && (i === 0 || pieces[i - 1].end === p.start))).toBe(true);
    expect(pieces.reduce((n: number, p: any) => n + p.duration, 0)).toBe(15000);
  });

  test('short splits prefer chapter transitions while avoiding tiny tails and excluded talk', () => {
    const pieces = render.singleParts([event(0, 8100, { excludedRanges: [{ start: 6000, end: 6100 }], chapters: [
      { start: 0, title: '探索', description: '探索地图。' },
      { start: 3300, title: '挑战 Boss', description: '开始挑战。' },
      { start: 5900, title: '返回赐福', description: '调整装备。' } ] })], config, { maxVideoSeconds: 10800 });
    expect(pieces[0].end).toBe(3300);
    expect(pieces[1].start).toBe(3300);
    expect(pieces[2].start).toBe(6100);
    expect(pieces.reduce((n: number, p: any) => n + p.duration, 0)).toBe(8000);
    expect(pieces.every((p: any) => p.duration <= 3600 && (p.end <= 6000 || p.start >= 6100))).toBe(true);
    const tail = render.singleParts([event(0, 7300, { chapters: [{ start: 3590, title: '地点转换' }, { start: 7190, title: '收尾' }] })], config,
      { maxVideoSeconds: 10800 });
    expect(Math.min(...tail.map((p: any) => p.duration))).toBeGreaterThan(1000);
  });

  test('oversized exports split shorter without changing encoder settings and completed reruns reuse media', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-sizing-'));
    try {
      const mediaPath = path.join(directory, 'source.flv'), srtPath = path.join(directory, 'source.srt');
      fs.writeFileSync(mediaPath, 'source');
      fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:03:20,000\n游戏\n\n');
      const root = { ownStreamClips: { subtitleVideoEncoder: 'h264_nvenc', subtitleCrf: 23 } };
      const options: any = { mediaPath, srtPath, config: root, registerUpload: false,
        episodeRegistryPath: path.join(directory, 'episodes.json'),
        capabilities: { collectionAllowed: true, externalSubtitlesAllowed: true, multipartAllowed: false,
          maxVideoSeconds: 10800, maxFileBytes: 75 },
        scheduler: () => ({ acquire: async () => ({ profile: {}, release: () => {} }), stop: async () => {} }),
        renderPart: jest.fn(async (_source: string, part: any, output: string, settings: any) => {
          expect(settings).toBe(root);
          fs.writeFileSync(output, Buffer.alloc(Math.ceil(part.duration)));
          return { ...part, mediaPath: output, bytes: fs.statSync(output).size, actualDuration: part.duration,
            sha256: require('./source_snapshot').fileDigest(output), burnedSubtitles: false };
        }),
        cover: async (_part: any, output: string) => fs.writeFileSync(output, 'cover') };
      const gamePlan: any = { source: require('./source_snapshot').sourceSnapshot({ source: options }),
        status: 'planned', sessionId: 'sizing-source', recordedAt: '2026-01-01T20:00:00', streamerName: '岁己', streamTitle: '游戏',
        coverage: { status: 'complete', duration: 200, windows: [{ start: 0, end: 200, status: 'inspected' }] },
        events: [event(0, 200, { verification: { version: 3, protocolVersion: require('./stream_game_verification').PROTOCOL_VERSION,
          decision: 'keep', publicCopySupported: true } })] };
      const files = { directory, plan: path.join(directory, 'PLAN.json'), review: path.join(directory, 'REVIEW.md') };
      const shortConfig = { ...config, maxSingleVideoSeconds: 100 };
      const result = await render.renderGames(gamePlan, options, shortConfig, files);
      expect(result.submissions).toBe(4);
      expect(gamePlan.renderDurationLimit).toBe(50);
      const rows = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8')).clips.map((c: any) => JSON.parse(fs.readFileSync(c.metadataPath, 'utf8')));
      expect(rows.reduce((n: number, row: any) => n + row.window.duration, 0)).toBe(200);
      expect(rows.every((row: any) => row.output.parts[0].bytes <= 75)).toBe(true);
      const calls = options.renderPart.mock.calls.length;
      await render.renderGames(gamePlan, options, { ...shortConfig, maxSingleVideoSeconds: 30 }, files);
      expect(options.renderPart.mock.calls.length).toBe(calls);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('external subtitle timing is clipped and rebased to its own video', () => {
    const cues = render.clippedCues([{ start: 8, end: 12, text: '开头' }, { start: 19, end: 24, text: '结尾' },
      { start: 24, end: 25, text: '后续' }], { start: 10, end: 20, actualDuration: 10 });
    expect(cues).toEqual([{ start: 0, end: 2, text: '开头' }, { start: 9, end: 10, text: '结尾' }]);
  });

  test('episode numbers survive reruns and cannot be reused for another recording', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'game-episode-'));
    try {
      const file = path.join(directory, 'episodes.json');
      expect(render.reserveEpisode('elden-ring', 'source-a', '2026-01-01', 1, file)).toBe(1);
      expect(render.reserveEpisode('elden-ring', 'source-a', '2026-01-01', null, file)).toBe(1);
      expect(() => render.reserveEpisode('elden-ring', 'source-b', '2026-01-02', 1, file)).toThrow(/Duplicate/);
      expect(render.reserveEpisode('elden-ring', 'source-b', '2026-01-02', null, file)).toBe(2);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
