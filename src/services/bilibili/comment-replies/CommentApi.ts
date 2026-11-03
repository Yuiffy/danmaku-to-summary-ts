import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import fetch from 'node-fetch';
import FormData = require('form-data');
import sharp from 'sharp';
import { CommentAudience, CommentEvent, CommentPlatformBlocked, positiveId, publishableAnswer, QUOTA_NOTICE, SAFETY_NOTICE, shanghaiDay, privateMessageEvent, LIMITS, unsafeComment } from './CommentPolicy';
import type { CommentPost, CommentPostText, CommentVideo } from './CommentContext';
import { safeEvidenceText } from './CommentContext';
import { BILIBILI_WEB_UA, readVideoTranscript } from './CommentVideoText';
import { CommentFeedError } from './CommentPolling';
import { createAudienceReader } from './CommentAudience';
import { commentFeedResponse } from './CommentFeedDiagnostics';

/** Preserve 64-bit notification/dynamic IDs before JSON.parse can round them. */
export function parseBilibiliJson(text: string): any {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu, token =>
    /^\d{16,}$/u.test(token) ? JSON.stringify(token) : token));
}
export interface FeedPage { items: any[]; cursor: { is_end: boolean; id?: string; time?: number } }

/** Only fixed Bilibili endpoints; URLs from notifications and model output are never followed. */
export class CommentApi {
  private readonly readAudience: ReturnType<typeof createAudienceReader>;
  private wbi?: { key: string; at: number };
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

