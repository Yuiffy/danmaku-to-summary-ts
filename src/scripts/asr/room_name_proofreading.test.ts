export {};
const fs = require('fs');
const path = require('path');
const { resolveProofreadingOptions, proofreadSubtitleTexts } = require('./subtitle_proofreading');

const configs = ['default', 'production'].map(name => JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../config', `${name}.json`), 'utf8')));
const rows = (texts: string[], step = 4) => texts.map((text, index) => ({ start: index * step, end: index * step + 3, text }));
const check = (roomId: string, texts: string[], step = 4, config = configs[1]) =>
  proofreadSubtitleTexts(rows(texts, step), texts, resolveProofreadingOptions(config, { roomId }));

describe('room-scoped Shiori and Mizuki subtitle names', () => {
  test.each(configs)('enables only the configured room profiles', config => {
    for (const roomId of ['25788785', '26966466', '30655190']) {
      expect(resolveProofreadingOptions(config, { roomId }).enabled).toBe(true);
    }
    expect(resolveProofreadingOptions(config, { roomId: '123' }).enabled).toBe(false);
  });

  test.each(['25788785', '26966466', '30655190'])('corrects Mizuki nicknames with a nearby canonical name in %s', roomId => {
    const result = check(roomId, ['弥月昨天跟我们一起跳舞', '小明说行李箱忘在高铁上了', '然后小迷说很值']);
    expect(result.texts).toEqual(['弥月昨天跟我们一起跳舞', '小弥说行李箱忘在高铁上了', '然后小弥说很值']);
    expect(result.edits).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '小明', to: '小弥', method: 'curated_context', before: '小明说行李箱忘在高铁上了' }),
      expect.objectContaining({ from: '小迷', to: '小弥', method: 'curated_context' })
    ]));
  });

  test.each(['25788785', '26966466', '30655190'])('normalizes evidenced Shiori variants in %s', roomId => {
    expect(check(roomId, ['栞栞昨天跟我们一起直播', '小康接了个电话', '康康说跳得很好', '小刊下播了']).texts)
      .toEqual(['栞栞昨天跟我们一起直播', '小栞接了个电话', '栞栞说跳得很好', '小栞下播了']);
  });

  test.each(['25788785', '26966466', '30655190'])('preserves 康康 viewing slang and other people in %s', roomId => {
    for (const phrase of ['让我康康', '给我康康', '我康康', '你康康', '你们康康', '过来康康', '想康康',
      '康康这个', '康康那个', '康康视频', '康康照片', '康康图片', '康康效果',
      '不是栞栞，是康康', '不是康康', '不叫康康', '并非康康', '另一个康康',
      '康康同学', '同学康康', '名叫康康', '名字叫康康', '叫做康康', '康康是另一个人']) {
      const input = ['栞栞今天直播', phrase];
      const result = check(roomId, input);
      expect(result.texts).toEqual(input);
      expect(result.checks).toEqual([]);
    }
    const split = ['栞栞今天直播', '让我', '康康'];
    expect(check(roomId, split)).toMatchObject({ texts: split, edits: [], checks: [] });
    const unsupported = check(roomId, ['康康回来了']);
    expect(unsupported.texts).toEqual(['康康回来了']);
    expect(unsupported.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ original: '康康', suggestion: '栞栞' })
    ]));
  });

  test.each(['25788785', '26966466', '30655190'])('preserves 小迷 compounds without replacement suggestions in %s', roomId => {
    for (const phrase of ['小迷糊', '小迷妹', '小迷弟', '小迷宫', '小迷你', '有点小迷茫',
      '有点小迷惑', '有点小迷恋', '小迷同学', '同学小迷', '名叫小迷', '名字叫小迷',
      '叫做小迷', '小迷是另一个人']) {
      for (const input of [[phrase], ['弥月今天直播', phrase]]) {
        expect(check(roomId, input)).toMatchObject({ texts: input, edits: [], checks: [] });
      }
    }
    const split = ['弥月今天直播', '我是小迷', '妹'];
    expect(check(roomId, split)).toMatchObject({ texts: split, edits: [], checks: [] });
  });

  test.each(['25788785', '26966466', '30655190'])('preserves other people and ordinary words even with Mizuki context in %s', roomId => {
    for (const text of ['小明同学来了', '同学小明来了', '小明是我同学', '这个人名叫小明', '另一位名字叫小明',
      '另一个小明来了', '小明是另一个人', '小迷糊迷路了', '小迷妹和小迷弟', '这个小迷宫很好玩',
      '不是小弥，是小明', '不是弥月，是另一个小迷', '不是小明，是弥月', '并非小迷', '不叫小明', '小迷你玩具']) {
      const input = ['弥月今天也在', text];
      expect(check(roomId, input).texts).toEqual(input);
    }
  });

  test.each(['25788785', '26966466', '30655190'])('preserves ordinary Shiori homophones and contradictions in %s', roomId => {
    for (const text of ['不能小看对手', '不要小看她', '别小看我', '小看了栞栞的实力', '小看你了',
      '小看任何人都不好', '小康社会和小康生活', '全面小康', '奔小康', '小康家庭', '小康之家',
      '拿来签签名', '签签合同', '签签字', '小刊物', '小刊本', '不是小栞，是另一个小康',
      '别太小看这件事', '不要小看别人', '不能小看人', '会小看能力', '她被小看',
      '不是小康，是栞栞', '不叫小刊', '并非签签', '小康同学来了', '同学小康']) {
      const input = ['栞栞今天开播', text];
      expect(check(roomId, input).texts).toEqual(input);
    }
  });

  test('does not use a host name or generic streaming context as identity support', () => {
    const input = ['栞栞今天直播', '我跟小明和小迷说了'];
    expect(check('26966466', input).texts).toEqual(input);
    expect(check('26966466', input).checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ original: '小明', suggestion: '小弥', type: 'ambiguous_term' })
    ]));
    const other = ['弥月今天直播', '小康和小看来了'];
    expect(check('30655190', other).texts).toEqual(['弥月今天直播', '小栞和小看来了']);
  });

  test('does not bootstrap one person from another correction or carry names over a long gap', () => {
    const input = ['小康和小明来了'];
    expect(check('25788785', input).texts).toEqual(['小栞和小明来了']);
    expect(check('25788785', ['弥月和栞栞昨天来了', '小明小迷小刊小看小康签签康康'], 60).texts)
      .toEqual(['弥月和栞栞昨天来了', '小明小迷小刊小看小栞签签康康']);
    expect(check('123', ['弥月和栞栞', '小明小迷小刊小看小康签签康康']).texts)
      .toEqual(['弥月和栞栞', '小明小迷小刊小看小康签签康康']);
  });

  test.each(['25788785', '26966466', '30655190'])('never replaces or suggests replacing 签签 or 小看 in %s', roomId => {
    for (const phrase of ['签签回来了', '小看说跳得很好', '不要小看', '小看了']) {
      for (const input of [['栞栞今天直播', phrase], [phrase]]) {
        expect(check(roomId, input)).toMatchObject({ texts: input, edits: [], checks: [] });
      }
    }
  });

  test('requires local name evidence even in each person’s own room', () => {
    for (const [roomId, input] of [
      ['26966466', ['今天直播', '小刊接了电话']],
      ['30655190', ['今天直播', '小明来了']]
    ] as [string, string[]][]) {
      expect(check(roomId, input).texts).toEqual(input);
    }
  });

  test.each(configs)('normalizes the user-confirmed 小康 alias only in the three configured rooms', config => {
    for (const roomId of ['25788785', '26966466', '30655190']) {
      expect(check(roomId, ['小康来了', '不会是小岁小康吧'], 60, config).texts)
        .toEqual(['小栞来了', '不会是小岁小栞吧']);
      for (const text of ['小康社会', '全面小康', '小康家庭', '小康生活', '不是小康', '另一个小康', '小康同学']) {
        expect(check(roomId, [text], 4, config)).toMatchObject({ texts: [text], edits: [], checks: [] });
      }
    }
    expect(check('23260993', ['不会是小岁小康吧'], 4, config).texts).toEqual(['不会是小岁小康吧']);
    expect(check('123', ['小康来了'], 4, config).texts).toEqual(['小康来了']);
  });
});
