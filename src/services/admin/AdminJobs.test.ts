import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCommandRunner } from './AdminJobs';
import { atomicJson, readJson } from './AdminFiles';

it('applies manual publication and silent notifications only to the draft child, then removes its temporary config', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-command-'));
  const before = process.env.CONFIG_PATH;
  delete process.env.CONFIG_PATH;
  const file = path.join(root, 'config/production.json');
  const original = { streamActivityClips: { enabled: true, automaticPublication: { mode: 'auto', roomIds: ['100'] }, notify: { enabled: true } }, streamGameClips: { autoUpload: true, authorizationNote: '配置中的旧授权', notify: { enabled: true } } };
  atomicJson(file, original);
  let output = '';
  try {
    const code = await createCommandRunner(root)({ executable: 'node', args: ['-e', 'process.stdout.write(require("fs").readFileSync(process.env.CONFIG_PATH, "utf8"))'], action: 'activity-run', target: 'fixture', reviewOnly: true }, chunk => { output += chunk; });
    expect(code).toBe(0);
    const child = JSON.parse(output);
    expect(child.streamActivityClips.automaticPublication).toEqual({ mode: 'off', roomIds: ['100'] });
    expect(child.streamActivityClips.notify.enabled).toBe(false); expect(child.streamGameClips.notify.enabled).toBe(false);
    expect(child.streamGameClips.autoUpload).toBe(false); expect(child.streamGameClips.authorizationNote).toBe('');
    expect(readJson(file)).toEqual(original);
    expect(fs.readdirSync(path.join(root, 'data/runtime/admin/command-configs'))).toEqual([]);
  } finally {
    if (before === undefined) delete process.env.CONFIG_PATH; else process.env.CONFIG_PATH = before;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
