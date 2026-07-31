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
});
