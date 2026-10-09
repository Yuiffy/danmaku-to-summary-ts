import * as path from 'path';
import { LiveQuestionConfig } from './QuestionPolicy';

export interface QuestionRoom { roomId: string; name: string; aliases: string[] }
export function configuredQuestionRooms(config: LiveQuestionConfig): QuestionRoom[] {
  return Object.entries(config.recordingRoots).map(([roomId, roots]) => {
    const name = path.basename(roots[0]).replace(new RegExp(`^${roomId}[_ -]*`, 'u'), '') || roomId;
    const chinese = /^[\p{Script=Han}]{2,}/u.exec(name)?.[0];
    const aliases = [...new Set([name, ...(chinese ? [chinese] : []), ...(config.roomAliases?.[roomId] || [])])];
    return { roomId, name, aliases };
  });
}

/** Only explicit configured identities select other rooms; no paths or model-generated room IDs. */
export function questionScope(config: LiveQuestionConfig, current: string, question: string): QuestionRoom[] {
  const rooms = configuredQuestionRooms(config), local = rooms.find(room => room.roomId === current);
  if (!local) throw new Error('Question room is outside the configured corpus');
  const normalized = question.normalize('NFKC').toLowerCase();
  const selected = rooms.filter(room => room.aliases.some(alias => {
    const value = alias.normalize('NFKC').toLowerCase();
    if (/^[a-z0-9_ -]+$/u.test(value)) return normalized.split(/[^a-z0-9_ -]+/u).some(part => part.split(/\s+/u).includes(value));
    return normalized.includes(value);
  }) || new RegExp(`(?:房间|直播间)\\s*${room.roomId}(?!\\d)`, 'u').test(normalized));
  if (!selected.length) return [local];
  if (/(?:我|你|咱|本|这里|这边).{0,5}(?:和|跟|比)|(?:和|跟|比).{0,5}(?:我|你|咱|本直播间|这里|这边)/u.test(normalized) && !selected.includes(local)) selected.unshift(local);
  if (selected.length > 3) throw new Error('At most three explicitly named rooms per question');
  return selected;
}

export function isGiftQuestion(text: string): boolean {
  return /舰礼|舰长|提督|总督|上舰|舰队|大航海|月礼/u.test(text.normalize('NFKC'));
}
export function expandGiftTerms(terms: string[]): string[] {
  const normalized = terms.map(term => term.normalize('NFKC').trim().toLowerCase());
  return [...new Set([...normalized, ...(isGiftQuestion(normalized.join(' ')) ? ['舰礼', '舰长', '提督', '总督', '礼物'] : [])])];
}
export function embeddingQuestion(question: string): string {
  return isGiftQuestion(question) ? `${question} 舰礼指舰长、提督、总督各档位的月度礼物与领取条件。` : question;
}
