import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecordingEvidence } from './RecordingEvidence';
import { QuestionCorpus } from './QuestionCorpus';

let root: string;
const now = Date.parse('2026-10-18T00:03:00+08:00');
const signal = () => new AbortController().signal;
beforeEach(async () => { jest.useFakeTimers().setSystemTime(now); root = await fs.mkdtemp(path.join(os.tmpdir(), 'recent-recording-')); });
afterEach(async () => { jest.useRealTimers(); await fs.rm(root, { recursive: true, force: true }); });

async function recording(room = '100') {
  const base = path.join(root, `录制-${room}-20261017-235300-123-title`);
  await fs.writeFile(base + '.flv', 'media');
  await fs.utimes(base + '.flv', new Date(now), new Date(now));
  await fs.writeFile(base + '.live.srt', '1\n00:01:00,000 --> 00:01:02,000\n过早的内容\n\n2\n00:07:00,000 --> 00:07:02,000\n刚才唱歌\n');
  await fs.writeFile(base + '.xml', '<i><d p="550,1,25,1,1,0,22">观众说好听</d><d p="551,1,25,1,1,0,99">机器人回复</d></i>');
  return base;
}

it('anchors recent minutes to the active recording across midnight and keeps room/kind attribution', async () => {
  await recording(); await recording('200');
  const config = { enabled: true, providerConfigPath: path.join(root, 'provider.json'), recordingRoots: { '100': [root] } };
  const corpus = new QuestionCorpus(config, { roomId: '100', question: '总结最近5分钟', askedAt: now }, signal(), '99');
  const result = await corpus.recent({ minutes: 5 });
  expect(result.hits.map(hit => hit.excerpt)).toEqual(['刚才唱歌', '观众说好听']);
  expect(result.hits.every(hit => hit.roomId === '100')).toBe(true);
  expect(result.coverage).toEqual([expect.objectContaining({ roomId: '100', subtitleLagS: 180, window: expect.objectContaining({ from: 300, to: 600 }) })]);
  expect(corpus.clue(result.hits[0].evidenceId)).toMatchObject({ kind: 'subtitle', excerpt: '刚才唱歌' });
  expect(corpus.context({ evidenceId: result.hits[1].evidenceId })).toMatchObject({ hit: { kind: 'danmaku' } });
});

it('does not substitute old subtitles for current audio, refuses extra arguments and honors cancellation', async () => {
  const base = await recording();
  // The model can take time to plan while the recording continues to grow.
  jest.setSystemTime(now + 20000);
  await fs.utimes(base + '.flv', new Date(now + 20000), new Date(now + 20000));
  await fs.writeFile(base + '.live.srt', '1\n00:01:00,000 --> 00:01:02,000\n旧内容\n');
  const controller = new AbortController();
  const evidence = new RecordingEvidence([root], controller.signal, { roomId: '100', askedAt: now });
  const result = await evidence.recent({ minutes: 5 });
  expect(result.hits.every(hit => hit.kind === 'danmaku')).toBe(true);
  expect(result.subtitleLagS).toBe(540);
  await expect(evidence.recent({ minutes: 5, path: root })).rejects.toThrow();
  await expect(evidence.recent({ minutes: 60 })).rejects.toThrow();
  controller.abort();
  await expect(evidence.recent({ minutes: 5 })).rejects.toThrow('cancelled');
});

it('reports no active recording instead of reading a completed stream as live', async () => {
  const base = await recording();
  await fs.utimes(base + '.flv', new Date(now - 120000), new Date(now - 120000));
  const result = await new RecordingEvidence([root], signal(), { roomId: '100', askedAt: now }).recent({ minutes: 10 });
  expect(result).toMatchObject({ hits: [], limited: true, status: 'no_active_recording' });
});
