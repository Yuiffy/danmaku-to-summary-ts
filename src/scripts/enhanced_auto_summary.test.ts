const path = require('path');
const fs = require('fs');
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
    const scriptPath = path.join(__dirname, 'enhanced_auto_summary.js');
    const source = fs.readFileSync(scriptPath, 'utf8');

    expect(source).toContain("emotionModelLoadSeconds: seconds('emotion_model_load_s')");
    expect(source).toContain("emotionInferenceSeconds: seconds('emotion_inference_s')");
    expect(source).toContain("emotionTotalSeconds: seconds('emotion_total_s')");
    expect(source).toContain('情感加载=${summary.emotionModelLoadSeconds.toFixed(1)}s');
    expect(source).toContain('情感推理=${summary.emotionInferenceSeconds.toFixed(1)}s');
    expect(source).toContain('情感总计=${summary.emotionTotalSeconds.toFixed(1)}s');
  });
});
