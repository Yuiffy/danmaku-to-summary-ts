export interface DanmakuAttribution {
  messageType?: 'danmaku' | 'superchat';
  senderName?: string;
  senderUid?: string;
  /** Beijing timestamp. SC wall clock is reconstructed from recorder start + relative offset. */
  sentAt?: string;
  sentAtBasis?: 'message' | 'recording_start';
}
export interface DanmakuCue extends DanmakuAttribution { seconds: number; text: string }

function decode(text: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  // Decode once; no document/entity resolver or recursive expansion.
  return text.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/giu, (entity, name: string) => {
    if (!name.startsWith('#')) return entities[name] ?? entity;
    const code = /^#x/iu.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
function plain(text: string): string {
  return decode(text).normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'u').exec(attributes)?.[2];
}
function beijingTime(at: number): string | undefined {
  return Number.isFinite(at) && at >= 1e11 && at < 1e14 ? new Date(at + 8 * 3600000).toISOString().replace('Z', '+08:00') : undefined;
}

/** Cheap conservative prefilter: use the same decoded text as parsing, without decoding author/time fields. */
export function hasDanmakuText(content: string, matches: (text: string) => number): boolean {
  for (const record of content.matchAll(/<(d|sc)\s+([^<>]*)>([^<]*)<\/\1>/gu)) {
    if (matches(plain(record[3]).slice(0, 1000))) return true;
  }
  return false;
}

/** Literal d/SC records only; recorder markup and external entity declarations are never executed. */
export function parseDanmaku(content: string, botUid?: string): DanmakuCue[] {
  const info = /<BililiveRecorderRecordInfo\b([^<>]*)\/?\s*>/u.exec(content)?.[1];
  const start = info && attribute(info, 'start_time');
  const startedAt = start && /(?:Z|[+-]\d{2}:\d{2})$/u.test(start) ? Date.parse(decode(start)) : NaN;
  const result: DanmakuCue[] = [];
  for (const match of content.matchAll(/<(d|sc)\s+([^<>]*)>([^<]*)<\/\1>/gu)) {
    const fields = attribute(match[2], 'p')?.split(',');
    const offset = match[1] === 'sc' ? attribute(match[2], 'ts') : fields?.[0];
    const seconds = offset === undefined || !offset.trim() ? NaN : Number(offset);
    const uid = match[1] === 'sc' ? attribute(match[2], 'uid') : fields?.[6];
    if (botUid && uid === botUid || !Number.isFinite(seconds) || seconds < 0) continue;
    const text = plain(match[3]).slice(0, 1000);
    if (!text || /^@鹿饼/u.test(text) || /^鹿饼(?:收到|答[:：])/u.test(text)) continue;
    const senderName = plain(attribute(match[2], 'user') || '').slice(0, 80);
    const epoch = Number(fields?.[4]);
    const messageTime = match[1] === 'd' ? beijingTime(epoch >= 1e9 && epoch < 1e11 ? epoch * 1000 : epoch) : undefined;
    const sentAt = messageTime || beijingTime(startedAt + seconds * 1000);
    result.push({ seconds, text, messageType: match[1] === 'sc' ? 'superchat' : 'danmaku',
      ...(senderName ? { senderName } : {}), ...(uid && /^[1-9]\d*$/u.test(uid) ? { senderUid: uid } : {}),
      ...(sentAt ? { sentAt, sentAtBasis: messageTime ? 'message' : 'recording_start' } : {}) });
  }
  return result;
}
