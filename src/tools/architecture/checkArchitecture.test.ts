import { boundaryViolation, findCycles, getModuleSpecifiers } from './checkArchitecture';

test('recognizes real imports while ignoring prompt text and comments', () => {
  const source = `
    // require('../wrong')
    const prompt = "import '../also-wrong'";
    import { value } from './policy';
    export { helper } from './helper';
    const legacy = require('./legacy');
    const lazy = import('./lazy');
  `;
  expect(getModuleSpecifiers('fixture.ts', source)).toEqual(['./policy', './helper', './legacy', './lazy']);
});

test('finds a transitive dependency cycle but permits shared leaves', () => {
  expect(findCycles(new Map([
    ['a', ['b', 'shared']], ['b', ['c', 'shared']], ['c', ['a']], ['shared', []]
  ]))).toEqual([['a', 'b', 'c', 'a']]);
  expect(findCycles(new Map([['a', ['shared']], ['b', ['shared']], ['shared', []]]))).toEqual([]);
});

test.each([
  ['src/core/config/fixture.ts', 'src/services/ServiceManager.ts'],
  ['src/app/api/fixture/route.ts', 'src/services/ServiceManager.ts'],
  ['src/scripts/clipping/topic_selection.js', 'src/scripts/topic_clipper.js'],
  ['src/services/bilibili/delayed-reply/Policy.ts', 'src/services/bilibili/DelayedReplyService.ts']
])('rejects ownership reversal from %s', (file, dependency) => {
  expect(boundaryViolation(file, dependency)).toBeDefined();
});

test('permits service composition using shared infrastructure', () => {
  expect(boundaryViolation('src/services/ServiceManager.ts', 'src/core/config/ConfigProvider.ts')).toBeUndefined();
});
