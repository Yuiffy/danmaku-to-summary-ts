import fetch from 'node-fetch';
import { CommentAudience, CommentEvent, CommentPlatformBlocked, positiveId, publishableAnswer, QUOTA_NOTICE, SAFETY_NOTICE, shanghaiDay } from './CommentPolicy';
import type { CommentPost, CommentPostText, CommentVideo } from './CommentContext';
import { safeEvidenceText } from './CommentContext';
import { BILIBILI_WEB_UA, readVideoTranscript } from './CommentVideoText';
import { CommentFeedError } from './CommentPolling';
import { createAudienceReader } from './CommentAudience';

/** Preserve 64-bit notification/dynamic IDs before JSON.parse can round them. */
export function parseBilibiliJson(text: string): any {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu, token =>
    /^\d{16,}$/u.test(token) ? JSON.stringify(token) : token));
}
export interface FeedPage { items: any[]; cursor: { is_end: boolean; id?: string; time?: number } }

/** Only fixed Bilibili endpoints; URLs from notifications and model output are never followed. */
export class CommentApi {
  private readonly readAudience: ReturnType<typeof createAudienceReader>;
  constructor(private readonly botUid: string, private readonly cookie: () => string, private readonly transport = fetch) {
    if (!positiveId(botUid)) throw new Error('Invalid comment bot UID');
    this.readAudience = createAudienceReader(botUid, (url, signal) => this.socialGet(url, signal));
  }
  private credentials(): { headers: Record<string, string>; csrf: string } {
    const cookie = this.cookie();
    const uid = /(?:^|;\s*)DedeUserID=(\d+)/u.exec(cookie)?.[1];
    const csrf = /(?:^|;\s*)bili_jct=([^;]+)/u.exec(cookie)?.[1];
    if (uid !== this.botUid || !csrf || !/(?:^|;\s*)SESSDATA=[^;]+/u.test(cookie)) throw new Error('Comment account credentials mismatch');
    return { headers: { Cookie: cookie, Referer: 'https://www.bilibili.com/', 'User-Agent': 'Mozilla/5.0' }, csrf };
  }
  checkCredentials(): void { this.credentials(); }

  private async socialGet(url: string, signal: AbortSignal): Promise<any> {
    if (signal.aborted) throw new Error('Comment context cancelled');
    const response = await this.transport(url, { headers: { ...this.credentials().headers, 'User-Agent': BILIBILI_WEB_UA },
      signal: signal as any, redirect: 'error', timeout: 3000, size: 1024 * 1024 });
    if ([403, 412, 429].includes(response.status)) throw new CommentPlatformBlocked('Comment context blocked');
    const body = parseBilibiliJson(await response.text());
    if ([-101, -111, -352, -403, -412].includes(body?.code)) throw new CommentPlatformBlocked('Comment context blocked');
    if (!response.ok || body?.code !== 0 || !body.data) throw new Error('Comment context unavailable');
    return body.data;
  }

  /** One exact dynamic plus the embedded forward only; itemOpusStyle preserves forwarded announcement text. */
  async dynamic(id: string, signal: AbortSignal): Promise<CommentPost> {
    if (!positiveId(id)) throw new Error('Invalid dynamic context target');
    const data = await this.socialGet(`https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${id}&features=itemOpusStyle`, signal);
    if (positiveId(data.item?.id_str) !== id) throw new Error('Dynamic context target mismatch');
    const read = (item: any): CommentPostText => {
      const author = item?.modules?.module_author, content = item?.modules?.module_dynamic;
      if (!author || !Number.isSafeInteger(author.pub_ts) || author.pub_ts <= 0 || !content) throw new Error('Dynamic context unavailable');
      const text = content.desc?.text || content.major?.opus?.summary?.text || '';
      if (typeof text !== 'string') throw new Error('Invalid dynamic context text');
      const nodes = content.desc?.rich_text_nodes || content.major?.opus?.summary?.rich_text_nodes;
      // Count distinct platform-bound mentions only, without treating tags as confirmed participants.
      // Omit this aid when text may be truncated or the rich-text list is incomplete/malformed.
      const mentions = Array.isArray(nodes) && nodes.length <= 100 && text.length <= 400
        ? nodes.filter((node: any) => node?.type === 'RICH_TEXT_NODE_TYPE_AT') : [];
      const mentionedUsers = mentions.length && mentions.every((node: any) => positiveId(node.rid))
        ? new Set(mentions.map((node: any) => positiveId(node.rid))).size : undefined;
      return { author: typeof author.name === 'string' ? safeEvidenceText(author.name, 40) : '',
        publishedAt: author.pub_ts * 1000, publishedDay: shanghaiDay(author.pub_ts * 1000),
        ...(mentionedUsers ? { mentionedUsers } : {}),
        text: text.split(/\r?\n/u).map(line => safeEvidenceText(line, 400)).filter(Boolean).join(' ').slice(0, 400) };
    };
    const result: CommentPost = read(data.item);
    if (positiveId(data.item.orig?.id_str)) {
      try { result.original = read(data.item.orig); }
      catch { result.partial = true; }
    }
    return result;
  }

