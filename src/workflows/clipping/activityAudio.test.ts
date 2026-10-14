import { bindLocalReply, independentRows, validateLocalEvidence, localBoundaryPrompt, encloseSongContext, prepareNativeListening } from './activityAudio';

const settings = { chunkSeconds: 8 };

test('supplementary listening binds actual audio and frames and detects changes without approving publication', async () => {
  const packet = { audio: [{ path: 'audio', start: 100, end: 116 }], frames: [{ path: 'frame', time: 103, activityId: 'song-1' }] };
  const request = jest.fn(async () => ({ text: '{"timeBasis":"audio_local_seconds","observations":[{"id":"song-1","ownership":"uncertain","chronology":[{"audioIndex":1,"start":0,"end":16,"kind":"uncertain"}]}]}' }));
  const digest = jest.fn(() => 'digest');
  const result = await prepareNativeListening(batch, packet, { mediaPath: 'source' }, { request, digest });
  expect(result.inputs).toHaveLength(2); expect(result).not.toHaveProperty('approved');
  expect(request.mock.calls[0]).toHaveLength(2);
  let reads = 0;
  await expect(prepareNativeListening(batch, packet, {}, { request, digest: () => ++reads > 2 ? 'changed' : 'digest' })).rejects.toThrow('source changed');
  request.mockResolvedValueOnce({ text: '{"timeBasis":"audio_local_seconds","observations":[{"id":"song-1","ownership":"host","chronology":[{"audioIndex":1,"start":100,"end":116,"kind":"host_singing"}]}]}' });
  await expect(prepareNativeListening(batch, packet, {}, { request, digest })).rejects.toThrow('outside');
  request.mockResolvedValueOnce({ text: '{"observations":[{"id":"other"}]}' });
  await expect(prepareNativeListening(batch, packet, {}, { request, digest })).rejects.toThrow('identities');
});
const request = { source: { mediaPath: 'original.flv' }, settings, audio: [{ start: 100, end: 116, sha256: 'source-audio' }] };
const evidence = { version: 1, method: 'independent_local_asr', source: request.source, settings,
  audio: [{ index: 1, ...request.audio[0], chunks: [{ index: 1, start: 0, end: 8, raw: '<|en|>original sung lyric',
    text: 'original sung lyric', tags: ['en', 'BGM'] }, { index: 2, start: 8, end: 16, raw: '<|zh|>唱得怎么样呀', text: '唱得怎么样呀', tags: ['zh', 'Speech'] }],
  transcript: [{ chunkIndex: 1, start: 2, end: 6, text: 'original sung lyric' }] }] };
const batch = { events: [{ event: { id: 'song-1', kind: 'song', start: 102, end: 112 }, audioIndices: [1] }] };
const result = { id: 'song-1', decision: 'keep', performer: 'host', startContextClosed: true, endContextClosed: true,
  timeBasis: 'audio_local_seconds', evidenceRefs: [{ audioIndex: 1, chunkIndex: 1, quote: 'original sung lyric' }],
  events: [{ start: { audioIndex: 1, seconds: 0 }, end: { audioIndex: 1, seconds: 16 } }] };
const response = (value = result) => ({ text: JSON.stringify({ results: [value] }) });

test('song evidence reaches its cited selection and delayed wrap-up without decoding the full performance', () => {
  const event = { kind: 'song', start: 400, end: 800, evidenceIds: ['T1'] };
  const intervals = [{ start: 355, end: 415 }, { start: 785, end: 845 }];
  const rows = [{ id: 'T1', source: 'audio_transcript', start: 290, end: 295, text: '好，爱情讯息' },
    { id: 'T2', source: 'audio_transcript', start: 875, end: 880, text: '唱完了，无事发生' },
    { id: 'T3', source: 'audio_transcript', start: 100, end: 105, text: '另一首歌' },
    { id: 'D1', source: 'danmaku', start: 250, end: 250, text: '我唱完了' }];
  expect(encloseSongContext(event, intervals, rows, 1000)).toEqual([{ start: 275, end: 415 }, { start: 785, end: 888 }]);
  expect(intervals).toEqual([{ start: 355, end: 415 }, { start: 785, end: 845 }]);
  expect(encloseSongContext({ ...event, kind: 'watch' }, intervals, rows, 1000)).toBe(intervals);
});

