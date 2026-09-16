import fetch from 'node-fetch';

jest.mock('node-fetch', () => jest.fn());

const {
  normalizeWeChatWorkContent,
  sendWeChatMarkdown,
  splitWeChatMarkdown,
  WECHAT_WORK_MARKDOWN_MAX_BYTES
} = require('./wechat_work_markdown');

const mockedFetch = fetch as jest.MockedFunction<typeof fetch>;

describe('wechat_work_markdown compatibility helper', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  test('normalizes paths and splits Chinese Markdown by UTF-8 bytes', () => {
    const content = normalizeWeChatWorkContent(`Review: D:\\clips\\REVIEW.md\n${'栞'.repeat(2000)}`);
    const parts = splitWeChatMarkdown(content);

    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toContain('D:/clips/REVIEW.md');
    expect(parts.every((part: string) => (
      Buffer.byteLength(part, 'utf8') <= WECHAT_WORK_MARKDOWN_MAX_BYTES
    ))).toBe(true);
  });

  test('sends every Markdown part in order', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ errcode: 0 })
    } as any);

    await expect(sendWeChatMarkdown(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      '栞'.repeat(1500)
    )).resolves.toBe(true);

    expect(mockedFetch).toHaveBeenCalledTimes(2);
    const contents = mockedFetch.mock.calls.map(([, init]) => (
      JSON.parse(String(init?.body)).markdown.content
    ));
    expect(contents.every((part: string) => Buffer.byteLength(part, 'utf8') <= 4096)).toBe(true);
  });

  test('stops sending when a later Markdown part is rejected', async () => {
    mockedFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 0 })
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ errcode: 40058, errmsg: 'too long' })
      } as any)
      .mockResolvedValue({
        ok: true,
        json: async () => ({ errcode: 0 })
      } as any);

    await expect(sendWeChatMarkdown(
      'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=test',
      '栞'.repeat(3000)
    )).rejects.toThrow('企业微信第 2/3 段返回错误: 40058 too long');
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});
