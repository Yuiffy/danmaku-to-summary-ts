import { createHash } from 'crypto';
import { CommentAudience, positiveId } from './CommentPolicy';
import { safeEvidenceText } from './CommentContext';

type Read = (url: string, signal: AbortSignal) => Promise<any>;
// WBI permutation used by the web client and bilibili-api-python's _get_mixin_key.
const ORDER = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];

/** Fixed signed profile GET, no signature refresh/retry after a platform refusal. */
export function createAudienceReader(botUid: string, read: Read, now = Date.now) {
  let signing: { key: string; at: number } | undefined;
  let medals: { rows: any[]; at: number } | undefined;
  return async (uid: string, signal: AbortSignal): Promise<CommentAudience> => {
    if (!positiveId(uid)) throw new Error('Invalid comment audience UID');
    if (!signing || now() - signing.at >= 300000) {
      const nav = await read('https://api.bilibili.com/x/web-interface/nav', signal);
      const keys = ['img_url', 'sub_url'].map(field => {
        const value = nav.wbi_img?.[field];
        // These strings supply key material only; never follow either URL.
        return typeof value === 'string' ? /\/([a-f\d]{32})\.[a-z]+(?:\?.*)?$/iu.exec(value)?.[1] : undefined;
      });
      if (keys.some(key => !key)) return { status: 'unavailable' };
      const joined = keys.join('');
      signing = { key: ORDER.map(index => joined[index]).join(''), at: now() };
    }
    const params = new URLSearchParams({ mid: uid, web_location: '1550101', wts: String(Math.floor(now() / 1000)) });
    params.set('w_rid', createHash('md5').update(params.toString() + signing.key).digest('hex'));
    const profile = await read(`https://api.bilibili.com/x/space/wbi/acc/info?${params}`, signal);
    if (positiveId(profile.mid) !== uid) return { status: 'unavailable' };
    const fan = profile.fans_medal;
    if (fan?.show !== true || typeof fan.wear !== 'boolean') return { status: 'unavailable' };
    if (!fan.wear) return { status: 'available' };
    const name = typeof fan.medal?.medal_name === 'string' ? safeEvidenceText(fan.medal.medal_name, 20) : '';
    if (!name) return { status: 'unavailable' };
    const direct = positiveId(fan.medal?.target_id);
    if (direct) return { status: 'available', wearing: { anchorUid: direct, name } };
    // Current profile omits the anchor UID. Resolve its numeric medal ID using a
    // platform-bound catalogue; catalogue ownership alone never proves wearing.
    const id = positiveId(fan.detail?.medal_id);
    if (!id || positiveId(fan.detail?.uid) !== uid || fan.detail.medal_name !== fan.medal.medal_name) return { status: 'unavailable' };
    if (!medals || now() - medals.at >= 3600000) {
      const wall = await read(`https://api.live.bilibili.com/xlive/web-ucenter/user/MedalWall?target_id=${botUid}`, signal);
      if (positiveId(wall.uid) !== botUid || !Array.isArray(wall.list) || wall.list.length > 1000 ||
        wall.close_space_medal === 1 || wall.close_space_medal === true) return { status: 'unavailable' };
      medals = { rows: wall.list.map((row: any) => row?.medal_info), at: now() };
    }
    const matches = medals.rows.filter(row => positiveId(row?.medal_id) === id);
    const anchorUid = matches.length === 1 && matches[0].medal_name === fan.medal.medal_name && positiveId(matches[0].target_id);
    return anchorUid ? { status: 'available', wearing: { anchorUid, name } } : { status: 'unavailable' };
  };
}
