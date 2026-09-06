import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as ts from 'typescript';

const sourceRoots = ['src', 'scripts', 'tools'];
const typedRoots = ['src/app/', 'src/core/', 'src/services/', 'src/utils/', 'src/tools/'];
const codeExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py']);
const defaultLineBudget = 1200;
// Historical oversized modules are frozen at their reviewed size. Only lower these.
const lineBudgets: Record<string, number> = {
  'src/services/bilibili/DelayedReplyService.ts': 1851,
  'src/services/webhook/handlers/MikufansWebhookHandler.ts': 1716,
  'src/scripts/ai_comic_generator.py': 3390,
  'src/scripts/clip_upload_registry.py': 2602,
  'src/scripts/topic_clipper.js': 2378,
  'src/scripts/own_stream_clipper.js': 2265,
  'src/scripts/python/sensevoice_speaker.py': 2331,
  'src/scripts/tuzi_chat_completions.py': 2258,
  'src/scripts/ai_text_generator.js': 2235,
  'src/scripts/enhanced_auto_summary.js': 2131,
  'src/scripts/clipping/topic_compilation.js': 1600,
  'src/scripts/audio_processor.js': 1496,
  'src/scripts/asr/asr_backends.js': 1406,
  'src/scripts/asr/asr_corrections.js': 1243,
  'src/scripts/python/sensevoice_runtime.py': 1214
};
const allowedRootCodeFiles = new Set([
  'drag_generate_comic.bat', 'drag_generate_goodnight.bat', 'ecosystem.config.js',
  'next-env.d.ts', 'next.config.mjs', 'postcss.config.mjs', 'tailwind.config.ts'
]);
const isTest = (file: string) => /\.(test|spec)\.[^/]+$/.test(file)
  || /(^|\/)(test_[^/]+|__tests__|test_data)(\/|$)/.test(file);
const normalize = (file: string) => file.replace(/\\/g, '/');

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !['__pycache__', 'node_modules', 'temp'].includes(entry.name)) {
      return walk(fullPath);
    }
    return entry.isFile() ? [fullPath] : [];
  });
}

/** Parse actual module references, not comments, prompt strings, or incidental text. */
export function getModuleSpecifiers(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = new Set<string>();
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
      imports.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...imports];
}

