import * as path from 'path';

const normalized = (text: string): string => text.normalize('NFKC').toLowerCase();

export function validTitleTerms(value: unknown): value is string[] | null | undefined {
  return value == null || Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every(term =>
    typeof term === 'string' && !!term.trim() && Array.from(term).length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(term));
}

/** Titles locate sources; they never supply a factual answer or speaker identity. */
export function matchesRecordingTitle(file: string, terms: string[]): boolean {
  const title = normalized(path.basename(file));
  return terms.some(term => title.includes(normalized(term.trim())));
}

/** A known event label should not crowd the requested detail out of the body recall. */
export function recordingDetailTerms(terms: string[], titles?: string[] | null): string[] {
  const details = terms.filter(term => !titles?.some(title => normalized(term.trim()).includes(normalized(title.trim()))));
  return details.length ? details : terms;
}

/** Only explicit event wording triggers a title refinement, without guessing a date or person. */
export function eventTitleTerms(question: string): string[] {
  const matches = normalized(question).matchAll(/(新衣(?:装|服)?|生日|周年|纪念|3d|首播|出道|毕业|耐久|联动)(?:回|发布(?:会)?|披露|直播|那场)/gu);
  return [...new Set([...matches].map(match => match[1].startsWith('新衣') ? '新衣' : match[1]))].slice(0, 3);
}

/** Compound ASR wording can omit the object or misrecognize the invited person's name. */
export function recordingActionTerms(question: string): string[] {
  if (!/录(?:语音|音|歌|制|视频)|配音/u.test(question)) return [];
  return /[叫让请找].{0,12}(?:录|配音)/u.test(question) ? ['录', '找'] : ['录'];
}
