import fetch from 'node-fetch';
import { parseBilibiliJson } from './CommentApi';
import { positiveId } from './CommentPolicy';

export interface CommentVisibilityTarget { oid: string; type: number; root: string; replyId: string }
export interface CommentVisibilityResult {
  status: 'visible' | 'not-returned' | 'truncated' | 'unavailable';
  pages: number;
  httpStatus?: number;
  code?: number;
  reply?: { id: string; uid: string; state?: number; attr?: number };
}
export function validateVisibilityTarget(target: CommentVisibilityTarget): void {
  if (!target || ![target.oid, target.root, target.replyId].every(id => typeof id === 'string' && positiveId(id)) ||
      ![1, 11, 12, 17].includes(target.type)) throw new Error('Invalid comment visibility target');
}

/** Bounded GETs only. A missing result does not establish moderation or authorize another POST. */
export async function inspectCommentVisibility(target: CommentVisibilityTarget,
  options: { cookie?: string; transport?: typeof fetch; signal?: AbortSignal } = {}) {
  validateVisibilityTarget(target);
  const transport = options.transport || fetch, pageSize = 20, maxPages = 3;
  const read = async (cookie?: string): Promise<CommentVisibilityResult> => {
    let pages = 0;
    try {
      for (let pn = 1; pn <= maxPages; pn++) {
        if (options.signal?.aborted) return { status: 'unavailable', pages };
        const query = new URLSearchParams({ oid: target.oid, type: String(target.type), root: target.root,
          pn: String(pn), ps: String(pageSize), t: String(Date.now()) });
        const response = await transport(`https://api.bilibili.com/x/v2/reply/reply?${query}`, {
          method: 'GET', headers: { Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0',
            ...(cookie ? { Cookie: cookie } : {}) },
          redirect: 'error', timeout: 10000, size: 1024 * 1024, signal: options.signal as any
        });
        pages++;
        if (!response.ok) return { status: 'unavailable', pages, httpStatus: response.status };
        const body = parseBilibiliJson(await response.text());
        if (body?.code !== 0) return { status: 'unavailable', pages,
          ...(Number.isSafeInteger(body?.code) ? { code: body.code } : {}) };
        const data = body.data, replies = data?.replies ?? [];
        if (!Array.isArray(replies) || replies.length > pageSize ||
            positiveId(data?.root?.rpid_str ?? data?.root?.rpid) !== target.root ||
            !Number.isSafeInteger(data?.page?.count) || data.page.count < 0) return { status: 'unavailable', pages };
        const reply = replies.find(row => positiveId(row?.rpid_str ?? row?.rpid) === target.replyId);
        if (reply) {
          const uid = positiveId(reply.member?.mid);
          if (!uid || positiveId(reply.root_str ?? reply.root) !== target.root) return { status: 'unavailable', pages };
          return { status: 'visible', pages, reply: { id: target.replyId, uid,
            ...(Number.isSafeInteger(reply.state) ? { state: reply.state } : {}),
            ...(Number.isSafeInteger(reply.attr) ? { attr: reply.attr } : {}) } };
        }
        if (replies.length < pageSize || pn * pageSize >= data.page.count) return { status: 'not-returned', pages };
      }
      return { status: 'truncated', pages };
    } catch { return { status: 'unavailable', pages }; } // Never expose response text, cookie or transport errors.
  };
  const [anonymous, authenticated] = await Promise.all([read(), options.cookie ? read(options.cookie) : undefined]);
  return { target: { oid: target.oid, type: target.type, root: target.root, replyId: target.replyId },
    checkedAt: new Date().toISOString(), anonymous,
    ...(authenticated ? { authenticated } : {}) };
}