test('extra context is bounded and ignores unrelated uncited talk or audience claims', () => {
  const event = { kind: 'song', start: 400, end: 800, evidenceIds: ['T1'] };
  const intervals = [{ start: 355, end: 415 }, { start: 785, end: 845 }];
  expect(encloseSongContext(event, intervals, [
    { id: 'T1', source: 'audio_transcript', start: 221, end: 225, text: '歌名' },
    { id: 'T2', source: 'audio_transcript', start: 890, end: 1200, text: '唱完了' }
  ], 1000)).toEqual([{ start: 220, end: 415 }, { start: 785, end: 935 }]);
  expect(encloseSongContext(event, intervals, [
    { id: 'D1', source: 'danmaku', start: 870, end: 880, text: '唱完了' },
    { id: 'T9', source: 'audio_transcript', start: 240, end: 250, text: '我要唱' }
  ], 1000)).toEqual(intervals);
});

test('boundary reasoning receives only source cues overlapping short audio, not an entire movie transcript', () => {
  const prompt = localBoundaryPrompt(batch, { audio: [{ start: 100, end: 116, energy: { rmsDb: [] } }], frames: [] }, evidence,
    { streamerName: '岁己' }, [{ source: 'audio_transcript', start: 101, end: 105, text: 'boundary words' },
      { source: 'audio_transcript', start: 1000, end: 1010, text: 'movie middle must not be sent' }]);
  expect(prompt).toContain('boundary words');
  expect(prompt).not.toContain('movie middle must not be sent');
});

test('independent lyrics can bind despite corrupt source Chinese ASR, with real original time origins', () => {
  validateLocalEvidence(evidence, request);
  expect(JSON.parse(bindLocalReply(response(), batch, evidence).text).results[0].audibleEvidence).toEqual(['original sung lyric']);
  expect(independentRows(evidence)[0]).toMatchObject({ start: 100, end: 108, text: expect.stringContaining('original sung lyric') });
});

test('literal short Chinese boundary phrases supplement substantial context but cannot establish an activity alone', () => {
  const local = structuredClone(evidence); local.audio[0].chunks[1].text = '看完了';
  const raw = structuredClone(result);
  raw.evidenceRefs.push({ audioIndex: 1, chunkIndex: 2, quote: '看完了' });
  expect(() => bindLocalReply(response(raw), batch, local)).not.toThrow();
  raw.evidenceRefs.shift();
  expect(() => bindLocalReply(response(raw), batch, local)).toThrow('context');
  raw.evidenceRefs.push({ audioIndex: 1, chunkIndex: 1, quote: 'invented substantial text' });
  expect(() => bindLocalReply(response(raw), batch, local)).toThrow('quote');
});

test('one invalid candidate cannot discard valid independent results from the same batch', () => {
  const sibling = { ...batch.events[0], event: { ...batch.events[0].event, id: 'song-2' } };
  const bad = { ...structuredClone(result), id: 'song-2', evidenceRefs: [{ audioIndex: 1, chunkIndex: 1, quote: 'invented quote' }] };
  const input = { text: JSON.stringify({ results: [result, bad] }) };
  const parsed = JSON.parse(bindLocalReply(input, { events: [...batch.events, sibling] }, evidence, [], true).text);
  expect(parsed.results[0].decision).toBe('keep');
  expect(parsed.results[1]).toMatchObject({ decision: 'uncertain', events: [], reason: expect.stringContaining('quote') });
  expect(JSON.parse(input.text).results[1].decision).toBe('keep');
});

test('a separate preview can be removed only with complete evidence and the whole formal announcement retained', () => {
  const local = structuredClone(evidence); local.audio[0].chunks[1].text = '我开始唱了呀请听';
  const raw: any = structuredClone(result);
  raw.events[0].start.seconds = 8;
  raw.preludeCorrection = { version: 1, method: 'separate_preview_before_performance', preludeKind: 'listening_or_rehearsal',
    previewContextClosed: true, formalPerformanceComplete: true, reason: 'The initial preview ended before the announced new performance.',
    announcement: { audioIndex: 1, chunkIndex: 2, quote: '我开始唱了呀请听' } };
  const frames = [{ activityId: 'song-1', time: 103 }];
  expect(() => bindLocalReply(response(raw), batch, local, frames)).not.toThrow();
  for (const mutate of [(r: any) => { r.preludeCorrection.previewContextClosed = false; },
    (r: any) => { r.preludeCorrection.announcement.quote = '唱得怎么样呀'; },
    (r: any) => { r.events[0].start.seconds = 9; }, (r: any) => { r.events[0].end.seconds = 10; }]) {
    const changed = structuredClone(raw); mutate(changed);
    expect(() => bindLocalReply(response(changed), batch, local, frames)).toThrow();
  }
  expect(() => bindLocalReply(response(raw), batch, local, [])).toThrow('image coverage');
});

