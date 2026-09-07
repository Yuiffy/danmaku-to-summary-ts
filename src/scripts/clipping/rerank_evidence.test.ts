const { buildRerankEvidence } = require('./rerank_evidence');
const { getWindowDanmakuEvidence } = require('./own_selection');
const { buildSubtitleEvidence, linkClipEvidence } = require('./subtitle_evidence');

describe('rerank evidence encoding', () => {
  test('keeps draft-cited audience evidence even when rerank sampling would omit it', () => {
    const parsed = { segments: [{ start: 0, end: 60, text: 'The full story.' }] };
    const source = buildSubtitleEvidence(parsed.segments);
    const danmaku = Array.from({ length: 30 }, (_, i) => ({ time: i + 1, text: `comment-${i}` }));
    const draft = { index: 1, start: 0, end: 60, startCueId: 'G1', endCueId: 'G1',
      title: 'A source story', description: 'A recollection.', coverText: 'Full story\nClear ending',
      evidenceCueIds: ['G1'], evidenceDanmakuIds: ['D20'], sourceKind: 'recount' };
    const candidate = { ...draft, grounding: linkClipEvidence(draft, draft, source, danmaku) };
    const packed = buildRerankEvidence([candidate], parsed, danmaku,
      { minClipSeconds: 1, maxClipSeconds: 90, ai: { maxCandidateDanmakuLines: 2 } });
    expect(packed.recallHints).toHaveLength(1);
    expect(packed.danmakuIds.has('D20')).toBe(true);
    expect(packed.danmakuLines).toContain('comment-19');
  });

  test('preserves source fields, reasons, frequencies and text while factoring repeated values', () => {
    const reason = 'danmaku_density+subtitle_keyword';
    const repeated = 'A long audience comment that must remain verbatim, including "quotes" and a newline.\nMore text.';
    const parsed = { segments: Array.from({ length: 12 }, (_, i) => ({ start: i * 5, end: i * 5 + 4, text: `speech-${i}` })) };
    const danmaku = Array.from({ length: 20 }, (_, i) => ({ time: 10 + i, text: i % 2 ? repeated : `unique-${i}` }));
    const candidates = [1, 2].map(index => ({ index, start: 8, end: 45, recallScore: 91, localScore: 12, modelScore: 80,
      recallReasons: [reason, `unique reason ${index}`], recallSources: ['local_signals', 'model_chunked', '0', 'constructor'], emotions: ['HAPPY'], events: ['Laughter'] }));
    const config = { boundaryStartBacktrackSeconds: 0, boundaryEndExtendSeconds: 0, reactionKeywords: ['comment'],
      ai: { maxCandidateDanmakuLines: 14 } };
    const packed = buildRerankEvidence(candidates, parsed, danmaku, config);
    const reasons = new Map(packed.reasons.map(row => [row.id, row.text]));
    const rows = new Map(packed.audienceRows.map(row => [row.id, row]));
    const strings = new Map(packed.audienceTextDictionary.map(row => [row.id, row.text]));
    const encodedRows = packed.danmakuLines.split('\n').filter(line => /^D\d+ /.test(line)).map(line => {
      const [, id, time, text] = line.match(/^(D\d+) (\d+) (.*)$/);
      return [id, Number(time), JSON.parse(text)];
    });
    expect(encodedRows.map(([id, time, text]) => ({ id, time, text: typeof text === 'string' ? text : strings.get(text.ref) })))
      .toEqual(packed.audienceRows);
    expect(packed.audienceTextDictionary).toContainEqual(expect.objectContaining({ text: repeated }));
    packed.records.forEach((record, index) => {
      const original = candidates[index];
      const audience = getWindowDanmakuEvidence(danmaku, original, config.reactionKeywords, 14);
      expect(record.r.map(id => reasons.get(id))).toEqual([reason]);
      expect(record.a).toEqual([audience.totalCount, audience.reactionCount, audience.repeatedMessageCount,
        audience.repeatedTextCount, audience.activeSpanSeconds]);
      expect(record.top.map(([id, count]) => [rows.get(id).text.trim(), count]))
        .toEqual(audience.topItems.map(row => [row.item.text.trim(), row.count]));
      expect(record.s).toEqual(original.recallSources);
      expect(record.e).toEqual(original.emotions);
      expect(record.v).toEqual(original.events);
      expect([record.q, record.l, record.m]).toEqual([91, 12, 80]);
    });
    expect(packed.reasons.filter(row => row.text === reason)).toHaveLength(1);
    expect(packed.omittedModelNotes).toHaveLength(2);
    expect(packed.candidateLines).not.toContain('unique reason');
    packed.candidateLines.split('\n').filter(line => line.startsWith('#')).forEach((line, index) => {
      const array = JSON.parse(line.slice(line.indexOf('[')));
      const decoded = Object.fromEntries(packed.columns.map((column, i) => [column, array[i]]));
      decoded.s = decoded.s.map(value => value === 0 ? 'local_signals' : value === 1 ? 'model_chunked' : value);
      decoded.top = decoded.top.map(value => typeof value === 'string' ? [value, 1] : value);
      const { index: id, start, end, ...original } = packed.records[index];
      expect(decoded).toEqual(original);
    });
    expect(packed.subtitleLines).toContain('speech-5');
    expect(packed.cueIds.size).toBeGreaterThan(0);
  });

  test('does not discard top-frequency comments when the sample limit is small', () => {
    const danmaku = Array.from({ length: 12 }, (_, i) => ({ time: i + 1, text: `text-${Math.floor(i / 2)}` }));
    const packed = buildRerankEvidence([{ index: 1, start: 0, end: 20 }], { segments: [] }, danmaku,
      { ai: { maxCandidateDanmakuLines: 2 } });
    const rowIds = new Set(packed.audienceRows.map(row => row.id));
    expect(packed.records[0].d).toHaveLength(2);
    expect(packed.records[0].top).toHaveLength(6);
    packed.records[0].top.forEach(([id, count]) => { expect(rowIds.has(id)).toBe(true); expect(count).toBe(2); });
  });

  test('retains distinct message IDs and exact timestamps when display seconds are shared', () => {
    const danmaku = [{ time: 5.125, text: 'first' }, { time: 5.875, text: 'second' }];
    const packed = buildRerankEvidence([{ index: 1, start: 0, end: 10 }], { segments: [] }, danmaku, {});
    expect(packed.audienceRows).toEqual([{ id: 'D1', ...danmaku[0] }, { id: 'D2', ...danmaku[1] }]);
    expect(packed.danmakuLines).toContain('D1 5 "first"');
    expect(packed.danmakuLines).toContain('D2 5 "second"');
  });
});
