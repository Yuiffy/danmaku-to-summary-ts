import fetch, { Response } from 'node-fetch';
import { createBilibiliLoginProbe } from './BilibiliLoginProbe';

it('only calls fixed read-only endpoints and retains successful login when refresh info fails', async () => {
  const request = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { isLogin: true, mid: 123, uname: '鹿饼' } })))
    .mockRejectedValueOnce(new Error('offline'));
  const signal = new AbortController().signal;
  expect(await createBilibiliLoginProbe(request as typeof fetch)('private-cookie', signal)).toEqual({ login: 'valid', uid: '123', accountName: '鹿饼', refresh: 'unavailable' });
  expect(request.mock.calls.map(call => call[0])).toEqual(['https://api.bilibili.com/x/web-interface/nav', 'https://passport.bilibili.com/x/passport-login/web/cookie/info']);
  expect(request.mock.calls[0][1]).toMatchObject({ signal, redirect: 'error', headers: { Cookie: 'private-cookie' } });
});
it('classifies expired and unavailable login without trusting error bodies', async () => {
  const request = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: -101 }))).mockRejectedValueOnce(new Error('secret'));
  const probe = createBilibiliLoginProbe(request as typeof fetch), signal = new AbortController().signal;
  expect((await probe('cookie', signal)).login).toBe('invalid');
  expect(await probe('cookie', signal)).toEqual({ login: 'unavailable', refresh: 'unavailable' });
});
