const path = require('path');
const { jest: base } = require('../package.json');

// Run the same workflow assertions against the isolated emitted service modules.
module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, '..'),
  testMatch: ['<rootDir>/tests/integration/**/*.test.ts'],
  moduleNameMapper: {
    '^(?:[.][.]/){2}src/(.*)$': '<rootDir>/build/service/$1',
    ...base.moduleNameMapper
  }
};
