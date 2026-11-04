import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

export type PublicDataRead = (url: URL, encoding?: 'utf-8' | 'gb18030') => Promise<string>;

/** Only fixed public data origins; no model supplied URLs, cookies or provider credentials. */
export function createPublicDataRead(signal: AbortSignal, proxy?: string, transport = fetch): PublicDataRead {
  const hosts = new Set(['qt.gtimg.cn', 'smartbox.gtimg.cn', 'geocoding-api.open-meteo.com',
    'api.open-meteo.com', 'zh.wikipedia.org']);
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  return async (url, encoding = 'utf-8') => {
    if (signal.aborted) throw new Error('Question cancelled');
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password || url.hash) {
      throw new Error('Invalid public data origin');
    }
    try {
      const response = await transport(url.toString(), { signal: signal as any, redirect: 'error',
        timeout: 10000, size: 256 * 1024, agent, headers: { 'User-Agent': 'Shikamochi/1.0 (livestream read-only questions)' } });
      if (!response.ok) throw new Error('Public data unavailable');
      return new TextDecoder(encoding).decode(await response.buffer());
    } catch { throw new Error('Public data unavailable'); }
  };
}
