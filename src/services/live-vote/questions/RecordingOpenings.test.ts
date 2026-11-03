import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { RecordingEvidence } from './RecordingEvidence';
import { QuestionCorpus } from './QuestionCorpus';
import { parseReadOpenings } from './RecordingOpenings';
import { aggregateEvidence } from './QuestionTools';
import { runQuestionAgent } from './QuestionAgent';

let root: string;
const args = (overrides = {}) => ({ fromDate: '2026-10-01', toDate: '2026-10-07', offset: 0, limit: 7, endSeconds: 900, cuesPerRecording: 48, ...overrides });
const cue = (seconds: number, text: string) => {
  const time = `00:${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return `1\n${time},000 --> ${time},999\n${text}\n`;
};
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-openings-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('reads seven dated openings with timed citations, then continues beyond the former 512-ID budget and calculates statistics', async () => {
  for (let day = 1; day <= 7; day++) await fs.writeFile(path.join(root, `2026_10_0${day}_20_00_00_聊天_1_fix.srt`),
    Array.from({ length: 90 }, (_, index) => cue(index * 10 + day * 5, index === 70 ? '大家晚上好，能听到吗' : '歌曲片段')).join('\n'));
  const signal = new AbortController().signal, evidence = new RecordingEvidence([root], signal);
  const first = await evidence.openings(args());
  expect(first.recordings).toHaveLength(7);
  expect(first.recordings.flatMap(entry => entry.preview)).toHaveLength(336);
  expect(first.recordings.every(entry => entry.nextCueOffset === 48)).toBe(true);
  expect(first.recordings[0].recordingStartedAt).toBe('2026-10-07T20:00:00+08:00');
  expect(first.coverage[0].datesWithoutSubtitles).toEqual([]);
  const next = await evidence.read({ recordingIds: first.recordings.map(entry => entry.recordingId), startSeconds: 0,
    endSeconds: 900, offset: 48, limitPerRecording: 32 });
  expect(next.recordings.flatMap(entry => entry.preview)).toHaveLength(224);
  const ids = next.recordings.map(entry => entry.preview.find(hit => hit.excerpt.includes('晚上好'))!.evidenceId);
  const stats = aggregateEvidence({ evidenceIds: ids, groupBy: 'all' }, id => evidence.citation(id)) as { groups: unknown[] };
  expect(stats.groups[0]).toMatchObject({ count: 7, meanSeconds: 720, minSeconds: 705, maxSeconds: 735 });
  expect(ids.every(id => evidence.clue(id)?.excerpt.includes('晚上好'))).toBe(true);
});

it('covers a cross-month range, deduplicates copies/parts, pages directories and preserves missing subtitle dates', async () => {
  const mirror = path.join(root, 'mirror'); await fs.mkdir(mirror);
  await fs.writeFile(path.join(root, '2026_09_30_20_00_00_聊天_1_fix.srt'), cue(300, '晚上好'));
  await fs.writeFile(path.join(root, '2026_09_30_20_00_00_聊天_2_fix.srt'), cue(1, '中途分段'));
  await fs.writeFile(path.join(mirror, '录制-100-20260930-200000-聊天.live.srt'), cue(1, '重复副本'));
  await fs.writeFile(path.join(root, '2026_10_02_20_00_00_聊天_1_fix.srt'), cue(420, '晚上好'));
  await fs.writeFile(path.join(root, '2026_09_29_20_00_00_聊天_1_fix.srt'), cue(60, '范围外'));
  const evidence = new RecordingEvidence([root, mirror], new AbortController().signal);
  const query = args({ fromDate: '2026-09-30', toDate: '2026-10-02', limit: 1 });
  const first = await evidence.openings(query), next = await evidence.openings({ ...query, offset: first.nextOffset });
  expect(first.total).toBe(2); expect(first.nextOffset).toBe(1); expect(first.limited).toBe(true);
  expect(next.nextOffset).toBeNull(); expect(next.recordings[0].preview[0].time).toBe('00:05:00');
  expect(first.coverage[0].datesWithoutSubtitles).toEqual(['2026-10-01']);
  expect(JSON.stringify([first, next])).not.toContain('范围外');
  expect(JSON.stringify([first, next])).not.toContain('重复副本');
  expect(JSON.stringify([first, next])).not.toContain(root);
  const cancelled = new AbortController(); cancelled.abort();
  await expect(new RecordingEvidence([root], cancelled.signal).openings(query)).rejects.toThrow();
});

it('reads across dates before a day with many recording fragments can crowd out older days', async () => {
  for (let day = 1; day <= 7; day++) await fs.writeFile(path.join(root, `2026_10_0${day}_20_00_00_聊天_1_fix.srt`), cue(300, '开场问候'));
  for (let hour = 0; hour < 8; hour++) await fs.writeFile(path.join(root, `2026_10_07_0${hour}_00_00_续录_1_fix.srt`), cue(1, '续录片段'));
  const evidence = new RecordingEvidence([root], new AbortController().signal);
  const page = await evidence.openings(args());
  expect(page.total).toBe(15); expect(page.nextOffset).toBe(7);
  expect(page.recordings.map(entry => entry.date)).toEqual(['2026-10-07', '2026-10-06', '2026-10-05', '2026-10-04', '2026-10-03', '2026-10-02', '2026-10-01']);
  const next = await evidence.openings(args({ offset: page.nextOffset }));
  expect(next.recordings.every(entry => entry.date === '2026-10-07')).toBe(true);
});

it('qualifies opening IDs and coverage per authorized room and lets the agent compose batch reads with arithmetic', async () => {
  for (let day = 1; day <= 3; day++) await fs.writeFile(path.join(root, `2026_10_0${day}_20_00_00_聊天_1_fix.srt`), cue(day * 60, '大家晚上好'));
  const signal = new AbortController().signal;
  const corpus = new QuestionCorpus({ enabled: true, providerConfigPath: 'unused', recordingRoots: { '100': [root] } },
    { roomId: '100', question: '统计近7天开场时间' }, signal);
  let calls = 0;
  const result = await runQuestionAgent({ roomId: '100', uid: '1', question: '统计近7天开场时间' }, signal, corpus, async input => {
    if (++calls === 1) return { content: null, tool_calls: [{ id: 'opening', type: 'function', function: {
      name: 'read_recording_openings', arguments: JSON.stringify(args()) } }] };
    const data = JSON.parse(input.messages.filter(message => message.content?.includes('untrustedRecordingEvidence')).at(-1)!.content!).untrustedRecordingEvidence;
    if (calls === 2) {
      expect(data.coverage[0]).toMatchObject({ roomId: '100', startSeconds: 0, endSeconds: 900 });
      const ids = data.recordings.map((entry: { preview: { evidenceId: string }[] }) => entry.preview[0].evidenceId);
      expect(ids.every((id: string) => id.startsWith('r100_'))).toBe(true);
      return { content: JSON.stringify({ action: 'tool', rankedEvidenceIds: ids, tool: { name: 'aggregate_evidence', arguments: { evidenceIds: ids, groupBy: 'all' } } }) };
    }
    expect(data.groups[0]).toMatchObject({ count: 3, meanSeconds: 120 });
    const ids = data.groups[0].evidenceIds;
    return { content: JSON.stringify({ action: 'answer', certainty: 'supported', rankedEvidenceIds: ids, evidenceIds: ids,
      answer: '已核实3场，按录制起点估算平均2分钟；其余日期未取得字幕，不能视为完整7天统计。', shortAnswer: '已查3场均约2分钟，统计不全。' }) };
  });
  expect(calls).toBe(3); expect(result.clues).toHaveLength(3);
  await expect(corpus.read({ recordingIds: ['r200_rec1'], startSeconds: 0, endSeconds: 900, offset: 0, limitPerRecording: 1 })).rejects.toThrow();
  await corpus.close();
});

it.each([
  { fromDate: '2026-02-30' }, { fromDate: '2026-10-08' }, { toDate: '2026-11-01' },
  { limit: 9 }, { limit: 8, cuesPerRecording: 80 }, { endSeconds: 3601 }, { offset: -1 }, { path: 'private.srt' }
])('rejects invalid, unbounded or path-bearing opening requests: %j', overrides => {
  expect(() => parseReadOpenings(args(overrides))).toThrow();
});
