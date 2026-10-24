import * as fs from 'fs';
import * as path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { getProjectRoot } from '../../../../core/config/ProjectPaths';
import { srtToVtt } from '../../../../core/admin/subtitles';
import { isLocalAdminRequest } from '../../../../core/admin/httpAccess';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

async function forwardAdmin(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  // NextURL normalizes loopback IPs to localhost; validate the original Host for Origin comparisons.
  if (!isLocalAdminRequest(request)) {
    return NextResponse.json({ error: '仅允许本机管理页面访问' }, { status: 403 });
  }
  const endpoint = url.pathname.slice('/api/admin'.length);
  const allowed = /^\/(health|title-stats|workflows\/actions|questions\/(rooms|ask|search)|configs(?:\/(production|default|live-vote|secrets|generation-modes))?|clips(?:\/[1-9]\d{0,8}(?:\/titles(?:\/(generate|selection|exposure))?|\/actions|\/feedback|\/cover-preview|\/source-playback|\/assets\/(media|preview|cover|subtitles|preview-subtitles|media-subtitles|source-preview))?)?|manual\/(actions|mcq-\d+(?:\/assets\/(media|cover))?)|jobs|queues(?:\/(actions|status))?|reminders|delayed-tasks(?:\/[a-zA-Z0-9-]+)?)$/u;
  const campaignCandidate = /^\/campaign-candidates(?:\/[a-f0-9]{64}(?:\/source-playback|\/assets\/source-preview|\/feedback|\/actions)?)?$/u.test(endpoint);
  if (!allowed.test(endpoint) && endpoint !== '/bilibili/login' && endpoint !== '/comment-replies' && !campaignCandidate) return NextResponse.json({ error: '管理接口不存在' }, { status: 404 });
  if (campaignCandidate && (endpoint.endsWith('/actions') ? request.method !== 'POST' : !['GET', 'HEAD'].includes(request.method))) return NextResponse.json({ error: '活动候选接口方法无效' }, { status: 405 });
  if (endpoint === '/comment-replies' && request.method !== 'GET') return NextResponse.json({ error: '评论记录仅可读取' }, { status: 405 });
  if (endpoint === '/queues/status' && request.method !== 'GET') return NextResponse.json({ error: '投稿进度仅可读取' }, { status: 405 });
  let body: string | undefined;
  if (!['GET', 'HEAD'].includes(request.method)) {
    body = await request.text();
    if (Buffer.byteLength(body) > (endpoint === '/bilibili/login' ? 65536 : 1024 * 1024)) return NextResponse.json({ error: '请求内容过大' }, { status: 413 });
    try { if (body) JSON.parse(body); } catch { return NextResponse.json({ error: '请求 JSON 无效' }, { status: 400 }); }
  }
  try {
    const delayed = endpoint.startsWith('/delayed-tasks');
    const base = new URL(delayed ? process.env.WEBHOOK_BASE_URL || 'http://127.0.0.1:12523' : process.env.ADMIN_BASE_URL || 'http://127.0.0.1:15127');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.protocol !== 'http:' || base.username || base.password) throw new Error('Invalid service URL');
    const target = delayed ? (endpoint === '/delayed-tasks' ? request.method === 'GET' ? '/api/delayed-reply/tasks' : '/api/delayed-reply' : endpoint.replace('/delayed-tasks/', '/api/delayed-reply/tasks/')) : endpoint;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (!delayed) {
      const tokenFile = process.env.ADMIN_TOKEN_FILE || path.join(getProjectRoot(), 'data/runtime/admin/access-token');
      headers.Authorization = `Bearer ${fs.readFileSync(tokenFile, 'utf8').trim()}`;
    }
    const range = request.headers.get('range'); if (range) headers.Range = range;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), endpoint.startsWith('/questions/') || endpoint.endsWith('/source-playback') || endpoint.endsWith('/cover-preview') ? 100_000 : 30_000);
    let upstream: Response;
    try {
      upstream = await fetch(new URL(target + url.search, base), { method: request.method, cache: 'no-store',
        signal: AbortSignal.any([request.signal, controller.signal]), headers, ...(body ? { body } : {}) });
    } finally { clearTimeout(timer); }
    const responseHeaders: Record<string, string> = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(key); if (value) responseHeaders[key] = value;
    }
    if (upstream.ok && /\/assets\/(preview-|media-)?subtitles$/u.test(endpoint)) {
      delete responseHeaders['content-length']; responseHeaders['content-type'] = 'text/vtt; charset=utf-8';
      return new Response(srtToVtt(await upstream.text()), { status: upstream.status, headers: responseHeaders });
    }
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return NextResponse.json({ error: endpoint.startsWith('/delayed-tasks') ? 'Webhook 服务未连接' : '管理服务未连接，请启动 npm run admin:dev' }, { status: 502 });
  }
}
export const GET = forwardAdmin;
export const POST = forwardAdmin;
export const PUT = forwardAdmin;
export const DELETE = forwardAdmin;
