import { bindLocalReply, independentRows, validateLocalEvidence } from './activityAudio';

const settings = { chunkSeconds: 8 };
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

test('independent lyrics can bind despite corrupt source Chinese ASR, with real original time origins', () => {
  validateLocalEvidence(evidence, request);
  expect(JSON.parse(bindLocalReply(response(), batch, evidence).text).results[0].audibleEvidence).toEqual(['original sung lyric']);
  expect(independentRows(evidence)[0]).toMatchObject({ start: 100, end: 108, text: expect.stringContaining('original sung lyric') });
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

test('GPT cannot substitute invented lyrics, sibling audio, background playback or incomplete context', () => {
  for (const mutate of [(r: any) => { r.evidenceRefs[0].quote = 'invented sung words'; },
    (r: any) => { r.evidenceRefs[0].audioIndex = 2; }, (r: any) => { r.performer = 'playback'; },
    (r: any) => { r.endContextClosed = false; }, (r: any) => { r.events[0].start.seconds = 8; }]) {
    const changed = structuredClone(result); mutate(changed);
    expect(() => bindLocalReply(response(changed), batch, evidence)).toThrow();
  }
});
