export {};
const asr = require('./asr_backends');
const { applyCorrectionsToSegments, buildPhonemeCorrectionPayload } = require('./asr_corrections');

describe.each(['default', 'production'])('%s keyword replacement protections', environment => {
  const config = require(`../../../config/${environment}.json`);
  const runtime = asr.resolveAsrHotwords(config, {});

  test('preserves evidenced ordinary phrases while still correcting real name uses', () => {
    const texts = ['小四今天直播了吗', '最多就是小四位', '你对小四十小鹿太严格了',
      '你对小四个小鹿太严格了', '小四今天来了，这张牌小四位', '小四位列第一'];
    const output = applyCorrectionsToSegments(texts.map(text => ({ text })), runtime.corrections);
    expect(output[0]).toBe('小岁今天直播了吗');
    expect(output.slice(1, 4)).toEqual(texts.slice(1, 4));
    expect(output[4]).toBe('小岁今天来了，这张牌小四位');
    expect(output[5]).toBe('小岁位列第一');
  });

  test('forwards the same protections to phoneme correction', () => {
    const payload = buildPhonemeCorrectionPayload({ enabled: true, hotwords: '小岁' }, runtime.corrections, config.asr.corrections);
    expect(payload.protect_terms).toEqual(expect.arrayContaining(['小四十小鹿', '小四个小鹿']));
    expect(payload.exclude_patterns).toContain('小四位(?![于列居置])');
  });

  test('protects a phrase split across subtitle rows', () => {
    const output = applyCorrectionsToSegments([{ text: '最多就是小四' }, { text: '位' }, { text: '小四今天直播' }], runtime.corrections);
    expect(output).toEqual(['最多就是小四', '位', '小岁今天直播']);
  });
});
