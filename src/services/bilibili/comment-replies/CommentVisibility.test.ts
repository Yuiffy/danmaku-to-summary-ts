import fetch from 'node-fetch';
import { inspectCommentVisibility } from './CommentVisibility';
import { parseInspectCommentArgs } from '../../../tools/bilibili/inspectComment';

const target = { oid: '123', type: 1, root: '456', replyId: '789' };
const reply = (id = target.replyId) => ({ rpid_str: id, root_str: target.root, member: { mid: '99' }, state: 0, attr: 0 });
const response = (replies: any[], count = replies.length) => ({ ok: true, status: 200,
  text: async () => JSON.stringify({ code: 0, data: { root: { rpid_str: target.root }, page: { count }, replies } }) });
const transportOf = (mock: jest.Mock) => mock as unknown as typeof fetch;

test('contrasts anonymous and account reads without treating an authenticated receipt as public visibility', async () => {
  const cookie = 'SESSDATA=private-session; DedeUserID=99';
  const transport = jest.fn(async (_url, options) => response(options.headers.Cookie ?
    [{ ...reply(), state: 17, attr: 6422528, content: { message: 'private content' } }] : []));
  const result = await inspectCommentVisibility(target, { cookie, transport: transportOf(transport) });
  expect(result.anonymous.status).toBe('not-returned');
  expect(result.authenticated).toMatchObject({ status: 'visible', reply: { state: 17, attr: 6422528 } });
  expect(JSON.stringify(result)).not.toMatch(/private-session|private content/);
  expect(transport.mock.calls.filter(([, options]) => options.headers.Cookie)).toHaveLength(1);
  expect(transport.mock.calls.filter(([, options]) => !options.headers.Cookie)).toHaveLength(1);
  for (const [url, options] of transport.mock.calls) {
    expect(url).toMatch(/^https:\/\/api\.bilibili\.com\/x\/v2\/reply\/reply\?/u);
    expect(options).toMatchObject({ method: 'GET', redirect: 'error', timeout: 10000, size: 1024 * 1024 });
    expect(options.body).toBeUndefined();
  }
});

test('anonymous mode needs no credentials, follows bounded pages and reports an exact ID on page two', async () => {
  const transport = jest.fn().mockResolvedValueOnce(response(Array.from({ length: 20 }, (_, i) => reply(String(i + 1))), 21))
    .mockResolvedValueOnce(response([reply()], 21));
  const result = await inspectCommentVisibility(target, { transport: transportOf(transport) });
  expect(result.anonymous).toMatchObject({ status: 'visible', pages: 2, reply: { id: '789', uid: '99' } });
  expect(result.authenticated).toBeUndefined();
  expect(new URL(transport.mock.calls[1][0]).searchParams.get('pn')).toBe('2');
  expect(transport.mock.calls.every(([, options]) => !options.headers.Cookie)).toBe(true);
});

test('does not report hidden or absent when pagination was capped or a request failed', async () => {
  const transport = jest.fn().mockResolvedValue(response(Array.from({ length: 20 }, (_, i) => reply(String(i + 1))), 100));
  expect((await inspectCommentVisibility(target, { transport: transportOf(transport) })).anonymous)
    .toEqual({ status: 'truncated', pages: 3 });
  expect(transport).toHaveBeenCalledTimes(3);
  transport.mockReset().mockRejectedValue(new Error('Cookie: private-session'));
  const failed = await inspectCommentVisibility(target, { transport: transportOf(transport) });
  expect(failed.anonymous.status).toBe('unavailable');
  expect(JSON.stringify(failed)).not.toContain('private-session');
  expect(transport).toHaveBeenCalledTimes(1);
  transport.mockReset().mockResolvedValue({ ok: false, status: 412 });
  expect((await inspectCommentVisibility(target, { transport: transportOf(transport) })).anonymous)
    .toEqual({ status: 'unavailable', pages: 1, httpStatus: 412 });
});

test('rejects foreign roots, malformed platform responses and risk codes as unavailable', async () => {
  const transport = jest.fn();
  for (const data of [{ code: -352 }, { code: 0, data: { root: { rpid: 111 }, page: { count: 0 }, replies: [] } },
    { code: 0, data: { root: { rpid: 456 }, page: { count: 1 }, replies: [{ ...reply(), root_str: '111' }] } }]) {
    transport.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(data) });
    expect((await inspectCommentVisibility(target, { transport: transportOf(transport) })).anonymous.status).toBe('unavailable');
  }
  transport.mockResolvedValueOnce({ ok: true, text: async () => '<html>private session error</html>' });
  expect((await inspectCommentVisibility(target, { transport: transportOf(transport) })).anonymous.status).toBe('unavailable');
});

test('preserves 64-bit IDs from platform JSON instead of matching a rounded number', async () => {
  const precise = { ...target, root: '1073543151725051921', replyId: '1073543151725051923' };
  const raw = '{"code":0,"data":{"root":{"rpid":1073543151725051921},"page":{"count":1},"replies":' +
    '[{"rpid":1073543151725051923,"root":1073543151725051921,"member":{"mid":"99"},"state":0,"attr":0}]}}';
  const transport = jest.fn().mockResolvedValue({ ok: true, text: async () => raw });
  expect((await inspectCommentVisibility(precise, { transport: transportOf(transport) })).anonymous.reply?.id).toBe(precise.replyId);
});

test('validates targets before IO and makes authenticated config access an explicit CLI choice', async () => {
  const transport = jest.fn();
  for (const bad of [{ ...target, oid: 'https://evil.invalid' }, { ...target, type: 9 }, { ...target, root: '0' },
    { ...target, replyId: '1&csrf=leak' }]) await expect(inspectCommentVisibility(bad, { transport: transportOf(transport) })).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
  const args = ['--oid', '123', '--type', '1', '--root', '456', '--reply', '789'];
  expect(parseInspectCommentArgs(args)).toEqual({ target });
  expect(parseInspectCommentArgs([...args, '--authenticated', '--config', 'config/production.json']))
    .toEqual({ target, config: 'config/production.json' });
  for (const bad of [[...args, '--config', 'config/production.json'], [...args, '--authenticated'], [...args, '--live'],
    [...args, '--reply', '999'], [...args.slice(0, 3), '1e0', ...args.slice(4)]]) expect(() => parseInspectCommentArgs(bad)).toThrow();
});
