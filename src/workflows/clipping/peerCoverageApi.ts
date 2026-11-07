import type { RequestInit, Response } from 'node-fetch';
import { createHash } from 'crypto';
import type { CoverageCue, PeerVideo } from './peerCoverage';

// Protocol checked against bilibili-api-python 17.4.1 search/video/favorite_list and
// renmu123/biliAPI. Only fixed platform endpoints receive credentials; writes never retry.
const API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ORDER = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];
const id = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value)
    : typeof value === 'string' && /^[1-9]\d*$/u.test(value) ? value : '';
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/<[^>]*>/gu, '').slice(0, max) : '';
export class PeerPlatformUnavailable extends Error {
    constructor(readonly blocked = false) { super(blocked ? 'peer_platform_blocked' : 'peer_platform_unavailable'); }
}
export interface PeerApi {
    accountId(): Promise<string>;
    search(query: string, limit: number, options?: { page?: number; order?: 'totalrank' | 'pubdate' }): Promise<PeerVideo[]>;
    read(video: PeerVideo): Promise<PeerVideo>;
    has(action: 'like' | 'favorite' | 'repost', video: PeerVideo, receipt?: any): Promise<boolean>;
    act(action: 'like' | 'favorite' | 'repost', video: PeerVideo, folder?: string): Promise<unknown>;
    defaultFolder(video: PeerVideo): Promise<string>;
}

