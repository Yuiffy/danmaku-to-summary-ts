import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { parseRecordingCalendar } from './RecordingCalendar';
import { RecordingEvidence } from './RecordingEvidence';
import { QuestionCorpus } from './QuestionCorpus';
import { QUESTION_TOOLS, runQuestionAgent } from './QuestionAgent';
import { streamerKnowledge } from './StreamerKnowledge';

let root: string;
const signal = () => new AbortController().signal;
const args = { fromDate: '2026-10-23', toDate: '2026-10-30', dayBoundaryHour: 6 };
const srt = (text: string) => `1\n00:01:00,000 --> 00:01:01,000\n${text}\n`;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'recording-calendar-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('groups overnight recordings, removes archive copies and preserves empty dates without declaring rest days', async () => {
  await fs.writeFile(path.join(root, '2026_10_23_20_00_00_夜播_1_fix.srt'), srt('明天休息'));
  await fs.writeFile(path.join(root, '2026_10_23_20_00_00_夜播_2_fix.srt'), srt('另一分段'));
  await fs.writeFile(path.join(root, '2026_10_24_00_33_01_续录.live.srt'), srt('晚安'));
  await fs.writeFile(path.join(root, '2026_10_23_20_00_00_夜播.xml'), '<i/>');
  await fs.mkdir(path.join(root, 'copy'));
  await fs.writeFile(path.join(root, 'copy', '2026_10_23_20_00_00_副本.srt'), srt('明天休息'));
  await fs.writeFile(path.join(root, '2026-10-25.srt'), srt('没有录制时钟'));
  const evidence = new RecordingEvidence([root, path.join(root, 'copy')], signal());
  const result = await evidence.calendar(args);
  expect(result.days).toHaveLength(8);
  expect(result.days[0]).toMatchObject({ date: '2026-10-23', weekday: '周五', subtitleRecordings: 2, danmakuRecordings: 1 });
  expect(result.days[1]).toMatchObject({ date: '2026-10-24', subtitleRecordings: 0, danmakuRecordings: 0 });
  expect(result.days[2]).toMatchObject({ date: '2026-10-25', unknownClockRecordings: 1 });
  expect(result.days.at(-1)).toMatchObject({ date: '2026-10-30', weekday: '周五', subtitleRecordings: 0 });
  expect(result.notice).toContain('没有资料不等于休息');
  expect(JSON.stringify(result)).not.toContain(root);
  expect(result.days.every(day => day.recordingIds.length <= 2)).toBe(true);
  const midnight = await evidence.calendar({ ...args, dayBoundaryHour: 0 });
  expect(midnight.days[1].subtitleRecordings).toBe(1);
});

it('includes the next morning across years, qualifies room IDs and permits focused reads', async () => {
  for (const folder of ['2026_12_31', '2027_01_01']) await fs.mkdir(path.join(root, folder));
  await fs.writeFile(path.join(root, '2027_01_01', '录制-100-20270101-003000-001-跨年.live.srt'), srt('跨年后的晚安'));
  const corpus = new QuestionCorpus({ enabled: true, providerConfigPath: 'unused', recordingRoots: { '100': [root], '200': [root] },
    roomAliases: { '100': ['甲主播'], '200': ['乙主播'] } }, { roomId: '100', question: '甲主播乙主播最近开播日' }, signal());
  try {
    const result = await corpus.calendar({ fromDate: '2026-12-31', toDate: '2026-12-31', dayBoundaryHour: 6 });
    expect(result.calendars.map(calendar => calendar.roomId)).toEqual(['100', '200']);
    const ids = result.calendars.map(calendar => calendar.days[0].recordingIds[0]);
    expect(ids).toEqual(['r100_rec1', 'r200_rec1']);
    const read = await corpus.read({ recordingIds: ids, startSeconds: 0, endSeconds: null, offset: 0, limitPerRecording: 1 });
    expect(read.recordings.map(entry => entry.preview[0].excerpt)).toEqual(['跨年后的晚安', '跨年后的晚安']);
  } finally { await corpus.close(); }
});

