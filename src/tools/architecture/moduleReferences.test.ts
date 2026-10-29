import { moduleReferences } from './moduleReferences';

test('resolves named createRequire aliases and workflow bridges without parsing prompt text', () => {
  const parsed = moduleReferences('fixture.ts', `
    import { createRequire as makeRequire } from 'node:module';
    const rootRequire = makeRequire(path.resolve(process.env.DANMAKU_PROJECT_ROOT || '.', 'package.json'));
    const local = makeRequire(import.meta.url);
    rootRequire('./src/shared'); local('./sibling');
    const { loadWorkflow: load } = rootRequire('./src/scripts/workflow-runtime');
    load('text/prompts');
    const bridge = require('./workflow-runtime'); bridge.loadWorkflow('text/response');
    require('./workflow-runtime').loadWorkflow('text/policy');
    const prompt = "load('not-real')"; // rootRequire('./not-real')
  `);
  expect(parsed.unresolved).toEqual([]);
  expect(parsed.references).toEqual(expect.arrayContaining([
    { specifier: './src/shared', base: 'project' }, { specifier: './sibling', base: 'caller' },
    { specifier: 'text/prompts', base: 'workflow' }, { specifier: 'text/response', base: 'workflow' },
    { specifier: 'text/policy', base: 'workflow' }
  ]));
  expect(parsed.references.some(row => row.specifier.includes('not-real'))).toBe(false);
});

test('inventories computed targets and unknown anchors without inventing graph edges', () => {
  const parsed = moduleReferences('fixture.ts', `
    import { createRequire } from 'module';
    const custom = createRequire(config.anchor);
    custom('./thing'); require(variable); import(dynamicPath);
    const { loadWorkflow } = require('./workflow-runtime'); loadWorkflow(key);
  `);
  expect(parsed.unresolved).toHaveLength(4);
  expect(parsed.unresolved.every(row => row.line > 0 && row.expression)).toBe(true);
  expect(parsed.references).not.toContainEqual({ specifier: './thing', base: 'caller' });
});

test('supports default repository anchor and direct workflow import alias', () => {
  const parsed = moduleReferences('fixture.ts', `
    import { createRequire } from 'node:module';
    import { loadWorkflow as stage } from './workflow-runtime';
    const root = createRequire(path.resolve('package.json'));
    const caller = createRequire(__filename);
    root('./src/core/policy.ts'); caller('./helper'); stage('config/loader');
  `);
  expect(parsed.references).toEqual(expect.arrayContaining([
    { specifier: './src/core/policy.ts', base: 'project' }, { specifier: './helper', base: 'caller' },
    { specifier: 'config/loader', base: 'workflow' }
  ]));
});
