export {};
const { selectEditorialComments } = require('./audience_copy');
const { getWindowDanmakuEvidence } = require('./own_selection');
const { buildRerankEvidence } = require('./rerank_evidence');
const { linkClipEvidence } = require('./subtitle_evidence');

describe('audience wording for clip copy', () => {
  test('a one-off observation survives a burst of identical laughter without changing heat counts', () => {
    const observation = Object.freeze({ time: 6.125, text: '骑手觉得自己可暖了' });
    const comments = [
      ...Array.from({ length: 20 }, (_, i) => ({ time: 1 + i / 10, text: '哈哈哈哈哈' })),
      { time: 4, text: '[收藏集表情包_哈哈]' }, observation,
      { time: 8, text: '骑手觉得自己可暖了！' }, { time: 11, text: '片外的另一件事' }
    ];
    const before = JSON.stringify(comments);
    const evidence = getWindowDanmakuEvidence(comments, { start: 0, end: 10 }, ['哈'], 2);
    expect(evidence.totalCount).toBe(23);
    expect(evidence.reactionCount).toBe(21);
    expect(evidence.topItems[0].count).toBe(20);
    expect(evidence.editorialItems).toEqual([observation]);
    expect(evidence.editorialItems[0]).toBe(observation);
    expect(JSON.stringify(comments)).toBe(before);
  });

  test('bounded sampling retains wording across the window instead of only its first burst', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ time: i, text: `不同的观众评论${i}` }));
    const selected = selectEditorialComments(rows);
    expect(selected).toHaveLength(8);
    expect(selected[0]).toBe(rows[0]);
    expect(selected.at(-1)).toBe(rows.at(-1));
    expect(new Set(selected.map(row => Math.floor(row.time / 10))).size).toBe(4);
    expect(selectEditorialComments(rows, 0)).toEqual([]);
    expect(selectEditorialComments(rows, 1)).toHaveLength(1);
    expect(selectEditorialComments([{ text: '哈哈哈哈哈' }, { text: '???' }, { text: '[哈哈]' }])).toEqual([]);
  });

  test('extra wording references resolve to exact source rows and only preceding in-window speech', () => {
    const parsed = { segments: [
      { start: 0, end: 5, text: 'Outside setup.' },
      { start: 10, end: 12, text: 'The courier wished me a happy birthday.' },
      { start: 16, end: 18, text: 'I felt guilty.' },
      { start: 25, end: 27, text: 'A later remark.' }
    ] };
    const comments = [{ time: 8, text: '之前窗口的具体评论' },
      { time: 13.125, text: '骑手觉得自己可暖了' }, { time: 17.5, text: '你怎么又玩这一套' },
      { time: 31, text: '以后再说另一件事' }];
    const candidate = { index: 1, start: 10, end: 30 };
    const packed = buildRerankEvidence([candidate], parsed, comments, { ai: { maxCandidateDanmakuLines: 1 } });
    expect(packed.records[0].h).toEqual([['D2', ['G2']], ['D3', ['G2', 'G3']]]);
    expect(packed.audienceRows).toEqual([{ id: 'D2', ...comments[1] }, { id: 'D3', ...comments[2] }]);
    expect(packed.danmakuIds).toEqual(new Set(['D2', 'D3']));
    const raw = { title: '弹幕：“骑手觉得自己可暖了”', sourceKind: 'recount',
      evidenceCueIds: ['G2'], evidenceDanmakuIds: ['D2'] };
    const linked = linkClipEvidence(raw, candidate, packed.subtitleEvidence, comments,
      { cueIds: packed.cueIds, danmakuIds: packed.danmakuIds });
    expect(linked.issues).toEqual([]);
    expect(linked.audience).toEqual([{ id: 'D2', ...comments[1] }]);
    const outside = linkClipEvidence({ ...raw, evidenceDanmakuIds: ['D4'] }, candidate,
      packed.subtitleEvidence, comments, { cueIds: packed.cueIds, danmakuIds: packed.danmakuIds });
    expect(outside.issues).toEqual(expect.arrayContaining(['unseen_danmaku:D4', 'danmaku_outside_clip:D4']));
  });
});
