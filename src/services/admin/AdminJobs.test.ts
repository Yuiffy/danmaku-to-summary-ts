import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AdminJobs, createCommandRunner } from './AdminJobs';
import { atomicJson, readJson } from './AdminFiles';

it('executes cancellation immediately while an earlier media operation is still running', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-cancel-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const jobs = new AdminJobs(directory, async command => {
    started.push(command.action);
    if (command.action === 'cut') await gate;
    return 0;
  });
  try {
    jobs.submit({ executable: 'python', args: [], action: 'cut', target: '2' });
    await Promise.resolve();
    jobs.submit({ executable: 'python', args: [], action: 'enqueue', target: '2' });
    jobs.submit({ executable: 'python', args: [], action: 'cancel-upload', target: '1' });
    await Promise.resolve();
    expect(started).toEqual(['cut', 'cancel-upload']);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(jobs.latest('cancel-upload', '1')?.status).toBe('succeeded');
    release(); await jobs.flush();
    expect(started).toEqual(['cut', 'cancel-upload', 'enqueue']);
  } finally { release(); await jobs.flush(); fs.rmSync(directory, { recursive: true, force: true }); }
});

it('accepts 200 unfinished operations in order, rejects overflow without saving it, and frees capacity after failure', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-capacity-'));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const jobs = new AdminJobs(directory, async command => {
    started.push(command.target);
    await gate;
    if (command.target === '0') throw new Error('fixture failure');
    return 0;
  });
  const submit = (target: string) => jobs.submit({ executable: 'node', args: [], action: 'fixture', target });
  try {
    const first = submit('0');
    await Promise.resolve();
    expect(jobs.latest('fixture', '0')?.status).toBe('running');
    for (let index = 1; index < 200; index++) submit(String(index));
    expect(started).toEqual(['0']);
    expect(() => submit('overflow')).toThrow('管理操作队列已满');
    expect(jobs.latest('fixture', 'overflow')).toBeUndefined();
    expect(fs.readdirSync(directory)).toHaveLength(200);
    release();
    await jobs.flush();
    expect(started).toEqual(Array.from({ length: 200 }, (_, index) => String(index)));
    expect(readJson(path.join(directory, `${first.id}.json`)).status).toBe('failed');
    expect(jobs.latest('fixture', '199')?.status).toBe('succeeded');
    submit('after-completion');
    await jobs.flush();
    expect(jobs.latest('fixture', 'after-completion')?.status).toBe('succeeded');
  } finally {
    release();
    await jobs.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

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
