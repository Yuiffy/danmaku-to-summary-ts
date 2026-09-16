const { buildRerankEvidence } = require('./rerank_evidence');
const { getWindowDanmakuEvidence } = require('./own_selection');
const { buildSubtitleEvidence, linkClipEvidence } = require('./subtitle_evidence');
const { reusableRecall } = require('./selection_result');

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
      const [, id, time, text] = line.match(/^(D\d+) (\S+) (.*)$/);
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

  test('prints exact timestamps for distinct messages within one second', () => {
    const danmaku = [{ time: 5.125, text: 'first' }, { time: 5.875, text: 'second' }];
    const packed = buildRerankEvidence([{ index: 1, start: 0, end: 10 }], { segments: [] }, danmaku, {});
    expect(packed.audienceRows).toEqual([{ id: 'D1', ...danmaku[0] }, { id: 'D2', ...danmaku[1] }]);
    expect(packed.danmakuLines).toContain('D1 5.125 "first"');
    expect(packed.danmakuLines).toContain('D2 5.875 "second"');
  });

  test('puts validated defaults or an explicit null on each candidate, preserving the reuse contract', () => {
    const parsed = { segments: [{ start: 0, end: 40, text: 'First.' }, { start: 60, end: 100, text: 'Second.' },
      { start: 120, end: 160, text: 'Third.' }] };
    const source = buildSubtitleEvidence(parsed.segments);
    const comments = [{ time: 80.12345, text: 'A cited reaction.' }, { time: 161, text: 'Outside the third clip.' }];
    const candidates = parsed.segments.map((segment, index) => {
      const raw = { index: index + 1, start: segment.start, end: segment.end,
        startCueId: `G${index + 1}`, endCueId: `G${index + 1}`, evidenceCueIds: [`G${index + 1}`],
        evidenceDanmakuIds: index === 1 ? ['D1'] : index === 2 ? ['D2'] : [], sourceKind: 'recount' };
      return { ...raw, ...(index ? { grounding: linkClipEvidence(raw, raw, source, comments) } : {}) };
    });
    const before = JSON.stringify(candidates);
    const config = { minClipSeconds: 1, maxClipSeconds: 60 };
    const packed = buildRerankEvidence(candidates, parsed, comments, config);
    const lines = packed.candidateLines.split('\n').filter(line => line.startsWith('#'));
    expect(lines).toHaveLength(3);
    lines.forEach((line, index) => {
      const values = JSON.parse(line.slice(line.indexOf('[')));
      const decoded = Object.fromEntries(packed.columns.map((key, column) => [key, values[column]]));
      expect(decoded.reuse).toEqual(reusableRecall(candidates[index], packed.subtitleEvidence, config, comments));
      expect(decoded.reuse).toEqual(packed.records[index].reuse);
    });
    expect(packed.records.map(row => Boolean(row.reuse))).toEqual([false, true, false]);
    expect(packed.recallHints).toEqual([{ index: 2, value: packed.records[1].reuse }]);
    expect(packed.records[1].reuse).toMatchObject({ startCueId: 'G2', endCueId: 'G2', evidenceDanmakuIds: ['D1'] });
    expect(packed.candidateLines).toContain('reuse=null');
    expect(packed.candidateLines).toContain('不代表内容真伪已确认');
    expect(packed.candidateLines).not.toContain('=== 可复用的召回定位 ===');
    expect(JSON.stringify(candidates)).toBe(before);
  });

  test.each(['hash', 'time', 'comment'])('does not advertise stale %s defaults as reusable', changed => {
    const parsed = { segments: [{ start: 0, end: 40, text: 'A story.' }] };
    const source = buildSubtitleEvidence(parsed.segments);
    const comments = [{ time: 20.25, text: 'A reaction.' }];
    const raw = { index: 1, start: 0, end: 40, startCueId: 'G1', endCueId: 'G1',
      evidenceCueIds: ['G1'], evidenceDanmakuIds: ['D1'], sourceKind: 'recount' };
    const candidate = { ...raw, grounding: linkClipEvidence(raw, raw, source, comments) };
    if (changed === 'hash') candidate.grounding.sourceSha256 = 'stale';
    if (changed === 'time') candidate.start = 1;
    if (changed === 'comment') comments[0].text = 'A different reaction.';
    const packed = buildRerankEvidence([candidate], parsed, comments, { minClipSeconds: 1, maxClipSeconds: 60 });
    expect(packed.records[0].reuse).toBeNull();
    expect(packed.recallHints).toEqual([]);
  });
});