  private async signedParams(params: Record<string, string>, signal: AbortSignal, antiSpider = false): Promise<URLSearchParams> {
    const now = Date.now();
    if (!this.wbi || now - this.wbi.at >= 300000) {
      const nav = await this.socialGet('https://api.bilibili.com/x/web-interface/nav', signal);
      const urls = ['img_url', 'sub_url'].map(field => typeof nav.wbi_img?.[field] === 'string' ?
        /\/([a-f\d]{32})\.[a-z]+(?:\?.*)?$/iu.exec(nav.wbi_img[field])?.[1] : undefined);
      if (urls.some(value => !value)) throw new Error('Bilibili WBI unavailable');
      const joined = urls.join('');
      const order = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
      this.wbi = { key: order.map(index => joined[index]).join(''), at: now };
    }
    const query = new URLSearchParams(Object.entries({
      ...params,
      ...(antiSpider ? { dm_img_list: '[]', dm_img_str: 'AB', dm_cover_img_str: 'CD', dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}', web_location: '1550101' } : {}),
      wts: String(Math.floor(now / 1000))
    }).sort(([left], [right]) => left.localeCompare(right)));
    query.set('w_rid', createHash('md5').update(query.toString() + this.wbi.key).digest('hex'));
    return query;
  }

  async privateEvents(allowedUids: readonly string[], sessions: Record<string, { seqno: number; baseline?: boolean }>, signal: AbortSignal): Promise<CommentEvent[]> {
    if (!allowedUids.length) return [];
    const data = await this.socialGet('https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions?session_type=1&group_fold=1&unfollow_fold=0&sort_rule=2&build=0&mobi_app=web', signal);
    const rows = Array.isArray(data.session_list) ? data.session_list : [];
    const events: CommentEvent[] = [];
    for (const uid of allowedUids) {
      const session = rows.find((row: any) => positiveId(row?.talker_id) === uid);
      if (!session || !Number.isSafeInteger(session.max_seqno)) continue;
      const checkpoint = sessions[uid] ||= { seqno: 0, baseline: true };
      if (checkpoint.baseline) { checkpoint.seqno = session.max_seqno; checkpoint.baseline = false; continue; }
      if (session.max_seqno <= checkpoint.seqno) continue;
      const query = await this.signedParams({ talker_id: uid, session_type: '1', size: '30', begin_seqno: String(checkpoint.seqno) }, signal);
      const response = await this.transport(`https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs?${query}`, {
        headers: { ...this.credentials().headers, 'User-Agent': BILIBILI_WEB_UA }, signal: signal as any, redirect: 'error', timeout: 15000, size: 2 * 1024 * 1024
      });
      const body = parseBilibiliJson(await response.text());
      if (!response.ok || body?.code !== 0 || !Array.isArray(body?.data?.messages)) throw new Error('Private message feed unavailable');
      for (const row of body.data.messages) {
        const event = privateMessageEvent(row, this.botUid, allowedUids); if (event) events.push(event);
        if (Number.isSafeInteger(row?.msg_seqno)) checkpoint.seqno = Math.max(checkpoint.seqno, row.msg_seqno);
      }
      checkpoint.seqno = Math.max(checkpoint.seqno, session.max_seqno);
    }
    return events;
  }

  private async socialGet(url: string, signal: AbortSignal): Promise<any> {
    if (signal.aborted) throw new Error('Comment context cancelled');
    const response = await this.transport(url, { headers: { ...this.credentials().headers, 'User-Agent': BILIBILI_WEB_UA },
      signal: signal as any, redirect: 'error', timeout: 3000, size: 1024 * 1024 });
    if ([401, 403, 412, 429].includes(response.status)) throw new CommentPlatformBlocked('Comment context blocked');
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

  async video(aid: string, signal: AbortSignal, subtitles = true): Promise<CommentVideo> {
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
    if (cid && subtitles) try { transcript = await readVideoTranscript(aid, cid, this.credentials().headers, signal, this.transport,
      Number.isFinite(duration) && duration > 0 ? duration : undefined); }
    catch (error) { if (error instanceof CommentPlatformBlocked || signal.aborted) throw error; }
    return { title: data.title.slice(0, 200), description: data.desc.slice(0, 2000), publishedAt: data.pubdate * 1000,
      ...(cid && Number.isFinite(duration) && duration > 0 && duration <= 86400 ? { visualTarget: { cid, duration } } : {}),
      pages: Array.isArray(data.pages) ? data.pages.length : 1, ownerUid: positiveId(data.owner?.mid), ...(transcript ? { transcript } : {}) };
  }

  async videoShots(aid: string, cid: string, signal: AbortSignal): Promise<unknown> {
    if (!positiveId(aid) || !positiveId(cid)) throw new Error('Invalid preview target');
    return this.socialGet(`https://api.bilibili.com/x/player/videoshot?aid=${aid}&cid=${cid}&index=1`, signal);
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
        { feed: kind, reason: 'http', ...commentFeedResponse(response.status, response.headers?.get('content-type')) });
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
    catch { throw new CommentFeedError(false, { feed: kind, reason: 'payload', payloadStage: 'json',
      ...commentFeedResponse(response.status, response.headers?.get('content-type'), text) }); }
    const diagnostic = commentFeedResponse(response.status, response.headers?.get('content-type'), text, body);
    if (body?.code !== 0) throw new CommentFeedError(false, { feed: kind, reason: 'platform',
      ...diagnostic, ...(Number.isSafeInteger(body?.code) ? { code: body.code } : {}) });
    if (!Array.isArray(body.data?.items) || body.data.items.length > 100) throw new CommentFeedError(false,
      { feed: kind, reason: 'payload', payloadStage: 'items', ...diagnostic });
    if (typeof body.data?.cursor?.is_end !== 'boolean') throw new CommentFeedError(false,
      { feed: kind, reason: 'payload', payloadStage: 'cursor', ...diagnostic });
    const cursorData = body.data.cursor;
    if (!cursorData.is_end && (!positiveId(cursorData.id) || !Number.isSafeInteger(cursorData.time) || cursorData.time <= 0)) {
      throw new CommentFeedError(false, { feed: kind, reason: 'payload', payloadStage: 'pagination', ...diagnostic });
    }
    return { items: body.data.items, cursor: { is_end: cursorData.is_end, id: positiveId(cursorData.id), time: cursorData.time } };
  }

  private async uploadImage(file: string, signal: AbortSignal): Promise<{ url: string; width: number; height: number; size: number }> {
    if (!path.isAbsolute(file)) throw new Error('Invalid Bilibili image path');
    const data = await fs.readFile(file);
    if (data.length > 10 * 1024 * 1024) throw new Error('Bilibili image too large');
    const image = await sharp(data, { limitInputPixels: 25_000_000 }).png().toBuffer();
    const meta = await sharp(image).metadata();
    if (!meta.width || !meta.height) throw new Error('Bilibili image dimensions unavailable');
    const form = new FormData();
    form.append('biz', 'new_dyn'); form.append('category', 'daily');
    form.append('file_up', image, { filename: 'shikamochi.png', contentType: 'image/png' });
    const headers = { ...this.credentials().headers, ...form.getHeaders() };
    headers.Cookie = `${headers.Cookie}; opus-goback=1`;
    const response = await this.transport('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', {
      method: 'POST', body: form, headers, signal: signal as any,
      redirect: 'error', timeout: 30000, size: 2 * 1024 * 1024
    });
    const body = parseBilibiliJson(await response.text());
    const result = body?.data;
    const url = typeof result?.image_url === 'string' ? result.image_url : typeof result?.url === 'string' ? result.url : '';
    if (!response.ok || body?.code !== 0 || !/^https:\/\//u.test(url)) throw new Error('Bilibili image upload unconfirmed');
    return { url, width: Number(result.image_width) || meta.width, height: Number(result.image_height) || meta.height,
      size: Number(result.img_size) || Number(result.image_size) || Math.max(1, Math.round(image.length / 1024)) };
  }

  private async sendPrivate(event: CommentEvent, answer: string, signal: AbortSignal, image?: string): Promise<string> {
    const { headers, csrf } = this.credentials();
    const receiver = event.oid;
    let msgType = '1', content = JSON.stringify({ content: answer });
    if (image) {
      const uploaded = await this.uploadImage(image, signal);
      msgType = '2'; content = JSON.stringify({ url: uploaded.url, height: uploaded.height, width: uploaded.width, imageType: 'png', original: 1, size: uploaded.size });
    }
    const query = await this.signedParams({ sender_uid: this.botUid, receiver_id: receiver }, signal);
    const body = new URLSearchParams({ 'msg[sender_uid]': this.botUid, 'msg[receiver_id]': receiver, 'msg[receiver_type]': '1',
      'msg[msg_type]': msgType, 'msg[msg_status]': '0', 'msg[content]': content, 'msg[dev_id]': 'A6716E9A-7CE3-47AF-994B-F0B34178D28D',
      'msg[new_face_version]': '0', 'msg[timestamp]': String(Math.floor(Date.now() / 1000)), from_filework: '0', build: '0', mobi_app: 'web', csrf, csrf_token: csrf });
    const response = await this.transport(`https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?${query}`, {
      method: 'POST', body, headers: { ...headers, 'User-Agent': BILIBILI_WEB_UA }, signal: signal as any, redirect: 'error', timeout: 15000, size: 128 * 1024
    });
    const data = parseBilibiliJson(await response.text());
    const id = positiveId(data?.data?.msg_key) || positiveId(data?.data?.msg_seqno);
    if (!response.ok || data?.code !== 0 || !id) throw new Error('Private message publication unconfirmed');
    return id;
  }

  /**
   * Dynamic replies do not reliably accept an image in the nested reply form.
   * When an image is requested from a nested dynamic reply, publish one
   * top-level comment on the same dynamic and carry the original author as a
   * platform-resolved @ mention.
   */
  private dynamicImageFallback(event: CommentEvent, answer: string, image?: string):
    { root: string; parent: string; message: string; atNameToMid: string } | undefined {
    if (!image || event.channel === 'private' || ![11, 17].includes(event.type) ||
        event.root === '0' && event.parent === '0') return undefined;
    const name = event.authorName?.trim();
    if (!name) throw new Error('Dynamic image fallback requires original author name');
    const root = positiveId(event.root) || positiveId(event.parent);
    if (!root) throw new Error('Dynamic image fallback requires a comment target');
    const mention = `@${name}`;
    const message = answer.includes(mention) ? answer : `${mention} ${answer}`;
    const url = `https://t.bilibili.com/${event.oid}?comment_on=1&comment_root_id=${root}&type=2#reply${root}`;
    if (!message.trim() || Array.from(message).length > LIMITS.outputChars || /[\p{Cc}\p{Cf}]/u.test(message) ||
        /(?:```|<\/?(?:script|tool)|tool_calls|BEGIN .*PRIVATE KEY|sk-[a-z0-9]{12})/iu.test(message) ||
        unsafeComment(message.replace(url, ''))) throw new Error('Invalid dynamic image publication');
    return { root: '0', parent: '0', message, atNameToMid: JSON.stringify({ [name]: event.uid }) };
  }

  async send(event: CommentEvent, answer: string, signal: AbortSignal, image?: string): Promise<string> {
    if (signal.aborted || !positiveId(event.oid) || event.channel === 'private') {
      if (signal.aborted || event.channel !== 'private' || event.type !== 0 || event.root !== '0' || event.parent !== '0' ||
          !publishableAnswer(answer)) throw new Error('Invalid private message publication');
      return this.sendPrivate(event, answer, signal, image);
    }
    const fallback = this.dynamicImageFallback(event, answer, image);
    if (event.type === 1 && event.trigger !== 'mention' || ![1, 11, 12, 17].includes(event.type) ||
        ![event.root, event.parent].every(id => id === '0' || positiveId(id)) ||
        !fallback && answer !== QUOTA_NOTICE && answer !== SAFETY_NOTICE && !publishableAnswer(answer)) throw new Error('Invalid comment publication');
    const { headers, csrf } = this.credentials();
    let pictures: { img_src: string; img_width: number; img_height: number; img_size: number } | undefined;
    if (image) { const uploaded = await this.uploadImage(image, signal); pictures = { img_src: uploaded.url, img_width: uploaded.width, img_height: uploaded.height, img_size: uploaded.size }; }
    const targetRoot = fallback?.root ?? event.root, targetParent = fallback?.parent ?? event.parent;
    const body = new URLSearchParams({ oid: event.oid, type: String(event.type), message: fallback?.message ?? answer,
      plat: '1', csrf, csrf_token: csrf });
    // The web comment form omits root/parent for a top-level comment; sending
    // literal zeroes is rejected by the dynamic image path.
    if (targetRoot !== '0') body.set('root', targetRoot);
    if (targetParent !== '0') body.set('parent', targetParent);
    if (pictures) {
      body.set('pictures', JSON.stringify([pictures]));
    }
    if (event.type === 1) {
      // Keep the web client's publication context; code=0 alone does not establish public visibility.
      headers.Referer = `https://www.bilibili.com/video/av${event.oid}/`;
      headers.Origin = 'https://www.bilibili.com';
      headers['User-Agent'] = BILIBILI_WEB_UA;
      body.set('gaia_source', 'main_web');
      body.set('ordering', 'heat');
      body.set('at_name_to_mid', '{}');
      body.set('statistics', JSON.stringify({ appId: 100, platform: 5, version: '2.0' }));
    } else if (fallback) {
      body.set('gaia_source', 'main_web');
      body.set('statistics', JSON.stringify({ appId: 100, platform: 5 }));
      body.set('at_name_to_mid', fallback.atNameToMid);
    }
    const endpoint = pictures
      ? `https://api.bilibili.com/x/v2/reply/add?${await this.signedParams({}, signal, true)}`
      : 'https://api.bilibili.com/x/v2/reply/add';
    if (pictures) headers.Cookie = `${headers.Cookie}; opus-goback=1`;
    const response = await this.transport(endpoint, {
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
