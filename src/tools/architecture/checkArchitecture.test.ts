import { boundaryViolation, findCycles, getModuleSpecifiers, pythonBoundaryViolation } from './checkArchitecture';

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

test('allows local screenshot processes without opening provider access to comic components', () => {
  expect(pythonBoundaryViolation('src/scripts/comic/screenshots.py', 'subprocess')).toBeUndefined();
  expect(pythonBoundaryViolation('src/scripts/comic/screenshots.py', 'requests.sessions')).toBeDefined();
  expect(pythonBoundaryViolation('src/scripts/comic/screenshots.py', 'ai_comic_generator')).toBeDefined();
  expect(pythonBoundaryViolation('src/scripts/comic/storyboard.py', 'subprocess')).toBeDefined();
  expect(pythonBoundaryViolation('src/scripts/comic/prompts.py', 'subprocess')).toBeDefined();
});

test('permits the managed Node text bridge without granting it direct provider access', () => {
  expect(pythonBoundaryViolation('src/scripts/comic/text_client.py', 'subprocess')).toBeUndefined();
  expect(pythonBoundaryViolation('src/scripts/comic/text_client.py', 'requests')).toBeDefined();
  expect(pythonBoundaryViolation('src/scripts/comic/text_client.py', 'tuzi_chat_completions')).toBeDefined();
});
