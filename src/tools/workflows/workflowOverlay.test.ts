import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { overlayLeafWorkflows } from './workflowOverlay';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-overlay-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fixture(code = 'exports.updated = true;') {
  const active = path.join(root, 'active'), compiled = path.join(root, 'compiled'), stage = path.join(root, 'stage');
  const original = { 'leaf.js': 'exports.old = true;', 'leaf.d.ts': 'export declare const old: true;',
    'peer.js': 'exports.untouched = true;', 'peer.d.ts': 'export declare const untouched: true;' };
  for (const directory of [active, compiled, stage, path.join(root, 'data/runtime')]) fs.mkdirSync(directory, { recursive: true });
  for (const [file, content] of Object.entries(original)) fs.writeFileSync(path.join(active, file), content);
  const files = Object.fromEntries(Object.entries(original).map(([file, content]) => [file,
    createHash('sha256').update(content).digest('hex')]));
  fs.writeFileSync(path.join(active, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files,
    entries: { leaf: 'leaf.js', peer: 'peer.js' } }));
  const pointer = JSON.stringify({ releaseDir: active });
  fs.writeFileSync(path.join(root, 'data/runtime/workflow-release.json'), pointer);
  fs.writeFileSync(path.join(compiled, 'leaf.js'), code);
  fs.writeFileSync(path.join(compiled, 'leaf.d.ts'), 'export declare const updated: true;');
  fs.writeFileSync(path.join(compiled, 'peer.js'), 'exports.unreviewed = true;');
  return { active, compiled, stage, original, pointer };
}

test('replaces selected leaf pairs while preserving active peer bytes and pointer', () => {
  const f = fixture();
  const result = overlayLeafWorkflows(root, f.compiled, f.stage, ['leaf'], { leaf: 'leaf.js', peer: 'peer.js' });
  expect(result).toEqual({ entries: { leaf: 'leaf.js', peer: 'peer.js' }, pointerText: f.pointer });
  expect(fs.readFileSync(path.join(f.stage, 'leaf.js'), 'utf8')).toBe('exports.updated = true;');
  expect(fs.readFileSync(path.join(f.stage, 'leaf.d.ts'), 'utf8')).toContain('updated');
  for (const name of ['peer.js', 'peer.d.ts']) expect(fs.readFileSync(path.join(f.stage, name), 'utf8')).toBe(f.original[name as keyof typeof f.original]);
  expect(fs.readFileSync(path.join(root, 'data/runtime/workflow-release.json'), 'utf8')).toBe(f.pointer);
});

test.each(['require("./dependency")', 'require(moduleName)'])('rejects non-leaf dependency %s', code => {
  const f = fixture(code);
  expect(() => overlayLeafWorkflows(root, f.compiled, f.stage, ['leaf'], { leaf: 'leaf.js' })).toThrow('leaf entries only');
  expect(fs.readFileSync(path.join(root, 'data/runtime/workflow-release.json'), 'utf8')).toBe(f.pointer);
});

test('rejects corrupted active files rather than carrying them into a new release', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.active, 'peer.js'), 'corrupted');
  expect(() => overlayLeafWorkflows(root, f.compiled, f.stage, ['leaf'], { leaf: 'leaf.js' })).toThrow('integrity');
});

test.each([['missing'], ['leaf', 'leaf']])('rejects unknown or duplicate selected entries %j', (...selected) => {
  const f = fixture();
  expect(() => overlayLeafWorkflows(root, f.compiled, f.stage, selected, { leaf: 'leaf.js' })).toThrow('unique known');
});
