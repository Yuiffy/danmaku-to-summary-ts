import { createLiveQuestionAnswerer } from '../questions/DaiyuQuestionClient';
import { parseEvidenceQuery, questionRooms, queryRecordingEvidence, QuestionRuntime, readQuestionRuntime, validateLabQuestion } from '../questions/EvidenceQuery';
import { QuestionAnswerer } from '../questions/QuestionPolicy';
import { LabGate } from './LabGate';

/** Private workspace queries reuse bounded evidence tools and never import publication adapters. */
export class AdminQueries {
  constructor(private readonly runtime: () => Promise<QuestionRuntime>, private readonly gate = new LabGate(),
    private readonly search = queryRecordingEvidence, private readonly answerer: (runtime: QuestionRuntime) => QuestionAnswerer =
      runtime => createLiveQuestionAnswerer(runtime.questions, runtime.botUid)!) {}
  static fromFile(file: string): AdminQueries { return new AdminQueries(() => readQuestionRuntime(file)); }
  async rooms(): Promise<{ roomId: string; name: string }[]> { return questionRooms(await this.runtime()); }
  async query(mode: 'ask' | 'search', body: unknown, signal: AbortSignal): Promise<unknown> {
    const runtime = await this.runtime();
    const input = mode === 'search' ? parseEvidenceQuery(body, runtime.questions) : validateLabQuestion(body, runtime.questions);
    if (mode === 'ask' && Object.keys(body as object).some(key => !['roomId', 'question'].includes(key))) throw new Error('Unknown question fields');
    return this.gate.run<unknown>(inner => mode === 'search' ? this.search(runtime, parseEvidenceQuery(body, runtime.questions), inner) :
      this.answerer(runtime)({ ...input, uid: 'local-admin', askedAt: Date.now() }, inner), signal);
  }
  stop(): void { this.gate.stop(); }
}