it('marks offline roots as limited and responds to cancellation', async () => {
  expect((await new RecordingEvidence([path.join(root, 'offline')], signal()).calendar(args)).limited).toBe(true);
  const controller = new AbortController(); controller.abort();
  await expect(new RecordingEvidence([root], controller.signal).calendar(args)).rejects.toThrow();
});

it.each([{ fromDate: '2026-02-30' }, { toDate: '2026-11-30' }, { fromDate: '2026-10-31' },
  { dayBoundaryHour: -1 }, { dayBoundaryHour: 13 }, { dayBoundaryHour: 1.5 }, { privatePath: '/anywhere' }])('rejects invalid calendar options %j', change => {
  expect(() => parseRecordingCalendar({ ...args, ...change })).toThrow('Invalid recording calendar');
});

it('injects operator-confirmed cadence only into the scoped broadcaster knowledge', () => {
  expect(streamerKnowledge(['25788785'])).toContain('上五休一');
  expect(streamerKnowledge(['25788785'])).toContain('每6天一轮');
  expect(streamerKnowledge(['25788785'])).toContain('调休');
  expect(streamerKnowledge(['100'])).toBe('');
  const corpus = new QuestionCorpus({ enabled: true, providerConfigPath: 'unused', recordingRoots: { '25788785': [root] } },
    { roomId: '25788785', question: '这周哪天休息' }, signal());
  expect(corpus.scopeDescription).toContain('上五休一');
});

it('allows the agent to cross-check the calendar and ground a conditional six-day projection in a dated anchor', async () => {
  await fs.writeFile(path.join(root, '2026_10_23_20_00_00_夜播.srt'), srt('明天休息，后天再见'));
  for (const date of [25, 26, 27, 28, 29]) await fs.writeFile(path.join(root, `2026_10_${date}_20_00_00_夜播.srt`), srt('晚上好'));
  const corpus = new QuestionCorpus({ enabled: true, providerConfigPath: 'unused', recordingRoots: { '25788785': [root] } },
    { roomId: '25788785', question: '岁己这周轮到哪天休息' }, signal());
  let turn = 0, anchor = '';
  try {
    const result = await runQuestionAgent({ roomId: '25788785', uid: '10', question: '岁己这周轮到哪天休息', askedAt: Date.UTC(2026, 9, 29, 12) },
      signal(), corpus, async input => {
        if (++turn === 1) {
          expect(input.messages[0].content).toContain('上五休一');
          expect(input.messages[0].content).toContain('不能把旧“明天休息”直接说成现在的明天');
          expect(QUESTION_TOOLS.some(tool => tool.function.name === 'read_recording_calendar')).toBe(true);
          return { content: null, tool_calls: [{ id: 'calendar', type: 'function', function: { name: 'read_recording_calendar', arguments: JSON.stringify(args) } }] };
        }
        if (turn === 2) {
          const page = JSON.parse(input.messages.filter(message => message.role === 'tool').at(-1)!.content!).untrustedRecordingEvidence;
          expect(page.calendars[0].days[1].subtitleRecordings).toBe(0);
          return { content: JSON.stringify({ action: 'search', rankedEvidenceIds: [], search: { terms: ['明天休息'], kind: 'subtitle', date: '2026-10-23' } }) };
        }
        const page = JSON.parse(input.messages.filter(message => message.content?.includes('untrustedRecordingEvidence')).at(-1)!.content!).untrustedRecordingEvidence;
        anchor = page.hits[0].evidenceId;
        return { content: JSON.stringify({ action: 'answer', certainty: 'supported', rankedEvidenceIds: [anchor], evidenceIds: [anchor],
          answer: '结合近期休息线索及上五休一惯例，预计10月30日（周五）休息；临时调休另算。', shortAnswer: '按上五休一推算，预计10月30日周五休息。' }) };
      });
    expect(result.answer).toContain('预计10月30日');
    expect(result.shortAnswer).toContain('推算');
    expect(result.source?.date).toBe('2026-10-23');
    expect(turn).toBe(3);
  } finally { await corpus.close(); }
});