test.each(['gap', 'origin', 'audio', 'duration'])('local decoding rejects changed %s evidence', change => {
  const changed = structuredClone(evidence);
  if (change === 'gap') changed.audio[0].chunks[1].start = 9;
  if (change === 'origin') changed.audio[0].start = 101;
  if (change === 'audio') changed.audio[0].sha256 = 'different-audio';
  if (change === 'duration') changed.audio[0].transcript[0].end = 10;
  expect(() => validateLocalEvidence(changed, request)).toThrow();
});

test('a playback restart requires independent selection between matching openings and full retained context', () => {
  const local = structuredClone(evidence);
  local.audio[0].chunks = ['春天的晚风吹过山坡', '这首歌我们来唱吧', '春天的晚风吹过山坡', '唱完了谢谢大家'].map((text, i) =>
    ({ index: i + 1, start: i * 4, end: (i + 1) * 4, text, raw: text, tags: [] }));
  local.audio[0].transcript = [];
  const candidates = { events: [{ ...batch.events[0], event: { ...batch.events[0].event, start: 100 } }] };
  const raw: any = structuredClone(result);
  raw.evidenceRefs = [{ audioIndex: 1, chunkIndex: 2, quote: '这首歌我们来唱吧' }];
  raw.events[0].start.seconds = 4;
  raw.preludeCorrection = { version: 2, method: 'playback_then_restarted_performance', preludeKind: 'playback',
    previewContextClosed: true, formalPerformanceComplete: true, priorPlaybackConfirmed: true, openingRestartConfirmed: true,
    reason: 'Independent playback, intervening selection and a complete restart with original image coverage.',
    announcement: raw.evidenceRefs[0], openingBefore: { audioIndex: 1, chunkIndex: 1, quote: '春天的晚风吹过山坡' },
    openingAfter: { audioIndex: 1, chunkIndex: 3, quote: '春天的晚风吹过山坡' } };
  const frames = [{ activityId: 'song-1', time: 100 }];
  expect(() => bindLocalReply(response(raw), candidates, local, frames)).not.toThrow();
  const preview = structuredClone(raw);
  preview.preludeCorrection = { ...preview.preludeCorrection, version: 3, method: 'preview_then_complete_restart',
    preludeKind: 'listening_or_rehearsal', noUniqueVerseLost: true };
  expect(() => bindLocalReply(response(preview), candidates, local, frames)).toThrow('unique verse');
  const authorized = { events: candidates.events.map(row => ({ ...row, allowPreviewRestart: true })) };
  expect(() => bindLocalReply(response(preview), authorized, local, frames)).not.toThrow();
  preview.preludeCorrection.noUniqueVerseLost = false;
  expect(() => bindLocalReply(response(preview), authorized, local, frames)).toThrow('unique verse');
  for (const mutate of [(r: any) => { r.preludeCorrection.priorPlaybackConfirmed = false; },
    (r: any) => { r.preludeCorrection.openingAfter.chunkIndex = 1; },
    (r: any) => { r.preludeCorrection.openingBefore.quote = '模型虚构的开头歌词'; },
    (r: any) => { r.preludeCorrection.preludeKind = 'listening_or_rehearsal'; },
    (r: any) => { r.events[0].start.seconds = 5; }]) {
    const bad = structuredClone(raw); mutate(bad);
    expect(() => bindLocalReply(response(bad), candidates, local, frames)).toThrow();
  }
});

test('GPT cannot substitute invented lyrics, sibling audio, background playback or incomplete context', () => {
  for (const mutate of [(r: any) => { r.evidenceRefs[0].quote = 'invented sung words'; },
    (r: any) => { r.evidenceRefs[0].audioIndex = 2; }, (r: any) => { r.performer = 'playback'; },
    (r: any) => { r.endContextClosed = false; }, (r: any) => { r.events[0].start.seconds = 8; }]) {
    const changed = structuredClone(result); mutate(changed);
    expect(() => bindLocalReply(response(changed), batch, evidence)).toThrow();
  }
});
