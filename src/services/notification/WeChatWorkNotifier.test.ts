import fetch from 'node-fetch';
import {
  normalizeWeChatWorkContent,
  WECHAT_WORK_REQUEST_TIMEOUT_MS,
  WeChatWorkNotifier
} from './WeChatWorkNotifier';

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
