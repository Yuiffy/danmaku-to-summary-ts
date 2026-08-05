import { AITextGenerator } from './AITextGenerator';

function createGeneratorForTest(): any {
  const generator = Object.create(AITextGenerator.prototype) as any;
  generator.config = {
    ai: {
      defaultNames: { anchor: '主播', fan: '粉丝' },
      roomSettings: {
        '26966466': {
          anchorName: '小栞',
          anchorNicknames: ['栞栞', '栞栞Shiori', 'Shiori'],
          fanName: '獭獭栞',
          wordLimit: 250
        }
      }
    }
  };
  return generator;
}

describe('AITextGenerator goodnight naming boundary', () => {
  test('lists主播 names separately from the fan name', () => {
    const generator = createGeneratorForTest();
    const prompt = generator.buildGoodnightPrompt(
      '主播玩了第五人格，和观众连麦聊天。',
      '26966466',
      '21:00~23:00'
    );

    expect(prompt).toContain('主播可用称呼只有：“小栞”、“栞栞”、“栞栞Shiori”、“Shiori”');
    expect(prompt).toContain('粉丝昵称是“獭獭栞”');
    expect(prompt).toContain('字数要求：250字以内');
    expect(prompt).toContain('称呼之后直接回应本场一个具体细节、主播原话或弹幕反应');
    expect(prompt).not.toContain('【去模板化要求（高优先级）】');
    expect(prompt).not.toContain('一句话总结今天直播的整体感受');
    expect(prompt).not.toContain('含金量极高、含梗量爆炸');
  });

  test('rejects a fan name used as the opening address', () => {
    const generator = createGeneratorForTest();
    const inspection = generator.inspectGeneratedReply(
      `獭獭栞！🌙${'今晚含梗量爆表，早点休息。'.repeat(12)}`,
      250,
      '26966466'
    );

    expect(inspection.ok).toBe(false);
    expect(inspection.reason).toContain('粉丝昵称');
  });
});
