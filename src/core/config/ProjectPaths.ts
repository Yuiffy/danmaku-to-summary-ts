import * as fs from 'fs';
import * as path from 'path';

/** Resolve from module location, so compiled depth and caller cwd cannot move state. */
export function getProjectRoot(start = __dirname): string {
  if (process.env.DANMAKU_PROJECT_ROOT) return path.resolve(process.env.DANMAKU_PROJECT_ROOT);
  let current = path.resolve(start);
  while (true) {
    const manifest = path.join(current, 'package.json');
    if (fs.existsSync(manifest)) {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''));
      if (pkg.name === 'danmaku-to-summary-ts') return current;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot locate project root from ${start}`);
    current = parent;
  }
}
