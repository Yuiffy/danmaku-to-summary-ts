import * as fs from 'fs';
import * as path from 'path';

const projectRoot = process.cwd();
const productionRoots = ['src/app', 'src/core', 'src/services', 'src/utils', 'src/tools'];
const defaultLineBudget = 1200;
const lineBudgetExceptions: Record<string, number> = {
  'src/services/bilibili/DelayedReplyService.ts': 2850,
  'src/services/webhook/handlers/MikufansWebhookHandler.ts': 1800
};
const boundaryRules: Array<{ relativePath: string; forbidden: RegExp; message: string }> = [
  {
    relativePath: 'src/services/webhook/handlers/MikufansWebhookHandler.ts',
    forbidden: /whisper_queue_manager|speaker_once_registry|enhanced_auto_summary/,
    message: 'webhook lifecycle handlers must call MikufansSummaryQueueWorker instead of legacy workflow modules'
  },
  {
    relativePath: 'src/services/bilibili/DelayedReplyService.ts',
    forbidden: /\b(?:setInterval|setTimeout|clearInterval|clearTimeout)\s*\(/,
    message: 'delayed-reply timer ownership belongs in DelayedReplyScheduler'
  }
];
const allowedRootCodeFiles = new Set([
  'drag_generate_comic.bat',
  'drag_generate_goodnight.bat',
  'ecosystem.config.js',
  'next-env.d.ts',
  'next.config.mjs',
  'postcss.config.mjs',
  'tailwind.config.ts'
]);
const rootCodeExtensions = new Set(['.bat', '.js', '.mjs', '.py', '.ps1', '.ts', '.tsx']);

interface SourceFileInfo {
  path: string;
  lines: number;
}

function toProjectPath(filePath: string): string {
  return path.relative(projectRoot, filePath).replace(/\\/g, '/');
}

function walk(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function countLines(filePath: string): number {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).length;
}

function countLegacyScripts(extension: '.js' | '.py'): number {
  return ['src/scripts', 'scripts']
    .flatMap(directory => walk(path.join(projectRoot, directory)))
    .filter(filePath => path.extname(filePath).toLowerCase() === extension)
    .length;
}

function main(): void {
  const violations: string[] = [];
  const sourceFiles: SourceFileInfo[] = [];

  for (const relativeRoot of productionRoots) {
    for (const filePath of walk(path.join(projectRoot, relativeRoot))) {
      const relativePath = toProjectPath(filePath);
      const extension = path.extname(filePath).toLowerCase();
      if (['.js', '.mjs', '.cjs', '.py'].includes(extension)) {
        violations.push(`${relativePath}: production modules must use TypeScript`);
        continue;
      }
      if (!['.ts', '.tsx'].includes(extension) || /\.(test|spec)\.tsx?$/.test(relativePath)) {
        continue;
      }

      const lines = countLines(filePath);
      const budget = lineBudgetExceptions[relativePath] ?? defaultLineBudget;
      sourceFiles.push({ path: relativePath, lines });
      if (lines > budget) {
        violations.push(`${relativePath}: ${lines} lines exceeds its ${budget}-line budget`);
      }
    }
  }

  for (const rule of boundaryRules) {
    const filePath = path.join(projectRoot, rule.relativePath);
    if (fs.existsSync(filePath) && rule.forbidden.test(fs.readFileSync(filePath, 'utf8'))) {
      violations.push(`${rule.relativePath}: ${rule.message}`);
    }
  }

  for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    if (rootCodeExtensions.has(extension) && !allowedRootCodeFiles.has(entry.name)) {
      violations.push(`${entry.name}: source-like files belong under src/, scripts/, tools/, or local-scripts/`);
    }
  }

  const buildConfigPath = path.join(projectRoot, 'tsconfig.build.json');
  const buildConfig = JSON.parse(fs.readFileSync(buildConfigPath, 'utf8')) as {
    compilerOptions?: { allowJs?: boolean; noEmitOnError?: boolean };
  };
  if (buildConfig.compilerOptions?.allowJs !== false) {
    violations.push('tsconfig.build.json: compilerOptions.allowJs must remain false');
  }
  if (buildConfig.compilerOptions?.noEmitOnError !== true) {
    violations.push('tsconfig.build.json: compilerOptions.noEmitOnError must remain true');
  }

  const hotspots = sourceFiles
    .sort((left, right) => right.lines - left.lines)
    .slice(0, 8);
  console.log(`Architecture check: ${sourceFiles.length} production TypeScript files`);
  console.log(`Legacy compute/workflow inventory: ${countLegacyScripts('.js')} JS, ${countLegacyScripts('.py')} Python`);
  console.log('Largest production modules:');
  for (const hotspot of hotspots) {
    console.log(`- ${hotspot.lines.toString().padStart(4, ' ')} ${hotspot.path}`);
  }

  if (violations.length > 0) {
    console.error('\nArchitecture violations:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\nArchitecture constraints passed.');
  }
}

main();
