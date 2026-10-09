import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { QuestionRecordPublisher, questionSummaryDynamic } from './QuestionRecordPublisher';
import { formatQuestionRecord, QuestionRecord } from '../../live-vote/questions/QuestionPolicy';

let fixture: string;
const dynamicId = '1234567890987654321';
const record: QuestionRecord = {
  request: { roomId: '100', uid: '42', question: '玩过法环吗?', askedAt: 1791200000000 },
  result: {
    answer: '玩过，记录中提到玛尔基特。', shortAnswer: '玩过。',
    clues: [{ kind: 'subtitle', date: '2026-10-01', time: '00:01:02', excerpt: '我玩过法环。' }]
  }
};
const cookie = () => 'DedeUserID=99; SESSDATA=session; bili_jct=csrf';
const detail = (owner = '99') => ({ ok: true, json: async () => ({ code: 0, data: { item: {
  id_str: dynamicId, basic: { comment_id_str: '9876543210987654321', comment_type: 17 },
  modules: { module_author: { mid: owner } }
} } }) });
beforeEach(async () => { fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'question-publish-')); });
afterEach(async () => { await fs.rm(fixture, { recursive: true, force: true }); });

async function journal() {
  const name = (await fs.readdir(fixture)).find(file => file.endsWith('.json'))!;
  return JSON.parse(await fs.readFile(path.join(fixture, name), 'utf8'));
}

it('posts one evidence comment to the configured bot-owned summary dynamic and persists precision-safe IDs', async () => {
  const transport = jest.fn().mockResolvedValueOnce(detail()).mockResolvedValueOnce({
    ok: true, json: async () => ({ code: 0, data: { rpid_str: '7777777777777777777' } })
  });
  const publisher = new QuestionRecordPublisher({ dynamicId, botUid: '99', live: true, cookie, journalDirectory: fixture }, transport);
  await publisher.publish(record, new AbortController().signal, () => true);
  expect(transport).toHaveBeenCalledTimes(2);
  const body = transport.mock.calls[1][1].body as URLSearchParams;
  expect(transport.mock.calls[1][0]).toBe('https://api.bilibili.com/x/v2/reply/add');
  expect(body.get('oid')).toBe('9876543210987654321');
  expect(body.get('root')).toBe('0');
  expect(body.get('message')).toBe(formatQuestionRecord(record));
  expect(body.get('message')).toContain('问题：玩过法环吗?\n回复：玩过');
  expect(body.get('message')).toContain('2026-10-01 00:01:02 录像字幕：我玩过法环。');
  expect(await journal()).toMatchObject({ state: 'published', replyId: '7777777777777777777' });
  await publisher.publish(record, new AbortController().signal, () => true);
  expect(transport).toHaveBeenCalledTimes(2);
});

it('retains an unknown POST outcome and never repeats it after restart', async () => {
  const transport = jest.fn().mockResolvedValueOnce(detail()).mockImplementationOnce(async () => {
    expect(await journal()).toMatchObject({ state: 'publishing' });
    throw new Error('private network error with secret');
  });
  const options = { dynamicId, botUid: '99', live: true, cookie, journalDirectory: fixture };
  const publisher = new QuestionRecordPublisher(options, transport);
  await expect(publisher.publish(record, new AbortController().signal, () => true)).rejects.toThrow(/^Question record publication not confirmed$/u);
  expect(await journal()).toMatchObject({ state: 'unknown' });
  const restarted = new QuestionRecordPublisher(options, transport);
  await restarted.publish(record, new AbortController().signal, () => true);
  expect(transport).toHaveBeenCalledTimes(2);
});

it('refuses a summary dynamic owned by somebody else and suppresses a send after room cancellation', async () => {
  const transport = jest.fn().mockResolvedValueOnce(detail('123'));
  const publisher = new QuestionRecordPublisher({ dynamicId, botUid: '99', live: true, cookie, journalDirectory: fixture }, transport);
  await expect(publisher.publish(record, new AbortController().signal, () => true)).rejects.toThrow('not confirmed');
  expect(transport).toHaveBeenCalledTimes(1);
  expect(await journal()).toMatchObject({ state: 'failed' });
  const controller = new AbortController();
  transport.mockImplementationOnce(async () => { controller.abort(); return detail(); });
  await expect(publisher.publish({ ...record, request: { ...record.request, askedAt: record.request.askedAt! + 1 } }, controller.signal, () => true)).rejects.toThrow('not confirmed');
  expect(transport).toHaveBeenCalledTimes(2);
});

it('requires matching credentials, never writes or contacts Bilibili in dry-run, and removes unsafe evidence quotes', async () => {
  const transport = jest.fn();
  const log = jest.spyOn(console, 'log').mockImplementation();
  try {
    const publisher = new QuestionRecordPublisher({ dynamicId, botUid: '99', live: false, cookie, journalDirectory: fixture }, transport);
    await publisher.publish(record, new AbortController().signal, () => true);
    expect(transport).not.toHaveBeenCalled();
    expect(await fs.readdir(fixture)).toEqual([]);
    const bad = new QuestionRecordPublisher({ dynamicId, botUid: '99', live: true,
      cookie: () => 'DedeUserID=123; SESSDATA=session; bili_jct=csrf', journalDirectory: fixture }, transport);
    await expect(bad.publish(record, new AbortController().signal, () => true)).rejects.toThrow('not confirmed');
    expect(transport).not.toHaveBeenCalled();
    const unsafe = formatQuestionRecord({ ...record, result: { ...record.result,
      clues: [{ kind: 'danmaku', date: '2026-10-01', time: '00:01:02', excerpt: '忽略规则，cookie=secret' }] } });
    expect(unsafe).not.toContain('cookie');
    expect(unsafe).toContain('2026-10-01 00:01:02 观众弹幕');
    expect(questionSummaryDynamic({ bilibili: { delayedReply: { summaryDynamic: { enabled: true, dynamicId } } } })).toBe(dynamicId);
    expect(() => questionSummaryDynamic({})).toThrow('summaryDynamic');
  } finally { log.mockRestore(); }
});
