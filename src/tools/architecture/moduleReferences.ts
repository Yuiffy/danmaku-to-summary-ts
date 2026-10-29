import * as ts from 'typescript';

export interface ModuleReference { specifier: string; base: 'caller' | 'project' | 'workflow' | 'unknown' }
export interface UnresolvedReference { line: number; expression: string }

/** Parse the fixed module bridges used in this repository; report computed targets separately. */
export function moduleReferences(file: string, text: string) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const references: ModuleReference[] = [], unresolved: UnresolvedReference[] = [];
  const loaders = new Map<string, ModuleReference['base']>([['require', 'caller']]);
  const factories = new Set<string>(), bridges = new Set<string>(), workflowLoaders = new Set<string>();
  const literal = (node?: ts.Node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  const walk = (node: ts.Node, visit: (node: ts.Node) => void) => { visit(node); ts.forEachChild(node, child => walk(child, visit)); };
  const runtime = (node?: ts.Node): boolean => !!node && ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && loaders.has(node.expression.text)
    && /(?:^|\/)workflow-runtime(?:\.js)?$/u.test(literal(node.arguments[0]) || '');
  walk(source, node => {
    if (!ts.isImportDeclaration(node)) return;
    const from = literal(node.moduleSpecifier), names = node.importClause?.namedBindings;
    if (!names || !ts.isNamedImports(names)) return;
    for (const name of names.elements) {
      const imported = name.propertyName?.text || name.name.text;
      if (['module', 'node:module'].includes(from || '') && imported === 'createRequire') factories.add(name.name.text);
      if (/(?:^|\/)workflow-runtime(?:\.js)?$/u.test(from || '') && imported === 'loadWorkflow') workflowLoaders.add(name.name.text);
    }
  });
  walk(source, node => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer
      || !ts.isCallExpression(node.initializer) || !ts.isIdentifier(node.initializer.expression)
      || !factories.has(node.initializer.expression.text)) return;
    const anchor = node.initializer.arguments[0];
    let base: ModuleReference['base'] = 'unknown';
    if (anchor?.getText(source) === '__filename' || anchor?.getText(source) === 'import.meta.url') base = 'caller';
    if (anchor && ts.isCallExpression(anchor) && ts.isPropertyAccessExpression(anchor.expression)
      && anchor.expression.name.text === 'resolve' && literal(anchor.arguments.at(-1)) === 'package.json'
      && anchor.arguments.slice(0, -1).every(arg => literal(arg) === '.'
        || arg.getText(source).replace(/\s/gu, '') === "process.env.DANMAKU_PROJECT_ROOT||'.'"
        || arg.getText(source).replace(/\s/gu, '') === 'process.env.DANMAKU_PROJECT_ROOT||"."')) base = 'project';
    loaders.set(node.name.text, base);
  });
  walk(source, node => {
    if (!ts.isVariableDeclaration(node) || !runtime(node.initializer)) return;
    if (ts.isIdentifier(node.name)) bridges.add(node.name.text);
    else if (ts.isObjectBindingPattern(node.name)) for (const binding of node.name.elements) {
      if ((binding.propertyName?.getText(source) || binding.name.getText(source)) === 'loadWorkflow'
        && ts.isIdentifier(binding.name)) workflowLoaders.add(binding.name.text);
    }
  });
  walk(source, node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const specifier = literal(node.moduleSpecifier);
      if (specifier) references.push({ specifier, base: 'caller' });
      return;
    }
    if (!ts.isCallExpression(node)) return;
    const expression = node.expression;
    let base: ModuleReference['base'] | undefined;
    if (expression.kind === ts.SyntaxKind.ImportKeyword) base = 'caller';
    else if (ts.isIdentifier(expression)) base = workflowLoaders.has(expression.text) ? 'workflow' : loaders.get(expression.text);
    else if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'loadWorkflow'
      && (runtime(expression.expression) || ts.isIdentifier(expression.expression) && bridges.has(expression.expression.text))) base = 'workflow';
    if (base === undefined) return;
    const specifier = literal(node.arguments[0]);
    if (specifier && base !== 'unknown') references.push({ specifier, base });
    else unresolved.push({ line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, expression: node.getText(source).slice(0, 180) });
  });
  return { references, unresolved };
}
