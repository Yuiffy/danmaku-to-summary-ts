import { unsafeComment } from '../bilibili/comment-replies/CommentPolicy';
import { boundedReadEvidence } from '../live-vote/questions/ReadToolEvidence';
export { collectReadCitations as collectQQCitations } from '../live-vote/questions/ReadToolEvidence';

export function boundedQQEvidence(input: unknown, maxBytes = 6000) {
  return boundedReadEvidence(input, maxBytes, unsafeComment);
}
