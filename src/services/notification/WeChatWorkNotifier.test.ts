import fetch from 'node-fetch';
import { normalizeWeChatWorkContent, WeChatWorkNotifier } from './WeChatWorkNotifier';

jest.mock('node-fetch', () => jest.fn());

const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe('WeChatWorkNotifier', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
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
});
