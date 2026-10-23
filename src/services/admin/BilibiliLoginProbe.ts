import fetch, { RequestInit } from 'node-fetch';

export interface LoginProbe {
  login: 'valid' | 'invalid' | 'unavailable';
  uid?: string;
  accountName?: string;
  refresh: 'needed' | 'not-needed' | 'unavailable';
}

/** Fixed, read-only authentication checks. Never rotates a session or sends a comment. */
export function createBilibiliLoginProbe(request: typeof fetch = fetch): (cookie: string, signal: AbortSignal) => Promise<LoginProbe> {
  return async (cookie, signal) => {
    const unavailable: LoginProbe = { login: 'unavailable', refresh: 'unavailable' };
    const headers = { Cookie: cookie, Referer: 'https://www.bilibili.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' };
    try {
      const response = await request('https://api.bilibili.com/x/web-interface/nav', { headers, signal: signal as RequestInit['signal'], redirect: 'error', size: 1024 * 1024 });
      if (!response.ok) return unavailable;
      const body = await response.json();
      if (body.code === -101 || body.code === 0 && !body.data?.isLogin) return { ...unavailable, login: 'invalid' };
      if (body.code !== 0 || !body.data?.isLogin || !/^[1-9]\d*$/u.test(String(body.data.mid))) return unavailable;
      const result: LoginProbe = { ...unavailable, login: 'valid', uid: String(body.data.mid),
        accountName: typeof body.data.uname === 'string' ? body.data.uname.slice(0, 80) : undefined };
      try {
        const check = await request('https://passport.bilibili.com/x/passport-login/web/cookie/info', { headers, signal: signal as RequestInit['signal'], redirect: 'error', size: 1024 * 1024 });
        const info = check.ok ? await check.json() : undefined;
        if (info?.code === 0 && typeof info.data?.refresh === 'boolean') result.refresh = info.data.refresh ? 'needed' : 'not-needed';
      } catch { /* A failed refresh probe does not invalidate a successful login check. */ }
      return result;
    } catch { return unavailable; }
  };
}

export async function checkCommentLogin(signal: AbortSignal): Promise<'valid' | 'invalid' | 'unavailable'> {
  try {
    const base = new URL(process.env.WEBHOOK_BASE_URL || 'http://127.0.0.1:12523');
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) return 'unavailable';
    const response = await fetch(new URL('/api/bilibili/check-cookie', base), { signal: signal as RequestInit['signal'], redirect: 'error', size: 1024 * 1024 });
    const body = response.ok ? await response.json() : undefined;
    return body?.success === true && typeof body.data?.valid === 'boolean' ? body.data.valid ? 'valid' : 'invalid' : 'unavailable';
  } catch { return 'unavailable'; }
}
