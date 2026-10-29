import fetch from 'node-fetch';
import { CommentApi } from './CommentApi';
import { CommentFeedError, CommentPoller } from './CommentPolling';
import { pollCommentInbox } from './CommentInbox';
import { newCommentState } from './CommentState';
import { CommentWorker } from './CommentWorker';

const cookie = 'DedeUserID=99; SESSDATA=private-session; bili_jct=private-csrf';
const response = (status: number, body: unknown) => ({ status, ok: status === 200, text: async () => JSON.stringify(body) });
const page = (items: unknown[] = []) => response(200, { code: 0, data: { items, cursor: { is_end: true } } });

test.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'])('notification GET %s recovers without pausing, moving checkpoints or duplicating publication', async code => {
  let now = Date.UTC(2026, 9, 23);
  const state = newCommentState('99'); state.feeds.reply.head = '100'; state.feeds.at.head = '100';
  const row = { id: '101', user: { mid: '10' }, at_time: now / 1000,
    item: { type: 'reply', business_id: 1, subject_id: '20', source_id: '30', root_id: '30', source_content: '你好' } };
  // reply succeeds; at fails. The next attempt replays the unchanged at checkpoint.
  const transport = jest.fn().mockResolvedValueOnce(page()).mockRejectedValueOnce(Object.assign(new Error(cookie), { code }))
    .mockResolvedValueOnce(page()).mockResolvedValueOnce(page([row]))
    .mockResolvedValue(page([row]));
  const api = new CommentApi('99', () => cookie, transport as unknown as typeof fetch);
  const answer = jest.fn(async () => '来啦'), send = jest.fn(async () => '40');
  const save = jest.fn(async () => {}), report = jest.fn();
  const worker = new CommentWorker({ botUid: '99', unlimitedUids: [], credentialConfigPath: 'unused', providerConfigPath: 'unused',
    dailyTokenBudget: 40960, maxQueue: 20, maxUserQueue: 10, pollIntervalMs: 30000 }, state,
  { now: () => now, save, answer, send });
  const poller = new CommentPoller(30000, { now: () => now, report,
    poll: () => pollCommentInbox(state, { feed: (kind, cursor) => api.feed(kind, cursor), admit: event => worker.admit(event), save }) });
  await poller.tick();
  expect(state.paused).toBe(false); expect(state.feeds.at.head).toBe('100');
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ event: 'comment_poll_retry', transportCode: code, retryInMs: 30000 }));
  expect(JSON.stringify(report.mock.calls)).not.toContain(cookie);
  now += 29999; await poller.tick(); expect(transport).toHaveBeenCalledTimes(2);
  now++; await poller.tick(); await worker.tick();
  expect(state.feeds.at.head).toBe('101'); expect(state.jobs[0].status).toBe('sent');
  expect(report).toHaveBeenLastCalledWith({ event: 'comment_poll_recovered', failures: 1 });
  now += 30000; await poller.tick(); await worker.tick();
  expect(answer).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);
});

test('repeated transient failures back off to five minutes and reset after recovery', async () => {
  let now = 0;
  const report = jest.fn(), poll = jest.fn().mockRejectedValue(new CommentFeedError(true, { feed: 'at', reason: 'http', httpStatus: 503 }));
  const poller = new CommentPoller(30000, { now: () => now, poll, report });
  for (const delay of [30000, 60000, 120000, 240000, 300000, 300000]) {
    await poller.tick(); expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ retryInMs: delay })); now += delay;
  }
  poll.mockResolvedValueOnce(undefined); await poller.tick(); now += 30000; await poller.tick();
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ failures: 1, retryInMs: 30000 }));
});

test.each([403, 412, 429, 401])('HTTP %s remains an operator pause rather than an automatic retry', async status => {
  const api = new CommentApi('99', () => cookie, jest.fn().mockResolvedValue(response(status, {})) as unknown as typeof fetch);
  const poller = new CommentPoller(30000, { now: () => 0, poll: async () => { await api.feed('at'); }, report: jest.fn() });
  await expect(poller.tick()).rejects.toMatchObject({ retryable: false, diagnostic: { reason: 'http', httpStatus: status } });
});

