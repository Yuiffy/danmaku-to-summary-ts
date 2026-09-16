const path = require('path');
const { ESLint } = require('eslint');

describe('enhanced_auto_summary', () => {
  test('does not reference variables outside their scope', async () => {
    const eslint = new ESLint({ useEslintrc: true });
    const scriptPath = path.join(__dirname, 'enhanced_auto_summary.js');
    const [result] = await eslint.lintFiles([scriptPath]);
    const undefinedVariableErrors = result.messages
      .filter((message: { ruleId: string | null }) => message.ruleId === 'no-undef')
      .map((message: { line: number; column: number; message: string }) => (
        `${message.line}:${message.column} ${message.message}`
      ));

    expect(undefinedVariableErrors).toEqual([]);
  });

  test('reports the SenseVoice emotion stage timings', () => {
    const { loadWorkflow } = require('./workflow-runtime');
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const result = loadWorkflow('summary/diagnostics').logAsrTimings({
        emotion_model_load_s: 1, emotion_inference_s: 2, emotion_total_s: 3
      }, 100);
      expect(result).toMatchObject({ emotionModelLoadSeconds: 1, emotionInferenceSeconds: 2, emotionTotalSeconds: 3 });
      expect(log).toHaveBeenLastCalledWith(`[[ASR_TIMING]] ${JSON.stringify(result)}`);
    } finally { log.mockRestore(); }
  });
});
