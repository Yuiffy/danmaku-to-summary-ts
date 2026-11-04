import { QuestionRuntime } from '../live-vote/questions/EvidenceQuery';
import { createQuestionReadFactory, QuestionReadFactory, QuestionReadSession, QuestionReadTool } from '../live-vote/questions/QuestionReadTools';
import { PublicSearchFactory } from '../live-vote/questions/PublicSearchRuntime';
import { QQConfig } from './QQPolicy';

export type QQReadTool = QuestionReadTool;
export type QQQuestionTools = QuestionReadSession;
export type QQKnowledge = QuestionReadFactory;
export const QQ_QUESTION_ROOM_LIMIT = 8;

/** Preserve QQ's admission/scope contract while sharing read-only capabilities with other channels. */
export function createQQKnowledge(runtime: QuestionRuntime, config: NonNullable<QQConfig['knowledge']>, publicSearch?: PublicSearchFactory): QQKnowledge {
  return createQuestionReadFactory(runtime, config, publicSearch, QQ_QUESTION_ROOM_LIMIT);
}
