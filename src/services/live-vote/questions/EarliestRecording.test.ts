import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecordingEvidence } from './RecordingEvidence';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'earliest-recording-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const question = '躺在床上莫名又会想最早是谁发的';
const args = { terms: ['躺在床上莫名又会想'], kind: 'danmaku', date: null };
const sc = (name: string, at: string, ts: number) => `<i><BililiveRecorderRecordInfo start_time="${at}" />` +
  `<sc ts="${ts}" user="${name}" uid="123">躺在床上莫名又会想</sc></i>`;

it('searches beyond 250 older files and 64 MiB without retaining unrelated XML snapshots', async () => {
  const old = path.join(root, '2026_06_17');
  await fs.mkdir(old);
  for (let i = 0; i < 260; i++) {
    const file = path.join(old, `${i}.xml`);
    await fs.writeFile(file, '<i></i>');
    if (i < 9) await fs.truncate(file, 8 * 1024 * 1024);
  }
  await fs.writeFile(path.join(old, 'z_hit.xml'), sc('原作者', '2026-06-17T22:00:00+08:00', 1));
  const evidence = new RecordingEvidence([root], new AbortController().signal, { question });
  const result = await evidence.search(args);
  expect(result.hits[0]).toMatchObject({ date: '2026-06-17', senderName: '原作者' });
  expect(evidence.context({ evidenceId: result.hits[0].evidenceId })).toMatchObject({ hit: { senderUid: '123' } });
}, 15000);

it('does not let hundreds of newer files hide an early record, and stops before reading them', async () => {
  const old = path.join(root, '2026_06_17'), recent = path.join(root, '2026_10_01');
  await fs.mkdir(old); await fs.mkdir(recent);
  await fs.writeFile(path.join(old, 'hit.xml'), sc('原作者', '2026-06-17T22:00:00+08:00', 1));
  for (let i = 0; i < 260; i++) await fs.writeFile(path.join(recent, `${i}.xml`), sc('复读', '2026-10-01T22:00:00+08:00', 1));
  const open = jest.spyOn(require('fs/promises'), 'open');
  try {
    const result = await new RecordingEvidence([root], new AbortController().signal, { question }).search(args);
    expect(result.hits[0]).toMatchObject({ date: '2026-06-17', senderName: '原作者' });
    expect(open.mock.calls.some(call => String(call[0]).includes('2026_10_01'))).toBe(false);
  } finally { open.mockRestore(); }
});

it('compares all sessions across roots and the next day when a recording crosses midnight', async () => {
  const a = path.join(root, '2026_06_17'), b = path.join(root, '2026_06_18');
  await fs.mkdir(a); await fs.mkdir(b);
  await fs.writeFile(path.join(a, 'a.xml'), sc('过午夜', '2026-06-17T23:00:00+08:00', 7200));
  await fs.writeFile(path.join(b, 'b.xml'), sc('更早', '2026-06-18T00:00:00+08:00', 60));
  const other = path.join(root, 'other'); await fs.mkdir(other); await fs.mkdir(path.join(other, '2026_06_18'));
  await fs.writeFile(path.join(other, '2026_06_18', 'c.xml'), sc('同日更早', '2026-06-18T00:00:00+08:00', 10));
  const result = await new RecordingEvidence([root, other], new AbortController().signal, { question }).search(args);
  expect(result.hits[0]).toMatchObject({ senderName: '同日更早', sentAt: '2026-06-18T00:00:10.000+08:00' });
});

it('does not stop on a weak match for only one of several search concepts', async () => {
  const old = path.join(root, '2026_01_01'), found = path.join(root, '2026_06_17');
  await fs.mkdir(old); await fs.mkdir(found);
  await fs.writeFile(path.join(old, 'weak.xml'), '<i><sc ts="1">躺在床上</sc></i>');
  await fs.writeFile(path.join(found, 'hit.xml'), sc('原作者', '2026-06-17T22:00:00+08:00', 1));
  const result = await new RecordingEvidence([root], new AbortController().signal, { question })
    .search({ ...args, terms: ['躺在床上', '莫名又会想'] });
  expect(result.hits.some(hit => hit.senderName === '原作者')).toBe(true);
});
