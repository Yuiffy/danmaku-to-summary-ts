const path = require('path');
const { jest: base } = require('../package.json');

// Run the same workflow assertions against the isolated emitted service modules.
module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '..'),
  // Keep the glob relative: Jest preserves Windows "\\." as a glob escape
  // when substituting rootDir, which breaks worktrees under a .codex folder.
  testMatch: ['**/tests/integration/**/*.test.ts'],
  moduleNameMapper: {
    '^(?:[.][.]/){2}src/(.*)$': '<rootDir>/build/service/$1',
    ...base.moduleNameMapper
  }
};
