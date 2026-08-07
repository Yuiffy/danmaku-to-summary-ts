const aiTextGenerator = require('./ai_text_generator');

describe('ai_text_generator speaker guidance', () => {
  test('uses a concise, concrete opening instruction without cliché examples', () => {
    const prompt = aiTextGenerator.buildPrompt(
      '主播把水杯打翻后说“今天和桌子有仇”，弹幕都在笑。',
      '26966466',
      '21:00~23:00'
    );

    expect(prompt).toContain('优先直接回应本场一个具体细节、主播原话或弹幕反应');
    expect(prompt).toContain('不必固定放在开头');
    expect(prompt).not.toContain('【去模板化要求（高优先级）】');
    expect(prompt).not.toContain('一句话总结今天直播的整体感受');
    expect(prompt).not.toContain('含金量极高、含梗量爆炸');
  });

  test('keeps anonymous guest self-introductions separate from the room owner', () => {
    const prompt = aiTextGenerator.buildPrompt(
      '[栞栞 0.65] 你好\n[SPEAKER_04 0.57] 大家好，我是露露',
      '26966466',
      '21:00~23:00'
    );

    expect(prompt).toMatch(/回复对象始终是房主\S+/u);
    expect(prompt).toContain('不能把房主改叫XX');
    expect(prompt).toContain('“SPEAKER_nn”表示尚未实名的嘉宾或外部声音');
    expect(prompt).toContain('[SPEAKER_04 0.57] 大家好，我是露露');
  });

  test('injects live facts ahead of a conditional catchphrase hint', () => {
    const prompt = aiTextGenerator.buildPrompt(
      '主播说今天来代抽，字幕多次出现明日方舟。',
      '30655190',
      '11:57~13:33',
      {
        liveTitle: '明日方舟代抽⭐',
        recentDynamics: [{
          publishTime: '2026-08-01T03:53:22.000Z',
          content: '来了！代抽明日方舟咯！'
        }],
        contentHints: ['孤立的“启动”可能是“原神启动”梗，但不能据此判断本场游戏。']
      }
    );

    expect(prompt).toContain('直播标题：明日方舟代抽⭐');
    expect(prompt).toContain('代抽明日方舟咯');
    expect(prompt).toContain('不得因为人物设定中的某款游戏或口头禅');
    expect(prompt).toContain('字幕多次出现明日方舟');
  });

  test('keeps Shiori address names separate from her fan name', () => {
    const prompt = aiTextGenerator.buildPrompt(
      '主播玩了第五人格，和观众连麦聊天，最后提醒明天下午去诊所。',
      '26966466',
      '21:00~23:00'
    );

    expect(prompt).toContain('主播可用称呼只有：“小栞”、“栞栞”、“栞栞Shiori”、“Shiori”');
    expect(prompt).toContain('粉丝昵称是“獭獭栞”');
    expect(prompt).toContain('不能写“獭獭栞！”');
    expect(prompt).toContain('开头不必每次直呼主播名字');
  });

  test('offers the Chinese part of a bilingual anchor name as a natural short address', () => {
    const configLoader = require('./config-loader');
    const config = structuredClone(configLoader.getConfig());
    config.ai.roomSettings = config.ai.roomSettings || {};
    config.ai.roomSettings['bilingual-name-test'] = {
      anchorName: '莉蔻Liko',
      fanName: '蔻萝特'
    };
    const configSpy = jest.spyOn(configLoader, 'getConfig').mockReturnValue(config);
    const namesSpy = jest.spyOn(configLoader, 'getNames').mockReturnValue({
      anchor: '莉蔻Liko',
      fan: '蔻萝特'
    });
    let prompt;
    try {
      prompt = aiTextGenerator.buildPrompt(
        '主播唱歌忘词后躲进被窝。',
        'bilingual-name-test',
        '20:00~23:00'
      );
    } finally {
      namesSpy.mockRestore();
      configSpy.mockRestore();
    }

    expect(prompt).toContain('主播可用称呼只有：“莉蔻”、“莉蔻Liko”');
    expect(prompt).toContain('不要每条都固定照抄“莉蔻Liko”');
  });

  test('rejects a reply that opens with the fan name', () => {
    const invalid = aiTextGenerator.inspectGeneratedReply(
      `獭獭栞！🌙${'今晚含梗量爆表，记得早点休息。'.repeat(12)}`,
      250,
      '26966466'
    );

    expect(invalid.ok).toBe(false);
    expect(invalid.reason).toContain('粉丝昵称');

    const valid = aiTextGenerator.inspectGeneratedReply(
      '小栞！🌙今晚第五人格摸金节目效果拉满，加载、迷路和没人进房间全成了梗。连麦聊天也很有意思，潮汕牛肉火锅和恐怖片的话题也聊得很开心。明天下午记得去诊所看看牙，不要硬撑，早点休息晚安捏。',
      250,
      '26966466'
    );

    expect(valid.ok).toBe(true);
  });
});
