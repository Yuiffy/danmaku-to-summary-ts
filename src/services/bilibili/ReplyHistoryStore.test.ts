import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReplyHistoryStore } from './ReplyHistoryStore';
import { ReplyHistory } from './interfaces/types';

describe('reply history migration', () => {
  let directory: string;
  let projectRoot: string;
  let legacy: string;
  let target: string;
  const record = (id: string, success = true, time = '2026-09-01T12:00:00.000Z'): ReplyHistory => ({
    dynamicId: id, uid: 'owner', replyTime: new Date(time), success, contentSummary: 'reply'
  });
  const create = () => new ReplyHistoryStore({ projectRoot, legacyPaths: [legacy] });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-history-'));
    projectRoot = path.join(directory, 'project');
    legacy = path.join(directory, 'data', 'reply_history.json');
    target = path.join(projectRoot, 'data', 'reply_history.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('preserves every legacy identity, backups and restored Date values', async () => {
    const original = JSON.stringify([record('1234567890123456789'), record('second', false)], null, 2);
    fs.writeFileSync(legacy, original);
    const store = create();
    await store.initialize();
    expect(await store.hasReplied('1234567890123456789')).toBe(true);
    expect(await store.hasReplied('second')).toBe(true);
    expect((await store.getReplyHistory('owner')).every(item => item.replyTime instanceof Date)).toBe(true);
    expect(fs.readFileSync(legacy, 'utf8')).toBe(original);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual(JSON.parse(original));
    const backups = fs.readdirSync(path.join(projectRoot, 'data/runtime/reply-history-migration'));
    expect(backups).toHaveLength(1);
    const restarted = create();
    await restarted.initialize();
    expect(await restarted.getReplyHistory('owner')).toHaveLength(2);
  });

  it('merges both stores and preserves a successful reply over a later failure', async () => {
    fs.writeFileSync(target, JSON.stringify([record('shared'), record('new')]));
    fs.writeFileSync(legacy, JSON.stringify([record('shared', false, '2026-09-02T12:00:00.000Z'), record('old')]));
    const store = create();
    await store.initialize();
    expect(await store.getReplyHistory('owner')).toHaveLength(3);
    expect((await store.getReplyHistory('owner')).find(item => item.dynamicId === 'shared')?.success).toBe(true);
  });

  it('does not resurrect unchanged imported records after intentional cleanup', async () => {
    fs.writeFileSync(legacy, JSON.stringify([record('old', true, '2000-01-01T00:00:00.000Z')]));
    const store = create();
    await store.initialize();
    await store.cleanupOldHistory(1);
    const restarted = create();
    await restarted.initialize();
    expect(await restarted.hasReplied('old')).toBe(false);
  });

  it('imports newly written legacy records after a rollback and re-deployment', async () => {
    fs.writeFileSync(legacy, JSON.stringify([record('old')]));
    await create().initialize();
    fs.writeFileSync(legacy, JSON.stringify([record('old'), record('rollback-reply')]));
    const restarted = create();
    await restarted.initialize();
    expect(await restarted.hasReplied('rollback-reply')).toBe(true);
  });

  it('refuses corrupt legacy data without replacing an existing valid store', async () => {
    const original = JSON.stringify([record('current')]);
    fs.writeFileSync(target, original);
    fs.writeFileSync(legacy, 'not json');
    await expect(create().initialize()).rejects.toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe(original);
  });
});