export function createPeerApi(cookie: string, transport: (url: string, init: RequestInit) => Promise<Response> = (...args) => require('node-fetch')(...args), now = Date.now): PeerApi {
    const csrf = /(?:^|;\s*)bili_jct=([^;]+)/u.exec(cookie)?.[1] || '';
    let nav: any, key: string | undefined, stopped = false;
    const readJson = async (url: string, body?: URLSearchParams, cdn = false): Promise<any> => {
        if (stopped) throw new PeerPlatformUnavailable(true);
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
        try {
            const options: RequestInit = { method: body ? 'POST' : 'GET', body, redirect: 'error', signal: controller.signal as any,
                size: 2 * 1024 * 1024, headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/',
                    ...(!cdn && cookie ? { Cookie: cookie } : {}) } };
            const response = await transport(url, options);
            if ([401,403,412,429].includes(response.status)) { stopped = true; throw new PeerPlatformUnavailable(true); }
            if (!response.ok) throw new PeerPlatformUnavailable();
            const result = JSON.parse(await response.text());
            if (!cdn && [-101,-111,-352,-403,-412,12002].includes(result.code)) {
                stopped = true; throw new PeerPlatformUnavailable(true);
            }
            if (!cdn && result.code !== 0) throw new PeerPlatformUnavailable();
            return cdn ? result : result.data;
        } catch (error) {
            if (error instanceof PeerPlatformUnavailable) throw error;
            throw new PeerPlatformUnavailable();
        } finally { clearTimeout(timer); }
    };
    const navigation = async () => {
        if (!nav) nav = await readJson(`${API}/x/web-interface/nav`);
        if (!id(nav?.mid) || nav.isLogin !== true) throw new PeerPlatformUnavailable();
        return nav;
    };
    const signed = async (fields: Record<string, string>) => {
        if (!key) {
            const current = await navigation();
            const parts = ['img_url','sub_url'].map(field => /\/([a-f\d]{32})\.[a-z]+(?:\?.*)?$/iu.exec(current.wbi_img?.[field] || '')?.[1]);
            if (parts.some(v => !v)) throw new PeerPlatformUnavailable();
            const joined = parts.join(''); key = ORDER.map(index => joined[index]).join('');
        }
        const values: Record<string, string> = { ...fields, wts: String(Math.floor(now() / 1000)) };
        const query = Object.keys(values).sort().map(name => `${encodeURIComponent(name)}=${encodeURIComponent(values[name].replace(/[!'()*]/gu, ''))}`).join('&');
        return `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`;
    };
    const target = (video: PeerVideo) => {
        if (!/^BV[a-zA-Z0-9]{10}$/u.test(video.bvid) || !id(video.aid) || !id(video.ownerId)) throw new Error('Invalid peer video');
    };
    const archiveMatches = (item: any, video: PeerVideo) => {
        const archive = item?.modules?.module_dynamic?.major?.archive;
        return id(item?.modules?.module_author?.mid) === video.ownerId
            && archive?.bvid === video.bvid && id(archive.aid) === video.aid;
    };
    const findDynamic = async (uid: string, matches: (item: any) => boolean): Promise<string | undefined> => {
        let offset = '';
        for (let page = 0; page < 3; page++) {
            const query = new URLSearchParams({ host_mid: uid, offset, timezone_offset: '-480' });
            const feed = await readJson(`${API}/x/polymer/web-dynamic/v1/feed/space?${query}`);
            if (!Array.isArray(feed?.items) || feed.items.length > 50) throw new PeerPlatformUnavailable();
            const found = feed.items.find((item: any) => matches(item) && typeof item.id_str === 'string' && id(item.id_str));
            if (found) return found.id_str;
            if (feed.has_more === false || feed.has_more === 0) return undefined;
            if (typeof feed.offset !== 'string' || !feed.offset || feed.offset === offset) throw new PeerPlatformUnavailable();
            offset = feed.offset;
        }
        return undefined;
    };
    return {
        accountId: async () => id((await navigation()).mid),
        search: async (query, limit, options = {}) => {
            const page = options.page || 1, order = options.order || 'totalrank';
            if (query.length < 3 || query.length > 80 || limit < 1 || limit > 20 || !Number.isInteger(page) || page < 1 || page > 5) throw new Error('Invalid bounded peer search');
            const params = await signed({ keyword: query, search_type: 'video', page: String(page), page_size: String(limit), order });
            const data = await readJson(`${API}/x/web-interface/wbi/search/type?${params}`);
            if (!Array.isArray(data?.result)) {
                if (data?.numResults === 0) return [];
                throw new PeerPlatformUnavailable();
            }
            return data.result.slice(0, limit).flatMap((row: any) => {
                if (!/^BV[a-zA-Z0-9]{10}$/u.test(row.bvid) || !id(row.aid) || !id(row.mid)) return [];
                return [{ bvid: row.bvid, aid: id(row.aid), ownerId: id(row.mid), title: clean(row.title, 200),
                    description: clean(row.description, 3000), publishedAt: Number(row.pubdate) || 0,
                    duration: 0, cues: [], complete: false }];
            });
        },
        read: async video => {
            target(video);
            const detail = await readJson(`${API}/x/web-interface/view?bvid=${video.bvid}`);
            if (detail?.bvid !== video.bvid || id(detail.aid) !== video.aid || id(detail.owner?.mid) !== video.ownerId
                || !Array.isArray(detail.pages) || detail.pages.length !== 1 || !id(detail.pages[0].cid)
                || !Number.isFinite(detail.duration) || detail.duration <= 0) return { ...video, complete: false };
            const cid = id(detail.pages[0].cid);
            const player = await signed({ aid: video.aid, cid, isGaiaAvoided: 'false', web_location: '1315873' });
            const directory = await readJson(`${API}/x/player/wbi/v2?${player}`);
            if (id(directory?.aid) !== video.aid || id(directory?.cid) !== cid || directory.need_login_subtitle) return { ...video, complete: false };
            const tracks = directory.subtitle?.subtitles;
            if (!Array.isArray(tracks)) return { ...video, complete: false };
            const available = tracks.slice(0,32).filter((track: any) => track.subtitle_url || track.subtitle_url_v2);
            const track = available.find((v: any) => /^zh/u.test(v.lan)) || available.find((v: any) => v.lan === 'ai-zh') || available[0];
            if (!track) return { ...video, complete: false };
            const raw = track.subtitle_url || track.subtitle_url_v2;
            const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw), pathname = decodeURIComponent(url.pathname);
            if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
                || !['aisubtitle.hdslb.com','i0.hdslb.com','i1.hdslb.com','i2.hdslb.com'].includes(url.hostname)
                || !/^\/bfs\/(?:ai_subtitle|subtitle)\/[a-zA-Z0-9/_.-]+$/u.test(pathname) || pathname.includes('..')
                || pathname.startsWith('/bfs/ai_subtitle/prod/') && !pathname.startsWith(`/bfs/ai_subtitle/prod/${video.aid}${cid}`)) {
                return { ...video, complete: false };
            }
            const payload = await readJson(url.href, undefined, true), cues: CoverageCue[] = [];
            if (!Array.isArray(payload?.body) || !payload.body.length || payload.body.length > 10000) return { ...video, complete: false };
            for (const [index, row] of payload.body.entries()) {
                if (!Number.isFinite(row.from) || !Number.isFinite(row.to) || row.from < 0 || row.to <= row.from
                    || row.to > detail.duration + 5 || typeof row.content !== 'string' || !row.content.trim()
                    || row.content.length > 1000) return { ...video, complete: false };
                cues.push({ id: `P${index + 1}`, start: row.from, end: row.to, text: row.content });
            }
            return { ...video, duration: detail.duration, title: clean(detail.title, 200), description: clean(detail.desc, 3000),
                cues, complete: true };
        },
        has: async (action, video, receipt) => {
            target(video);
            if (action === 'repost') {
                const uid = id((await navigation()).mid);
                if (receipt && typeof receipt.dynamicId === 'string' && id(receipt.dynamicId)
                    && typeof receipt.originalDynamicId === 'string' && id(receipt.originalDynamicId)) {
                    const query = await signed({ id: receipt.dynamicId, timezone_offset: '-480', platform: 'web' });
                    const detail = await readJson(`${API}/x/polymer/web-dynamic/v1/detail?${query}`);
                    const item = detail?.item;
                    return item?.id_str === receipt.dynamicId && id(item?.modules?.module_author?.mid) === uid
                        && item.type === 'DYNAMIC_TYPE_FORWARD' && item.orig?.id_str === receipt.originalDynamicId
                        && archiveMatches(item.orig, video);
                }
                return Boolean(await findDynamic(uid, item => id(item?.modules?.module_author?.mid) === uid
                    && item.type === 'DYNAMIC_TYPE_FORWARD' && archiveMatches(item.orig, video)));
            }
            const endpoint = action === 'like' ? '/x/web-interface/archive/has/like' : '/x/v2/fav/video/favoured';
            const data = await readJson(`${API}${endpoint}?aid=${video.aid}`);
            if (action === 'like' && (data === 0 || data === 1)) return data === 1;
            if (action === 'favorite' && typeof data?.favoured === 'boolean') return data.favoured;
            throw new PeerPlatformUnavailable();
        },
        act: async (action, video, folder) => {
            target(video);
            if (!cookie || !csrf) throw new PeerPlatformUnavailable();
            if (video.ownerId === id((await navigation()).mid)) throw new Error('Peer support cannot target our own account');
            if (action === 'repost') {
                const dynamicId = await findDynamic(video.ownerId, item => archiveMatches(item, video));
                if (!dynamicId) throw new PeerPlatformUnavailable();
                const result = await readJson('https://api.vc.bilibili.com/dynamic_repost/v1/dynamic_repost/repost',
                    new URLSearchParams({ dynamic_id: dynamicId, content: '转发动态', extension: '{"emoji_type":1}', csrf }));
                const receipt = result?.dynamic_id_str;
                if (typeof receipt !== 'string' || !id(receipt)) throw new PeerPlatformUnavailable();
                return { dynamicId: receipt, originalDynamicId: dynamicId };
            }
            if (action === 'favorite' && !id(folder)) throw new Error('A verified favorite folder is required');
            const body = new URLSearchParams(action === 'like' ? { aid: video.aid, like: '1', csrf }
                : { rid: video.aid, type: '2', add_media_ids: folder!, del_media_ids: '', csrf });
            return readJson(`${API}${action === 'like' ? '/x/web-interface/archive/like' : '/x/v3/fav/resource/deal'}`, body);
        },
        defaultFolder: async video => {
            const uid = id((await navigation()).mid);
            const data = await readJson(`${API}/x/v3/fav/folder/created/list-all?up_mid=${uid}&type=2&rid=${video.aid}&web_location=333.1387`);
            if (!Array.isArray(data?.list)) throw new PeerPlatformUnavailable();
            const defaults = data.list.filter((row: any) => row.title === '默认收藏夹' && id(row.id)
                && (!row.mid || id(row.mid) === uid));
            if (defaults.length !== 1) throw new PeerPlatformUnavailable();
            return id(defaults[0].id);
        }
    };
}
