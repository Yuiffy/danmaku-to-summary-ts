import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import * as ts from 'typescript';

const entries = {
  'clipping/stage': 'workflows/clipping/stage.js',
  'clipping/editPlan': 'workflows/clipping/editPlan.js',
  'clipping/enhancement': 'workflows/clipping/enhancement.js',
  'text/response': 'workflows/text/response.js',
  'text/requests': 'workflows/text/requests.js',
  'summary/diagnostics': 'workflows/summary/diagnostics.js',
  'config/layers': 'core/config/ConfigLayers.js'
};

function filesUnder(directory: string, relative = ''): string[] {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
      ? filesUnder(directory, path.posix.join(relative, entry.name))
      : [path.posix.join(relative, entry.name)])
    .sort();
}

function writeJsonAtomically(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(`${file}.tmp`, file);
}

/** Build an immutable release; activation is a separate explicit operation. */
export function buildWorkflowRelease(root = process.cwd(), activate = false): string {
  const stagingRoot = path.join(root, 'build', 'workflow-staging');
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stage = fs.mkdtempSync(path.join(stagingRoot, 'candidate-'));
  const configFile = ts.readConfigFile(path.join(root, 'tsconfig.workflows.json'), ts.sys.readFile);
  if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
  const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, {
    outDir: stage, incremental: false
  });
  const program = ts.createProgram(config.fileNames, config.options);
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root,
    getCanonicalFileName: file => file,
    getNewLine: () => '\n'
  }));
  const result = program.emit();
  if (result.emitSkipped) throw new Error('Workflow compilation did not emit a complete release');
  const files = Object.fromEntries(filesUnder(stage).map(file => [file,
    createHash('sha256').update(fs.readFileSync(path.join(stage, file))).digest('hex')
  ]));
  for (const entry of Object.values(entries)) {
    if (!files[entry]) throw new Error(`Missing workflow entry: ${entry}`);
  }
  const version = createHash('sha256').update(JSON.stringify({ entries, files })).digest('hex').slice(0, 20);
  const manifest = { schemaVersion: 1, version, entries, files };
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const releaseDir = path.join(root, 'build', 'workflow-releases', version);
  fs.mkdirSync(path.dirname(releaseDir), { recursive: true });
  if (!fs.existsSync(releaseDir)) fs.renameSync(stage, releaseDir);
  const descriptor = { releaseDir, version };
  writeJsonAtomically(path.join(root, 'build', 'workflow-candidate.json'), descriptor);
  if (activate) writeJsonAtomically(path.join(root, 'data', 'runtime', 'workflow-release.json'), descriptor);
  return releaseDir;
}

if (require.main === module) {
  const releaseDir = buildWorkflowRelease(process.cwd(), process.argv.includes('--activate'));
  console.log(JSON.stringify({ releaseDir, activated: process.argv.includes('--activate') }));
}
