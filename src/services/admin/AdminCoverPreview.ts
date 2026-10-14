import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { CoverSelection } from '../../core/admin/contracts';
import { AdminError } from './AdminFiles';

type Run = (executable: string, args: string[]) => Promise<void>;
const runProcess: Run = (executable, args) => new Promise((resolve, reject) => {
  execFile(executable, args, { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }, error => {
    if (error) reject(new AdminError('封面预览失败，请检查画面时间或精简封面文字', 422));
    else resolve();
  });
});

/** Disposable rendered previews, with no registry, review or queue writes. */
export class AdminCoverPreview {
  private busy = false;
  constructor(private readonly root: string, private readonly python = 'python', private readonly run: Run = runProcess) {}
  async render(media: string, selection: CoverSelection): Promise<Buffer> {
    if (this.busy) throw new AdminError('另一张封面正在预览，请稍后重试', 429);
    this.busy = true;
    const directory = path.join(this.root, 'data/runtime/admin/cover-previews', randomUUID());
    try {
      fs.mkdirSync(directory, { recursive: true });
      const output = path.join(directory, 'cover.jpg');
      await this.run(this.python, [path.join(this.root, 'src/scripts/cover_generator.py'), media,
        '--title', selection.text, '--output', output, '--frame-time', String(selection.time),
        ...(selection.crop ? ['--crop', JSON.stringify(selection.crop)] : [])]);
      return fs.readFileSync(output);
    } finally { fs.rmSync(directory, { force: true, recursive: true }); this.busy = false; }
  }
}
