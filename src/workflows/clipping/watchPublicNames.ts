type Event = Record<string, any>;
export const WATCH_PUBLIC_TAGS = ['岁己', '小岁', '同步视听', '虚拟主播'];
const aliases: Array<[RegExp, string]> = [
  [/银河护卫队/gu, '宇宙蹦迪天团'], [/奇异博士/gu, '卷毛医生在线画圈'],
  [/复仇者联盟|复联/gu, '地球保安大队'], [/雷神/gu, '锤子哥'],
  [/蚁人/gu, '变小打工人'],
];
const normalize = (value: string) => value.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const unknown = /^(待确认片名|电影同看|剧集同看|本场同看|同步视听)$/u;

/** Editorial aliases never replace the evidenced internal work identity. */
export function publicWatchName(event: Event): string {
  const name = String(event.name || '').trim();
  if (!name || unknown.test(name)) return '待确认化名';
  let candidate = name;
  for (const [pattern, alias] of aliases) candidate = candidate.replace(pattern, alias);
  if (candidate === name) candidate = String(event.publicName || '').trim();
  if (!candidate || candidate.length > 48 || /[\r\n《》]/u.test(candidate) || unknown.test(candidate)
    || normalize(candidate).includes(normalize(name))) return '待确认化名';
  return candidate;
}

export function watchPublicNames(events: Event[]): Event[] {
  return events.map(event => ({ activityId: event.id, name: event.name || null, publicName: publicWatchName(event) }));
}

/** Replace titles even inside the original stream title used in public descriptions. */
export function watchPublicText(text: string, events: Event[]): string {
  let result = String(text || '');
  for (const event of [...events].sort((a, b) => String(b.name || '').length - String(a.name || '').length)) {
    if (event.name) result = result.split(event.name).join(publicWatchName(event));
  }
  for (const [pattern, alias] of aliases) result = result.replace(pattern, alias);
  return result;
}
