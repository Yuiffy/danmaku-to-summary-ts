import { bindTranscriptTitles, namedEvents, songDate, songTitle, songSubmissionTitle, songSubmissionTags, songCoverSubject,
  watchTitleAppears, recoverWatchNames, recoverSongNames, watchCoverSubject, watchSubmissionTitle } from './activityTitles';

test('titles use verified song names and the recording date without zero padding', () => {
  expect(songDate('2026-10-02 20:24:20')).toBe('2026.10.2');
  expect(songTitle('泡泡', songDate('2026-10-01'))).toBe('泡泡-2026.10.1');
  expect(songSubmissionTitle([{ name: "Don't Look Back in Anger" }, { name: 'Moon River' }], '2026.10.2', 72))
    .toBe("Don't Look Back in Anger / Moon River-2026.10.2");
});

test('covers keep the first three distinct names visible and do not invent an unknown name', () => {
  expect(songCoverSubject([{ name: '泡泡' }, { name: '泡泡' }, { name: null }])).toBe('泡泡\n待确认歌名');
  expect(songCoverSubject([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }])).toBe('A\nB\nC');
});

test('song tags keep distinct complete names in performance order before generic labels', () => {
  expect(songSubmissionTags([{ name: ' 泡泡 ' }, { name: "Don't Look Back in Anger" }, { name: '泡泡' }, { name: null }, { name: ' ' }, { name: '待确认歌名' }],
    ['岁己', '泡泡', '歌切'])).toEqual(['泡泡', "Don't Look Back in Anger", '岁己', '歌切']);
  const parts = Array.from({ length: 11 }, (_, i) => ({ name: `歌曲${i + 1}` }));
  expect(songSubmissionTags(parts.slice(0, 8), ['岁己', '小岁', '歌切', '虚拟主播']))
    .toEqual([...parts.slice(0, 8).map(p => p.name), '岁己', '小岁']);
  expect(songSubmissionTags(parts, ['岁己', '歌切'])).toEqual(parts.slice(0, 10).map(p => p.name));
});

test('multiple reviewed names bind source transcript rows and cannot borrow another performance title', () => {
  const events = [{ id: 'a1', start: 100, end: 300 }, { id: 'a2', start: 1000, end: 1200 }];
  const rows = [{ index: 1, start: 90, end: 96, text: '现在唱泡泡' }, { index: 2, start: 960, end: 966, text: 'Moon River我唱过吗' }];
  const items = [{ activityId: 'a1', name: '泡泡', segmentIndices: [1], note: '主播点歌' },
    { activityId: 'a2', name: 'Moon River', segmentIndices: [2], note: '主播点歌' }];
  const evidence = bindTranscriptTitles(items, events, rows, { path: 'original.srt', sha256: 'bound' });
  expect(namedEvents(events, evidence).map(e => e.name)).toEqual(['泡泡', 'Moon River']);
  expect(() => bindTranscriptTitles([{ ...items[1], segmentIndices: [1] }], events, rows, {})).toThrow();
  expect(() => bindTranscriptTitles([{ ...items[0], name: '另一首' }], events, rows, {})).toThrow();
});

test('watch names reuse cited source evidence with equivalent sequel numbers, without borrowing an unrelated recommendation', () => {
  const events = [{ id: 'w1', kind: 'watch', start: 100, end: 1000, name: null, evidenceIds: ['T1'] }];
  const rows = [{ id: 'T1', start: 90, end: 96, text: '陪你看雷神三' }, { id: 'D1', start: 50, end: 50, text: '下次看奇异博士' }];
  expect(recoverWatchNames(events, '杂谈并观看《雷神3》', rows)[0]).toMatchObject({ name: '雷神3', titleEvidenceIds: ['T1'] });
  expect(recoverWatchNames(events, '观看《奇异博士》', rows)[0].name).toBeNull();
  expect(recoverWatchNames(events, '观看《雷神3》和《奇异博士》', [{ ...rows[0], text: '雷神三和奇异博士' }])[0].name).toBeNull();
  expect(recoverWatchNames(events, '观看《雷神3》', [{ ...rows[0], start: 1300, end: 1305 }])[0].name).toBeNull();
  expect(watchTitleAppears('雷神3', '看雷神三十')).toBe(false);
  expect(watchTitleAppears('雷神3', '雷神30')).toBe(false);
  expect(watchTitleAppears('雷神3', '今天看雷神三啊')).toBe(true);
});

test('explicit user titles record feedback against one activity without claiming transcript or listening evidence', () => {
  const event = { id: 's1', start: 100, end: 300, name: null };
  const item = { activityId: 's1', name: '歌曲甲', method: 'explicit_user_title', confirmation: '按这个歌名投吧', note: '用户接受原音研究结论' };
  const evidence = bindTranscriptTitles([item], [event], [], {});
  expect(evidence.items[0]).toEqual({ ...item, authority: 'user', audioVisualReviewed: false, window: { start: 100, end: 300 } });
  expect(namedEvents([event], evidence)[0].name).toBe('歌曲甲');
  for (const invalid of [{ ...item, confirmation: '' }, { ...item, note: '' }, { ...item, activityId: 'other' }]) {
    expect(() => bindTranscriptTitles([invalid], [event], [], {})).toThrow('explicit feedback');
  }
});

test('viewing copy puts actual work names before the date and preserves unresolved names as drafts', () => {
  const events = [{ name: '雷神3' }, { name: '雷神3' }, { name: '奇异博士' }];
  expect(watchCoverSubject(events)).toBe('《雷神3》 / 《奇异博士》');
  expect(watchSubmissionTitle(events, '2026.10.4', 72)).toBe('《雷神3》 / 《奇异博士》｜2026.10.4');
  expect(watchSubmissionTitle([{ name: null }], '2026.10.4', 72)).toContain('待确认片名');
});

test('recovers a summary-known song from cited title and adjacent selection speech', () => {
  const event = { kind: 'song', start: 400, end: 800, name: null, evidenceIds: ['T2'] };
  const rows = [
    { id: 'T1', source: 'audio_transcript', start: 280, end: 290, text: '我要唱点正常的' },
    { id: 'T2', source: 'audio_transcript', start: 291, end: 296, text: '好，爱情讯息' },
    { id: 'T3', source: 'audio_transcript', start: 297, end: 300, text: '唱点没问题的吧' }];
  expect(recoverSongNames([event], ['爱情讯息'], rows)[0]).toMatchObject({
    name: '爱情讯息', titleEvidenceIds: ['T1', 'T2', 'T3'], evidenceIds: ['T2', 'T1', 'T3'] });
  expect(recoverSongNames([event], ['另一首'], rows)[0]).toBe(event);
  expect(recoverSongNames([event], ['爱情讯息'], rows.map(r => ({ ...r, source: 'danmaku' })))[0]).toBe(event);
  expect(recoverSongNames([{ ...event, evidenceIds: [] }], ['爱情讯息'], rows)[0]).toHaveProperty('name', null);
});