export function findCycles(graph: Map<string, string[]>): string[][] {
  const visited = new Set<string>();
  const active: string[] = [];
  const cycles: string[][] = [];
  function visit(file: string): void {
    const index = active.indexOf(file);
    if (index >= 0) {
      cycles.push([...active.slice(index), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    active.push(file);
    for (const dependency of graph.get(file) || []) visit(dependency);
    active.pop();
  }
  for (const file of graph.keys()) visit(file);
  return cycles;
}

export function boundaryViolation(file: string, dependency: string): string | undefined {
  if ((file.startsWith('src/core/') || file.startsWith('src/utils/'))
    && /^src\/(services|app|scripts)\//.test(dependency)) {
    return 'shared infrastructure must not depend on service, app, or workflow modules';
  }
  if (file.startsWith('src/services/') && dependency.startsWith('src/app/')) {
    return 'services must not depend on application entrypoints';
  }
  if (file.startsWith('src/app/api/') && dependency.startsWith('src/services/')) {
    return 'web adapters must call the running webhook API, not create service instances';
  }
  if (/src\/scripts\/clipping\/(?:topic_selection|own_selection|topic_config)\.js$/.test(file)
    && /src\/scripts\/(?:topic_clipper|own_stream_clipper|manual_clip_queue)\.js$/.test(dependency)) {
    return 'clip decisions must not import their parent workflows';
  }
  if (file.startsWith('src/services/bilibili/delayed-reply/')
    && dependency === 'src/services/bilibili/DelayedReplyService.ts') {
    return 'delayed-reply components must not import their parent service';
  }
  return undefined;
}

function resolveLocalImport(root: string, file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return undefined;
  const base = specifier.startsWith('@/')
    ? path.join(root, 'src', specifier.slice(2))
    : path.resolve(root, path.dirname(file), specifier);
  const candidates = [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json',
    '/index.ts', '/index.tsx', '/index.js'].map(suffix => base + suffix)];
  const resolved = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  return resolved ? normalize(path.relative(root, resolved)) : undefined;
}

export function pythonBoundaryViolation(file: string, dependency: string): string | undefined {
  if (!file.startsWith('src/scripts/comic/')) return undefined;
  if (/^(ai_comic_generator|config_loader|tuzi_chat_completions|requests)(\.|$)/.test(dependency)) {
    return 'comic components must not import parent orchestration or provider IO';
  }
  if (file !== 'src/scripts/comic/screenshots.py' && /^subprocess(\.|$)/.test(dependency)) {
    return 'comic process execution belongs in screenshots.py';
  }
  return undefined;
}

function inspectPython(root: string, files: string[], violations: string[]): void {
  // AST-only inspection: do not import ML runtimes or execute operator diagnostics.
  const script = [
    'import ast, json, pathlib, sys',
    'result = {}',
    'for name in json.load(sys.stdin):',
    '    tree = ast.parse(pathlib.Path(name).read_text(encoding="utf-8-sig"), filename=name)',
    '    modules = set()',
    '    for node in ast.walk(tree):',
    '        if isinstance(node, ast.Import): modules.update(alias.name for alias in node.names)',
    '        elif isinstance(node, ast.ImportFrom): modules.add(node.module or "")',
    '    result[name] = sorted(modules)',
    'print(json.dumps(result))'
  ].join('\n');
  const result = spawnSync(process.env.PYTHON || 'python', ['-c', script], {
    cwd: root, input: JSON.stringify(files), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1' }, maxBuffer: 4 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    violations.push('Python AST inspection failed: ' + (result.error?.message || result.stderr.trim()));
    return;
  }
  const imports = JSON.parse(result.stdout) as Record<string, string[]>;
  for (const [file, dependencies] of Object.entries(imports)) {
    for (const dependency of dependencies) {
      const reason = pythonBoundaryViolation(file, dependency);
      if (reason) violations.push(file + ' -> ' + dependency + ': ' + reason);
    }
  }
}

export function inspectArchitecture(root: string) {
  const violations: string[] = [];
  const files = sourceRoots.flatMap(directory => walk(path.join(root, directory)))
    .filter(file => codeExtensions.has(path.extname(file)))
    .map(file => normalize(path.relative(root, file)));
  const production = files.filter(file => !isTest(file));
  const graph = new Map<string, string[]>();
  const inventory = production.map(file => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = text.split(/\r?\n/).length;
    const budget = lineBudgets[file] ?? defaultLineBudget;
    if (lines > budget) violations.push(file + ': ' + lines + ' lines exceeds budget ' + budget);
    if (typedRoots.some(prefix => file.startsWith(prefix)) && /\.(js|mjs|cjs|py)$/.test(file)) {
      violations.push(file + ': service/control modules must use TypeScript');
    }
    if (!file.endsWith('.py')) {
      const dependencies = getModuleSpecifiers(file, text)
        .map(specifier => resolveLocalImport(root, file, specifier)).filter((file): file is string => !!file);
      graph.set(file, dependencies.filter(dependency => !isTest(dependency)));
      for (const dependency of dependencies) {
        const reason = boundaryViolation(file, dependency);
        if (reason) violations.push(file + ' -> ' + dependency + ': ' + reason);
      }
    }
    if (file.endsWith('/MikufansWebhookHandler.ts') && /whisper_queue_manager|speaker_once_registry|enhanced_auto_summary/.test(text)) {
      violations.push(file + ': summary queue/process ownership belongs in MikufansSummaryQueueWorker');
    }
    if (file.endsWith('/DelayedReplyService.ts') && /\b(?:setInterval|setTimeout|clearInterval|clearTimeout)\s*\(/.test(text)) {
      violations.push(file + ': timers belong in DelayedReplyScheduler');
    }
    return { path: file, lines, budget };
  });
  const cycles = findCycles(graph);
  for (const cycle of cycles) violations.push('Dependency cycle: ' + cycle.join(' -> '));
  inspectPython(root, production.filter(file => file.endsWith('.py')), violations);

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(bat|js|mjs|cjs|py|ps1|ts|tsx)$/.test(entry.name)
      && !allowedRootCodeFiles.has(entry.name)) {
      violations.push(entry.name + ': source-like files belong under src/, scripts/, tools/, or local-scripts/');
    }
  }
  const build = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.build.json'), 'utf8'));
  if (build.compilerOptions?.allowJs !== false || build.compilerOptions?.noEmitOnError !== true) {
    violations.push('tsconfig.build.json must keep allowJs:false and noEmitOnError:true');
  }
  const buildInputs = ts.parseJsonConfigFileContent(build, ts.sys, root).fileNames;
  if (buildInputs.some(file => /\/src\/app\/(api\/|.*\.tsx$)/.test(normalize(file)))) {
    violations.push('service build must exclude Next.js routes and UI');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.scripts?.prebuild) violations.push('build must not have an implicit prebuild side effect');
  const languages: Record<string, number> = {};
  for (const file of files) languages[path.extname(file)] = (languages[path.extname(file)] || 0) + 1;
  return { languages, inventory, cycles, violations };
}

if (require.main === module) {
  const report = inspectArchitecture(process.cwd());
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('Architecture inventory: ' + JSON.stringify(report.languages));
    console.log('Largest production/workflow modules:');
    for (const file of [...report.inventory].sort((a, b) => b.lines - a.lines).slice(0, 10)) {
      console.log('- ' + file.lines + '/' + file.budget + ' ' + file.path);
    }
    for (const violation of report.violations) console.error('- ' + violation);
    console.log(report.violations.length ? 'Architecture constraints failed.' : 'Architecture constraints passed.');
  }
  if (report.violations.length) process.exitCode = 1;
}
