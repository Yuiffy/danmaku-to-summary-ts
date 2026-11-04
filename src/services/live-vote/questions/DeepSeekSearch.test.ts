import { createDeepSeekSearch, deepSeekSearchSettings, publicWebUrl } from './DeepSeekSearch';
import { createPublicDataRead } from './PublicDataClient';

const settings = { apiKey: 'private-search-key', baseUrl: 'https://api.deepseek.com/v1/tools/' };
const row = { title: '交易所公告', url: 'https://www.hkex.com.hk/news', snippet: '公告摘录', summary: '公告完整摘要',
  site_name: 'HKEX', date: '2026-11-04T00:00:00+00:00' };

test('reuses configured DeepSeek key and normalizes versioned endpoint without exposing settings to tools', () => {
  expect(deepSeekSearchSettings({ ai: { text: { deepSeek: { apiKey: 'key', baseUrl: 'https://api.deepseek.com/v1' } } } }))
    .toEqual({ apiKey: 'key', baseUrl: 'https://api.deepseek.com/v1/tools/', proxy: undefined });
  expect(deepSeekSearchSettings({})).toBeUndefined();
  expect(deepSeekSearchSettings({ ai: { text: { deepSeek: { apiKey: 'key', enabled: false } } } })).toBeUndefined();
  expect(() => deepSeekSearchSettings({ ai: { text: { deepSeek: { apiKey: 'key', baseUrl: 'http://example.com' } } } })).toThrow();
});

test('calls documented independent Search and Fetch APIs with bounded results and redirects disabled', async () => {
  const transport = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ results: [row] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ title: '正文', content: '字'.repeat(9000) }) });
  const signal = new AbortController().signal, web = createDeepSeekSearch(settings, signal, transport as any);
  expect(await web.search('交易所 site:hkex.com.hk')).toEqual([{ title: row.title, url: row.url, snippet: row.snippet,
    summary: row.summary, siteName: row.site_name, publishedAt: row.date }]);
  expect(transport.mock.calls[0][0]).toBe('https://api.deepseek.com/v1/tools/search');
  const options = transport.mock.calls[0][1];
  expect(options).toMatchObject({ method: 'POST', redirect: 'error', signal, timeout: 15000, size: 524288,
    headers: { Authorization: 'Bearer private-search-key' } });
  expect(JSON.parse(options.body)).toEqual({ query: '交易所 site:hkex.com.hk', count: 5, need_content: false });
  expect((await web.read(row.url)).content).toHaveLength(8000);
  expect(transport.mock.calls[1][0]).toBe('https://api.deepseek.com/v1/tools/fetch');
  expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({ url: row.url });
});

test('distinguishes an empty search from malformed/error responses and hides raw provider errors', async () => {
  const transport = jest.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ error: 'private provider error' }) })
    .mockRejectedValueOnce(new Error('private-search-key raw response'));
  const web = createDeepSeekSearch(settings, new AbortController().signal, transport as any);
  expect(await web.search('无结果')).toEqual([]);
  await expect(web.search('响应损坏')).rejects.toThrow('Invalid search response');
  await expect(web.search('失败')).rejects.toThrow(/^DeepSeek search unavailable$/u);
});

test.each(['http://127.0.0.1/', 'http://10.0.0.1/', 'https://localhost/', 'https://server.local/',
  'https://user:password@example.com/', 'file:///c:/secret', 'https://example.com:8080/'])('rejects nonpublic result URLs: %s', url => {
  expect(publicWebUrl(url)).toBeUndefined();
});

test('public data reader enforces fixed origins, size/encoding and cancellation without provider authorization', async () => {
  const transport = jest.fn().mockResolvedValue({ ok: true, buffer: async () => Buffer.from('public data') });
  const controller = new AbortController(), read = createPublicDataRead(controller.signal, undefined, transport as any);
  await expect(read(new URL('https://evil.example/'))).rejects.toThrow('Invalid public data origin');
  expect(transport).not.toHaveBeenCalled();
  expect(await read(new URL('https://qt.gtimg.cn/?q=usAAPL'), 'gb18030')).toBe('public data');
  expect(transport.mock.calls[0][1]).toMatchObject({ redirect: 'error', timeout: 10000, size: 262144, signal: controller.signal });
  expect(transport.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  controller.abort();
  await expect(read(new URL('https://qt.gtimg.cn/'))).rejects.toThrow('cancelled');
  expect(transport).toHaveBeenCalledTimes(1);
});

test('aborted web requests never dispatch', async () => {
  const controller = new AbortController(), transport = jest.fn();
  controller.abort();
  await expect(createDeepSeekSearch(settings, controller.signal, transport as any).search('test')).rejects.toThrow('cancelled');
  expect(transport).not.toHaveBeenCalled();
});
