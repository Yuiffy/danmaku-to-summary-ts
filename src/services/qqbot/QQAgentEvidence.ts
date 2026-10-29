import { unsafeComment } from '../bilibili/comment-replies/CommentPolicy';

/** Preserve complete rows and coverage metadata, then bound arrays rather than slicing serialized JSON. */
export function boundedQQEvidence(input: unknown, maxBytes = 6000): { data: unknown; truncated: boolean } {
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') return unsafeComment(value) ? '[不可用资料]' : value.slice(0, 700);
    if (Array.isArray(value)) return value.slice(0, 32).map(clean);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    return value;
  };
  const data = clean(input);
  let truncated = JSON.stringify(data) !== JSON.stringify(input);
  const arrays: unknown[][] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { arrays.push(value); value.forEach(visit); }
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(data);
  while (Buffer.byteLength(JSON.stringify(data), 'utf8') > maxBytes) {
    const longest = arrays.filter(items => items.length > 1).sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    if (!longest) return { data: { limited: true, notice: '资料超过单步预算，请缩小范围或分页读取。' }, truncated: true };
    longest.pop(); truncated = true;
  }
  return { data, truncated };
}

export function collectQQCitations(value: unknown, citations: Set<string>): void {
  if (Array.isArray(value)) value.forEach(item => collectQQCitations(item, citations));
  else if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    if (typeof row.evidenceId === 'string' &&
        ['text', 'excerpt'].some(key => typeof row[key] === 'string' && row[key] !== '[不可用资料]' && (row[key] as string).trim())) {
      citations.add(row.evidenceId);
    }
    Object.values(row).forEach(item => collectQQCitations(item, citations));
  }
}
