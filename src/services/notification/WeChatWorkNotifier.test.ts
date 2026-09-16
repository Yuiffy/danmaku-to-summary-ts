import fetch from 'node-fetch';
import {
  normalizeWeChatWorkContent,
  WECHAT_WORK_REQUEST_TIMEOUT_MS,
  WeChatWorkNotifier
} from './WeChatWorkNotifier';
import {
  splitWeChatMarkdown,
  WECHAT_WORK_MARKDOWN_MAX_BYTES
} from './wechatWorkMarkdown';

jest.mock('node-fetch', () => jest.fn());

const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe('WeChatWorkNotifier', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('normalizes Windows backslashes before sending markdown messages', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ errcode: 0 })
    } as any);

    const notifier = new WeChatWorkNotifier('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test');
    await notifier.sendMarkdown('Review: D:\\files\\videos\\clip\\REVIEW.md');

    const body = JSON.parse(String(mockedFetch.mock.calls[0][1]?.body));
    expect(body.markdown.content).toBe('Review: D:/files/videos/clip/REVIEW.md');
  });

  test('normalizes Windows backslashes in text content', () => {
    expect(normalizeWeChatWorkContent('path=D:\\files\\videos\\clip.mp4')).toBe('path=D:/files/videos/clip.mp4');
  });

  test('splits Markdown by UTF-8 bytes without cutting a Unicode code point', () => {
    const messages = splitWeChatMarkdown(`字幕上下文：${'栞'.repeat(2000)}`);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every(message => (
      Buffer.byteLength(message, 'utf8') <= WECHAT_WORK_MARKDOWN_MAX_BYTES
    ))).toBe(true);
    expect(messages.join('')).toContain('字幕上下文：');
    expect(messages.join('')).toContain('栞'.repeat(2000));
  });

  test('sends long Markdown as ordered byte-bounded webhook requests', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ errcode: 0 })
    } as any);
    const notifier = new WeChatWorkNotifier(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test'
    );
    const content = `## 长通知\n${'栞'.repeat(1500)}\n结尾`;

    await expect(notifier.sendMarkdown(content)).resolves.toBe(true);

    expect(mockedFetch.mock.calls.length).toBeGreaterThan(1);
    const bodies = mockedFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies.every(body => (
      Buffer.byteLength(body.markdown.content, 'utf8') <= WECHAT_WORK_MARKDOWN_MAX_BYTES
    ))).toBe(true);
    expect(bodies[0].markdown.content).toContain('## 长通知');
    expect(bodies[bodies.length - 1].markdown.content).toContain('结尾');
  });

  test('stops after the first rejected Markdown part and reports failure', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockedFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 })
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 40058, errmsg: 'markdown.content exceed max length 4096' })
      } as any)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ errcode: 0 })
      } as any);
    const notifier = new WeChatWorkNotifier(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test'
    );

    await expect(notifier.sendMarkdown(`标题\n${'栞'.repeat(1500)}`)).resolves.toBe(false);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  test('clears the request timeout after a successful send', async () => {
    jest.useFakeTimers();
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ errcode: 0 })
    } as any);
    const notifier = new WeChatWorkNotifier(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test'
    );

    await expect(notifier.sendMarkdown('ok')).resolves.toBe(true);

    expect(mockedFetch.mock.calls[0][1]?.signal?.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('aborts a stalled request at the hard timeout', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let requestSignal: fetch.RequestInit['signal'];
    mockedFetch.mockImplementation(((_url: unknown, init?: fetch.RequestInit) => {
      requestSignal = init?.signal;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new Error('request aborted')));
      });
    }) as typeof fetch);
    const notifier = new WeChatWorkNotifier(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      WECHAT_WORK_REQUEST_TIMEOUT_MS
    );

    const sendPromise = notifier.sendMarkdown('stalled');
    await jest.advanceTimersByTimeAsync(WECHAT_WORK_REQUEST_TIMEOUT_MS - 1);
    expect(requestSignal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);

    await expect(sendPromise).resolves.toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('keeps the hard timeout active while reading the response body', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let requestSignal: fetch.RequestInit['signal'];
    mockedFetch.mockImplementation((async (_url: unknown, init?: fetch.RequestInit) => {
      requestSignal = init?.signal;
      return {
        ok: true,
        json: () => new Promise((_resolve, reject) => {
          requestSignal?.addEventListener('abort', () => reject(new Error('response body aborted')));
        })
      } as any;
    }) as typeof fetch);
    const notifier = new WeChatWorkNotifier(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      WECHAT_WORK_REQUEST_TIMEOUT_MS
    );

    const sendPromise = notifier.sendMarkdown('stalled body');
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(WECHAT_WORK_REQUEST_TIMEOUT_MS);

    await expect(sendPromise).resolves.toBe(false);
    expect(requestSignal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });
});
