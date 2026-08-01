const aiTextGenerator = require('./ai_text_generator');

describe('ai_text_generator speaker guidance', () => {
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
});
