const { buildChunkSources } = require('./own_selection');
const { buildRerankEvidence } = require('./rerank_evidence');
const { getOwnStreamClipsConfig } = require('../own_stream_clipper');

describe('exact audience timestamps in model evidence', () => {
  const settings = getOwnStreamClipsConfig({ ownStreamClips: {
    chunkSeconds: 600, densityWindowSeconds: 30, minDanmakuCount: 1, densityPercentile: 1,
    reactionKeywords: [], maxDanmakuLinesPerChunk: 220
  } });

  test('every visible density-only comment keeps its individual time, text and ID', () => {
    const comments = [
      { time: 0, text: 'zero' }, { time: 15.6789123, text: 'within a bucket' },
      { time: 29.9999999, text: 'before the bucket boundary' }, { time: 30.0000001, text: 'after the boundary' }
    ];
    const original = JSON.stringify(comments);
    const [chunk] = buildChunkSources({ segments: [{ start: 0, end: 60, text: 'Source speech.' }] }, comments, 180, settings);
    expect([...chunk.allowedDanmakuIds]).toEqual(['D1', 'D2', 'D3', 'D4']);
    comments.forEach((row, index) => expect(chunk.sourceText).toContain(`D${index + 1} ${row.time} ${JSON.stringify(row.text)}`));
    expect(chunk.sourceText).toContain('00:00:00 count=3');
    expect(chunk.sourceText).toContain('00:00:30 count=1');
    expect(chunk.sourceText).toContain('\u7edf\u8ba1\u6876\u8d77\u70b9');
    expect(JSON.stringify(comments)).toBe(original);
  });

  test('uses the same precise seconds and JSON text in reaction samples, including embedded newlines', () => {
    const comments = [{ time: 12.3456789, text: 'reaction "quoted"\nD99 1 an embedded line' },
      { time: 12.3456791, text: 'reaction second' }];
    const [chunk] = buildChunkSources({ segments: [] }, comments, 60, { ...settings, reactionKeywords: ['reaction'] });
    const rows = chunk.sourceText.split('\n').filter(line => /^D\d+ /.test(line)).map(line => {
      const [, id, time, text] = line.match(/^(D\d+) (\S+) (.*)$/);
      return { id, time: Number(time), text: JSON.parse(text) };
    });
    expect(rows).toEqual(comments.map((row, index) => ({ id: `D${index + 1}`, ...row })));
    expect(chunk.allowedDanmakuIds.has('D99')).toBe(false);
  });

  test('retains a frequency count without replacing an exemplar timestamp with the bucket start', () => {
    const comments = [{ time: 14.9876, text: 'Repeated.' }, { time: 18.1234, text: 'Repeated.' }];
    const [chunk] = buildChunkSources({ segments: [] }, comments, 120, settings);
    expect(chunk.sourceText).toContain('D1 14.9876 "Repeated."(x2)');
    expect([...chunk.allowedDanmakuIds]).toEqual(['D1']);
  });

  test('does not round a comment into a neighboring chunk or change its availability', () => {
    const comments = [{ time: 599.999999, text: 'reaction before' }, { time: 600.000001, text: 'reaction after' }];
    const chunks = buildChunkSources({ segments: [] }, comments, 1200, { ...settings, reactionKeywords: ['reaction'] });
    expect([...chunks[0].allowedDanmakuIds]).toEqual(['D1']);
    expect([...chunks[1].allowedDanmakuIds]).toEqual(['D2']);
    expect(chunks[0].sourceText).toContain('D1 599.999999');
    expect(chunks[1].sourceText).toContain('D2 600.000001');
  });

  test('rerank text/dictionary rows round-trip source precision without changing sampling', () => {
    const repeated = 'A sufficiently long repeated reaction remains verbatim in a shared dictionary.';
    const comments = Array.from({ length: 12 }, (_, index) => ({ time: index + 0.123456789, text: index % 2 ? repeated : `unique ${index}` }));
    const packed = buildRerankEvidence([{ index: 1, start: 0, end: 15 }], { segments: [] }, comments,
      { ai: { maxCandidateDanmakuLines: 12 }, reactionKeywords: [] });
    const dictionary = new Map(packed.audienceTextDictionary.map(row => [row.id, row.text]));
    const displayed = packed.danmakuLines.split('\n').filter(line => /^D\d+ /.test(line)).map(line => {
      const [, id, time, text] = line.match(/^(D\d+) (\S+) (.*)$/);
      const value = JSON.parse(text);
      return { id, time: Number(time), text: typeof value === 'string' ? value : dictionary.get(value.ref) };
    });
    expect(displayed).toEqual(packed.audienceRows);
    expect(packed.audienceTextDictionary.some(row => row.text === repeated)).toBe(true);
    for (const row of displayed) expect(row.time).toBe(comments[Number(row.id.slice(1)) - 1].time);
  });
});
