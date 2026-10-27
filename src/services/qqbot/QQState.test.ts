import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { newQQState, QQStateStore } from './QQState';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-state-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const file = () => path.join(directory, 'state.json');
test('exclusive ownership and receipt recovery prevent repeating ambiguous sends', async () => {
  const store = new QQStateStore(file(), '900000001');
  const state = await store.open();
  await expect(new QQStateStore(file(), '900000001').open()).rejects.toThrow();
  state.receipts['a'.repeat(64)] = { at: Date.now(), status: 'sending' };
  await store.save(state); await store.close();
  const reopened = new QQStateStore(file(), '900000001');
  try {
    const recovered = await reopened.open();
    expect(recovered.paused).toBe(true); expect(recovered.receipts['a'.repeat(64)].status).toBe('unknown');
  } finally { await reopened.close(); }
});
test('interrupted generation is skipped and its budget is preserved', async () => {
  const state = newQQState('900000001'); state.tokens = 4096;
  state.receipts['b'.repeat(64)] = { at: Date.now(), status: 'generating' };
  await fs.writeFile(file(), JSON.stringify(state));
  const store = new QQStateStore(file(), '900000001');
  try {
    const recovered = await store.open();
    expect(recovered.tokens).toBe(4096); expect(recovered.receipts['b'.repeat(64)].status).toBe('skipped');
  } finally { await store.close(); }
});
test('malformed and wrong-account state cannot reset dedupe or budgets', async () => {
  await fs.writeFile(file(), 'broken');
  await expect(new QQStateStore(file(), '900000001').open()).rejects.toThrow();
  await fs.writeFile(file(), JSON.stringify(newQQState('another-account')));
  await expect(new QQStateStore(file(), '900000001').open()).rejects.toThrow();
});
