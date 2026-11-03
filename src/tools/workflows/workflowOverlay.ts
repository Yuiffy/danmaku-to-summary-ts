import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { createHash } from 'crypto';

/** Publish selected leaf stages while retaining all other active bytes and entries. */
export function overlayLeafWorkflows(root: string, compiled: string, stage: string, selected: string[], entries: Record<string, string>) {
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(key => !entries[key])) {
    throw new Error('Workflow overlay needs unique known entries');
  }
  const pointer = path.join(root, 'data/runtime/workflow-release.json');
  const pointerText = fs.readFileSync(pointer, 'utf8');
  const base = JSON.parse(pointerText), manifest = JSON.parse(fs.readFileSync(path.join(base.releaseDir, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.files || !manifest.entries) throw new Error('Active workflow manifest is incomplete');
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const source = path.resolve(base.releaseDir, relative), inside = path.relative(base.releaseDir, source);
    if (path.isAbsolute(relative) || inside.startsWith('..') || path.isAbsolute(inside)
      || createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== digest) {
      throw new Error('Active workflow file integrity failed');
    }
    const target = path.join(stage, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  }
  const nextEntries = { ...manifest.entries };
  for (const key of selected) {
    const relative = entries[key], file = path.join(compiled, relative);
    const ast = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const argument = node.arguments[0];
        if (!argument || !ts.isStringLiteral(argument) || argument.text.startsWith('.')) {
          throw new Error('Workflow overlay supports leaf entries only; activate dependencies together through a complete release');
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    for (const name of [relative, relative.replace(/\.js$/u, '.d.ts')]) {
      const target = path.join(stage, name); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(compiled, name), target);
    }
    nextEntries[key] = relative;
  }
  return { entries: nextEntries, pointerText };
}