test.each([-101, -111, -352, -403, -412])('platform code %s is preserved without logging response text or retrying', async code => {
  const api = new CommentApi('99', () => cookie, jest.fn().mockResolvedValue(response(200, { code, message: cookie })) as unknown as typeof fetch);
  await expect(api.feed('reply')).rejects.toMatchObject({ retryable: false, diagnostic: { feed: 'reply', reason: 'platform', code } });
});

test.each([408, 500, 502, 503, 504])('HTTP %s on a notification GET can retry', async status => {
  const api = new CommentApi('99', () => cookie, jest.fn().mockResolvedValue(response(status, {})) as unknown as typeof fetch);
  await expect(api.feed('at')).rejects.toMatchObject({ retryable: true, diagnostic: { httpStatus: status } });
});

test('payload, credential, storage and unclassified failures escape the read retry loop', async () => {
  const api = new CommentApi('99', () => cookie, jest.fn().mockResolvedValue(response(200, { code: 0, data: {} })) as unknown as typeof fetch);
  await expect(api.feed('at')).rejects.toMatchObject({ retryable: false, diagnostic: { reason: 'payload' } });
  const wrongAccount = new CommentApi('1', () => cookie, jest.fn() as unknown as typeof fetch);
  await expect(wrongAccount.feed('at')).rejects.toThrow('mismatch');
  for (const error of [new Error('disk full'), new Error('unclassified transport failure')]) {
    const poller = new CommentPoller(30000, { now: () => 0, poll: async () => { throw error; }, report: jest.fn() });
    await expect(poller.tick()).rejects.toBe(error);
  }
});

test.each([
  ['items', { code: 0, data: { items: null, cursor: { is_end: true } } }, { itemsType: 'null' }],
  ['cursor', { code: 0, data: { items: [], cursor: { is_end: 'false' } } }, { endType: 'string' }],
  ['pagination', { code: 0, data: { items: [], cursor: { is_end: false, id: 1, time: '123' } } }, { timeType: 'string' }]
])('payload diagnosis identifies %s without retaining notification contents', async (payloadStage, body, shape) => {
  const raw = JSON.stringify({ ...body as object, message: cookie });
  const transport = jest.fn().mockResolvedValue({ status: 200, ok: true, headers: { get: () => 'application/json; charset=utf-8' }, text: async () => raw });
  const api = new CommentApi('99', () => cookie, transport as unknown as typeof fetch);
  try { await api.feed('reply'); throw new Error('must fail'); }
  catch (error) {
    expect(error).toBeInstanceOf(CommentFeedError);
    const diagnostic = (error as CommentFeedError).diagnostic;
    expect(diagnostic).toMatchObject({ httpStatus: 200, contentType: 'json', payloadStage, bodyFormat: 'json',
      bodyBytes: Buffer.byteLength(raw), bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/u), ...shape as object });
    expect(JSON.stringify(diagnostic)).not.toContain(cookie);
  }
});

test('HTTP 200 HTML is distinguished from explicit HTTP frequency control without logging the page', async () => {
  const html = `<html>private notification ${cookie}</html>`;
  const transport = jest.fn().mockResolvedValue({ status: 200, ok: true, headers: { get: () => 'text/html' }, text: async () => html });
  const api = new CommentApi('99', () => cookie, transport as unknown as typeof fetch);
  try { await api.feed('at'); throw new Error('must fail'); }
  catch (error) {
    expect((error as CommentFeedError).diagnostic).toMatchObject({ payloadStage: 'json', httpStatus: 200,
      contentType: 'html', bodyFormat: 'html', bodyBytes: Buffer.byteLength(html) });
    expect(JSON.stringify((error as CommentFeedError).diagnostic)).not.toMatch(/SESSDATA|private/u);
  }
});