  /** Profile establishes wearing; an exact medal ID resolves its anchor UID. */
  async audience(uid: string, signal: AbortSignal): Promise<CommentAudience> {
    return this.readAudience(uid, signal);
  }

  /** One heat-sorted page; only three independent audience comments reach the agent. */
  async hotComments(event: CommentEvent, signal: AbortSignal): Promise<Array<{ text: string; likes: number }>> {
    if (!positiveId(event.oid) || ![1, 11, 12, 17].includes(event.type)) throw new Error('Invalid hot comment target');
    const data = await this.socialGet(`https://api.bilibili.com/x/v2/reply?type=${event.type}&oid=${event.oid}&sort=2&pn=1&ps=5`, signal);
    const rows = [...(Array.isArray(data.hots) ? data.hots : []), ...(Array.isArray(data.replies) ? data.replies : [])];
    if (rows.length > 40) throw new Error('Invalid hot comment page');
    const seen = new Set<string>();
    return rows.filter(row => {
      const id = positiveId(row?.rpid_str ?? row?.rpid);
      if (!id || seen.has(id) || id === event.parent || positiveId(row.member?.mid) === this.botUid) return false;
      seen.add(id); return true;
    }).flatMap(row => {
      const text = typeof row.content?.message === 'string' ? safeEvidenceText(row.content.message, 90) : '';
      return text && Number.isSafeInteger(row.like) && row.like >= 0 ? [{ text, likes: row.like }] : [];
    }).sort((a, b) => b.likes - a.likes).slice(0, 3);
  }

  async video(aid: string, signal: AbortSignal): Promise<CommentVideo> {
    if (!positiveId(aid) || signal.aborted) throw new Error('Invalid video context target');
    const response = await this.transport(`https://api.bilibili.com/x/web-interface/view?aid=${aid}`, {
      // View responses can include the video's entire season. Retain only bounded metadata below.
      headers: { ...this.credentials().headers, 'User-Agent': BILIBILI_WEB_UA, Referer: `https://www.bilibili.com/video/av${aid}/` },
      signal: signal as any, redirect: 'error', timeout: 3000, size: 4 * 1024 * 1024
    });
    if ([403, 412, 429].includes(response.status)) throw new CommentPlatformBlocked('Video context blocked by platform');
    const body = parseBilibiliJson(await response.text()), data = body?.data;
    if ([-101, -111, -352, -403, -412].includes(body?.code)) {
      throw new CommentPlatformBlocked('Video context blocked by platform');
    }
    if (!response.ok || body.code !== 0 || positiveId(data?.aid) !== aid || typeof data.title !== 'string' ||
        typeof data.desc !== 'string' || !Number.isSafeInteger(data.pubdate)) throw new Error('Video context unavailable');
    let transcript: CommentVideo['transcript'];
    const cid = positiveId(data.cid);
    const duration = data.pages?.[0]?.duration || data.duration;
    if (cid) try { transcript = await readVideoTranscript(aid, cid, this.credentials().headers, signal, this.transport,
      Number.isFinite(duration) && duration > 0 ? duration : undefined); }
    catch (error) { if (error instanceof CommentPlatformBlocked || signal.aborted) throw error; }
    return { title: data.title.slice(0, 200), description: data.desc.slice(0, 2000), publishedAt: data.pubdate * 1000,
      pages: Array.isArray(data.pages) ? data.pages.length : 1, ...(transcript ? { transcript } : {}) };
  }

