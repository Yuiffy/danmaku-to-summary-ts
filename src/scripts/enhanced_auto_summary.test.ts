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
});
