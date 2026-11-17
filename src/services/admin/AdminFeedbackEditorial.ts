import { AdminError } from './AdminFiles';

/** Keep explicit editorial requests from disappearing into an unrelated copy edit. */
export function editorialRequest(note: string): { precision: boolean; coordinate: boolean; alternative: boolean } {
  const clauses = note.split(/[，,。；;\n]/u).filter(text => !/不要|不用|无需|不必|别再/u.test(text));
  return { precision: clauses.some(text => /精切|精剪/u.test(text)),
    coordinate: clauses.some(text => /(?:评论区?|坐标).*(?:坐标|时间戳)|(?:发|加|补|留).{0,8}坐标/u.test(text)),
    alternative: /或者|或是|二选一/u.test(note) };
}

export function assertEditorialFulfilled(note: string, precision: boolean, coordinate: boolean): void {
  const request = editorialRequest(note);
  if (request.alternative && request.precision && request.coordinate && (precision || coordinate)) return;
  if (request.precision && !precision || request.coordinate && !coordinate) {
    throw new AdminError('用户要求的精切或坐标评论尚未落实，不能仅改文案后投稿');
  }
}