  async feed(kind: 'reply' | 'at', cursor?: { id: string; time: number }): Promise<FeedPage> {
    if (!['reply', 'at'].includes(kind)) throw new Error('Invalid notification feed');
    const query = new URLSearchParams({ platform: 'web' });
    if (cursor) {
      if (!positiveId(cursor.id) || !Number.isSafeInteger(cursor.time) || cursor.time <= 0) throw new Error('Invalid feed cursor');
      query.set('id', cursor.id); query.set(kind === 'reply' ? 'reply_time' : 'at_time', String(cursor.time));
    }
    const headers = this.credentials().headers;
    let response, text: string;
    try {
      response = await this.transport(`https://api.bilibili.com/x/msgfeed/${kind}?${query}`, {
        headers, redirect: 'error', timeout: 15000, size: 1024 * 1024
      });
      if (!response.ok) throw new CommentFeedError([408, 500, 502, 503, 504].includes(response.status),
        { feed: kind, reason: 'http', httpStatus: response.status });
      text = await response.text();
    } catch (error) {
      if (error instanceof CommentFeedError) throw error;
      const failure = error as { type?: unknown; code?: unknown } | undefined;
      const transportCode = typeof failure?.code === 'string' &&
        ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH'].includes(failure.code)
        ? failure.code : undefined;
      throw new CommentFeedError(!!transportCode || ['request-timeout', 'body-timeout'].includes(String(failure?.type)),
        { feed: kind, reason: 'network', ...(transportCode ? { transportCode } : {}) });
    }
    let body;
    try { body = parseBilibiliJson(text); }
    catch { throw new CommentFeedError(false, { feed: kind, reason: 'payload' }); }
    if (body?.code !== 0) throw new CommentFeedError(false, { feed: kind, reason: 'platform',
      ...(Number.isSafeInteger(body?.code) ? { code: body.code } : {}) });
    if (!Array.isArray(body.data?.items) || body.data.items.length > 100 ||
        typeof body.data?.cursor?.is_end !== 'boolean') throw new CommentFeedError(false, { feed: kind, reason: 'payload' });
    const cursorData = body.data.cursor;
    if (!cursorData.is_end && (!positiveId(cursorData.id) || !Number.isSafeInteger(cursorData.time) || cursorData.time <= 0)) {
      throw new CommentFeedError(false, { feed: kind, reason: 'payload' });
    }
    return { items: body.data.items, cursor: { is_end: cursorData.is_end, id: positiveId(cursorData.id), time: cursorData.time } };
  }

  async send(event: CommentEvent, answer: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted || event.type === 1 && event.trigger !== 'mention' || !positiveId(event.oid) || ![1, 11, 12, 17].includes(event.type) ||
        ![event.root, event.parent].every(id => id === '0' || positiveId(id)) ||
        answer !== QUOTA_NOTICE && answer !== SAFETY_NOTICE && !publishableAnswer(answer)) throw new Error('Invalid comment publication');
    const { headers, csrf } = this.credentials();
    const body = new URLSearchParams({ oid: event.oid, type: String(event.type), root: event.root, parent: event.parent,
      message: answer, plat: '1', csrf, csrf_token: csrf });
    if (event.type === 1) {
      // Keep the web client's publication context; code=0 alone does not establish public visibility.
      headers.Referer = `https://www.bilibili.com/video/av${event.oid}/`;
      headers.Origin = 'https://www.bilibili.com';
      headers['User-Agent'] = BILIBILI_WEB_UA;
      body.set('gaia_source', 'main_web');
      body.set('ordering', 'heat');
      body.set('at_name_to_mid', '{}');
      body.set('statistics', JSON.stringify({ appId: 100, platform: 5, version: '2.0' }));
    }
    const response = await this.transport('https://api.bilibili.com/x/v2/reply/add', {
      method: 'POST', body, headers, signal: signal as any, redirect: 'error', timeout: 15000, size: 128 * 1024
    });
    if (!response.ok) throw new Error('Comment publication unconfirmed');
    const data = parseBilibiliJson(await response.text());
    const id = positiveId(data?.data?.rpid_str) || positiveId(data?.data?.rpid);
    if (data.code !== 0 || !id) throw new Error('Comment publication unconfirmed');
    return id;
  }

  async like(event: CommentEvent, signal: AbortSignal): Promise<void> {
    if (signal.aborted || !positiveId(event.oid) || !positiveId(event.parent) || ![1, 11, 12, 17].includes(event.type) ||
        event.type === 1 && event.trigger !== 'mention') throw new Error('Invalid comment like target');
    const { headers, csrf } = this.credentials();
    const response = await this.transport('https://api.bilibili.com/x/v2/reply/action', {
      method: 'POST', headers, body: new URLSearchParams({ oid: event.oid, type: String(event.type),
        rpid: event.parent, action: '1', csrf, csrf_token: csrf }), signal: signal as any,
      redirect: 'error', timeout: 15000, size: 128 * 1024
    });
    const data = parseBilibiliJson(await response.text());
    if (!response.ok || data.code !== 0) throw new Error('Comment like unconfirmed');
  }
}
