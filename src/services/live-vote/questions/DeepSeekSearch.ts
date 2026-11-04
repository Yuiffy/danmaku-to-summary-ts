import fetch from 'node-fetch';
import { isIP } from 'net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ConfigObject } from '../../../core/config/ConfigLayers';

export interface WebSearchResult {
  title: string; url: string; snippet: string; summary: string; siteName: string | null; publishedAt: string | null;
}
export interface WebSearch {
  search(query: string): Promise<WebSearchResult[]>;
  read(url: string): Promise<{ title: string; content: string }>;
}
export interface DeepSeekSearchSettings { apiKey: string; baseUrl: string; proxy?: string }
function object(value: unknown): ConfigObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as ConfigObject : {};
}
export function deepSeekSearchSettings(config: ConfigObject): DeepSeekSearchSettings | undefined {
  const ai = object(config.ai), text = object(object(ai.text).deepSeek), provider = object(object(ai.providers).deepSeek);
  const key = text.apiKey || provider.apiKey;
  if (text.enabled === false || provider.enabled === false || typeof key !== 'string' || !key.trim()) return undefined;
  const base = text.baseUrl || provider.baseURL || provider.baseUrl || 'https://api.deepseek.com';
  const url = new URL(String(base));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid DeepSeek search endpoint');
  const proxy = text.proxy ?? provider.proxy;
  if (proxy !== undefined && typeof proxy !== 'string') throw new Error('Invalid DeepSeek search proxy');
  url.pathname = url.pathname.replace(/\/$/u, '').replace(/\/v1$/u, '') + '/v1/tools/';
  return { apiKey: key, baseUrl: url.toString(), proxy: proxy as string | undefined };
}

/** Page addresses are data only; only URLs issued by search can later be selected by opaque ID. */
export function publicWebUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
        !url.hostname.includes('.') || isIP(url.hostname) || url.hostname.startsWith('[') ||
        /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname)) return undefined;
    url.hash = '';
    return url.toString();
  } catch { return undefined; }
}

/** DeepSeek Search/Fetch are independent APIs, not an undocumented chat-completions flag. */
export function createDeepSeekSearch(settings: DeepSeekSearchSettings, signal: AbortSignal, transport = fetch): WebSearch {
  const agent = settings.proxy ? new HttpsProxyAgent(settings.proxy) : undefined;
  const post = async (action: 'search' | 'fetch', body: unknown): Promise<unknown> => {
    if (signal.aborted) throw new Error('Question cancelled');
    try {
      const response = await transport(new URL(action, settings.baseUrl).toString(), {
        method: 'POST', redirect: 'error', timeout: 15000, size: 512 * 1024, signal: signal as any, agent,
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error('Search request failed');
      return await response.json();
    } catch { throw new Error('DeepSeek search unavailable'); }
  };
  return {
    search: async query => {
      const value = await post('search', { query, count: 5, need_content: false }) as { results?: unknown[] };
      if (!value || !Array.isArray(value.results)) throw new Error('Invalid search response');
      return value.results.slice(0, 5).flatMap(row => {
        const item = object(row), url = publicWebUrl(item.url);
        if (!url || typeof item.title !== 'string' || typeof item.snippet !== 'string' || typeof item.summary !== 'string') return [];
        return [{ title: item.title.slice(0, 200), url, snippet: item.snippet.slice(0, 800), summary: item.summary.slice(0, 1800),
          siteName: typeof item.site_name === 'string' ? item.site_name.slice(0, 100) : null,
          publishedAt: typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(item.date) && Number.isFinite(Date.parse(item.date)) ? item.date : null }];
      });
    },
    read: async url => {
      if (publicWebUrl(url) !== url) throw new Error('Invalid search page');
      const value = await post('fetch', { url }) as { title?: unknown; content?: unknown };
      if (!value || typeof value.title !== 'string' || typeof value.content !== 'string' || !value.content.trim()) throw new Error('Invalid page response');
      return { title: value.title.slice(0, 200), content: value.content.slice(0, 8000) };
    }
  };
}
