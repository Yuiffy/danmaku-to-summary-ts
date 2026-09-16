export {};
const own = require('../own_stream_clipper');
const selection = require('./own_selection');
const generator = require('../ai_text_generator');

describe('old optimization plan regressions', () => {
  const config = (overrides = {}) => own.getOwnStreamClipsConfig({ ownStreamClips: overrides });

  test('all subtitles, including a late event, enter actual budgeted recall requests', async () => {
    const segments = Array.from({ length: 240 }, (_, i) => ({ start: i * 11, end: i * 11 + 10,
      text: `ROW_${i} ${'context '.repeat(30)}${i === 239 ? 'LATE_EVENT' : ''}` }));
    const cfg = config();
    const chunks = selection.buildChunkSources({ segments }, [], 2700, cfg);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.subtitleChars <= 14000 && chunk.omittedSubtitleChars === 0)).toBe(true);
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: '{"clips":[]}' });
    try {
      await own.planClipsWithAIChunks({ segments }, [], {}, 2700, cfg, { ai: { text: { provider: 'daiYu' } } });
      const prompts = generate.mock.calls.map(call => String(call[0])).join('\n');
      segments.forEach(row => expect(prompts.includes(row.text.trim())).toBe(true));
      expect(prompts).toContain('LATE_EVENT');
    } finally { generate.mockRestore(); }
  });

  test('an oversized line keeps its original ID and time without invented word timestamps', () => {
    const text = 'abcdefgh'.repeat(400);
    const chunks = selection.buildChunkSources({ segments: [{ start: 20.25, end: 70.5, text }] }, [], 600,
      config({ maxSubtitleCharsPerChunk: 200 }));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.subtitleChars <= 200)).toBe(true);
    const cues = chunks.flatMap(chunk => chunk.subtitleCues);
    expect(cues.every(cue => cue.id === 'G1' && cue.start === 20.25 && cue.end === 70.5)).toBe(true);
    expect(cues.map(cue => cue.text.replace(/^\[text-part[^\]]+\] /, '')).join('')).toBe(text);
  });

  test('overlap is included in the budget and duplicate boundary events are collapsed', () => {
    const segments = Array.from({ length: 100 }, (_, i) => ({ start: i * 10, end: i * 10 + 9, text: 'x'.repeat(130) }));
    const chunks = selection.buildChunkSources({ segments }, [], 1000, config({ maxSubtitleCharsPerChunk: 900 }));
    expect(chunks.every(chunk => chunk.subtitleChars <= 900)).toBe(true);
    expect(chunks.some((chunk, i) => i && chunk.subtitleCues.some(cue => chunks[i - 1].subtitleCues.some(previous => previous.id === cue.id)))).toBe(true);
    expect(selection.dedupePlannedClips([{ start: 90, end: 150, score: 95 },
      { start: 91, end: 151, score: 90 }], config())).toHaveLength(1);
  });

  test('a middle correction reaches the actual final-copy request in full', async () => {
    const segments = Array.from({ length: 19 }, (_, i) => ({ start: i * 10, end: i * 10 + 9,
      text: i === 9 ? 'CORRECTION: the earlier statement was false.' : 'original context '.repeat(20) }));
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: '{"clips":[]}' });
    try {
      await own.refineCandidatesWithAI([{ index: 1, start: 0, end: 190, score: 90 }], { segments }, [], {}, config(),
        { ai: { text: { provider: 'daiYu' } } });
      expect(generate.mock.calls[0][0]).toContain(segments[9].text);
      segments.forEach(row => expect(String(generate.mock.calls[0][0]).includes(row.text.trim())).toBe(true));
    } finally { generate.mockRestore(); }
  });

  test('high-scoring model candidates displace low local candidates at the shared cap', () => {
    const local = Array.from({ length: 80 }, (_, i) => ({ start: i * 300, end: i * 300 + 60, score: 80 - i }));
    const model = Array.from({ length: 40 }, (_, i) => ({ start: 30000 + i * 300, end: 30060 + i * 300, modelScore: 99 }));
    const pool = selection.buildRecallCandidatePool(local, model, config());
    expect(pool).toHaveLength(100);
    expect(pool.filter(item => item.recallSources.includes('model_chunked'))).toHaveLength(40);
    expect(pool.some(item => item.start === 79 * 300)).toBe(false);
  });

  test('an intervening distinct event cannot hide a cross-chunk duplicate', () => {
    const clips = [{ start: 0, end: 200, score: 90 }, { start: 110, end: 280, score: 80 },
      { start: 120, end: 210, score: 95 }];
    const result = selection.dedupePlannedClips(clips, config());
    expect(result).toEqual([clips[2]]);
    expect(result).not.toContainEqual(clips[0]);
  });

  test('merged windows count original records, not overlapping windows or unique texts', () => {
    const comments = [{ time: 50, text: 'reaction' }, { time: 50, text: 'reaction' }];
    const cfg = config({ reactionKeywords: ['reaction'], subtitleKeywords: ['trigger'], mergeGapSeconds: 100 });
    const windows = selection.buildCandidateWindows({ segments: [{ start: 45, end: 46, text: 'trigger' }] }, comments, cfg, 300);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ danmakuCount: 2, reactionCount: 2, sourceRecordIds: ['D1', 'D2', 'S1'],
      scoreComponents: { audience: 58, speech: 22, emotion: 0 }, score: 80 });
  });
});
