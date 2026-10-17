import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildWorkflowRelease } from './buildWorkflowRelease';

test('repeat builds and failed builds clean their staging files without activating or damaging a candidate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-builder-'));
  try {
    const entries = ['clipping/radioDanmaku', 'clipping/speakerIdentity', 'clipping/stage', 'clipping/editPlan', 'clipping/enhancement', 'clipping/experiment',
      'clipping/activityStages', 'clipping/activityRecovery', 'clipping/activityWatchContext', 'clipping/activityAudio', 'clipping/activityTitles', 'clipping/activityPublication', 'clipping/ownTimingRecovery',
      'clipping/watchBlackPolicy', 'clipping/watchBlackRuntime', 'clipping/watchMovieCadence', 'clipping/songResearchRuntime', 'clipping/activityNativeSegments', 'clipping/watchPublicNames',
      'clipping/reviewDigest', 'clipping/reviewSelectionHistory', 'clipping/ownSourceReview',
      'clipping/ownPublicationRepair', 'clipping/ownBoundaryRepair', 'clipping/ownRequiredReview', 'clipping/subtitleWindowEvidence', 'clipping/ownPublicationRecheck',
      'clipping/ownSubtitleRepairRuntime',
      'clipping/gameOpening', 'clipping/gameEditorial', 'clipping/publicationReview', 'clipping/publicationRuntime', 'clipping/topicRecovery',
      'clipping/topicPublicationRepair',
      'clipping/quantityEvidence', 'clipping/preflightEnding',
      'ai/usage', 'text/response', 'text/requests', 'summary/diagnostics'].map(name => `workflows/${name}`);
    entries.push('core/config/ConfigLayers');
    for (const entry of entries) {
      const file = path.join(root, 'src', `${entry}.ts`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'export const fixture: number = 1;\n');
    }
    fs.writeFileSync(path.join(root, 'tsconfig.workflows.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'commonjs', rootDir: 'src',
        strict: true, noEmitOnError: true, types: [], skipLibCheck: true },
      include: ['src/**/*.ts']
    }));
    const pointer = path.join(root, 'data/runtime/workflow-release.json');
    fs.mkdirSync(path.dirname(pointer), { recursive: true });
    fs.writeFileSync(pointer, '{"releaseDir":"previous-live-release"}\n');
    const live = fs.readFileSync(pointer, 'utf8');
    const release = buildWorkflowRelease(root);
    const candidate = fs.readFileSync(path.join(root, 'build/workflow-candidate.json'), 'utf8');
    const manifest = fs.readFileSync(path.join(release, 'manifest.json'), 'utf8');
    expect(buildWorkflowRelease(root)).toBe(release);
    expect(fs.readdirSync(path.join(root, 'build/workflow-staging'))).toEqual([]);
    fs.writeFileSync(path.join(root, 'src/workflows/text/response.ts'), 'export const fixture: number = "invalid";');
    expect(() => buildWorkflowRelease(root)).toThrow();
    expect(fs.readdirSync(path.join(root, 'build/workflow-staging'))).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'build/workflow-candidate.json'), 'utf8')).toBe(candidate);
    expect(fs.readFileSync(path.join(release, 'manifest.json'), 'utf8')).toBe(manifest);
    expect(fs.readFileSync(pointer, 'utf8')).toBe(live);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30000);
