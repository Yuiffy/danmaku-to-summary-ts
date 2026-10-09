import { VoteDanmaku } from '../VoteSession';
import {
  busyQuestionMessage, formatQuestionAnswer, LiveQuestionConfig, parseLiveQuestion,
  QuestionAnnounce, QuestionAnswerer, QuestionAuthorize, QuestionRecordWriter, QuestionRequest,
  QUESTION_LIMITS, receivedQuestionMessage, unsafeQuestionText, validateQuestionConfig
} from './QuestionPolicy';

interface ActiveQuestion {
  request: QuestionRequest;
  controller: AbortController;
  valid: boolean;
  isRoomCurrent: () => boolean;
}

/** One admission owner for the entire bot, shared by all rooms. No pending task queue. */
export class LiveQuestionSession {
  private active: ActiveQuestion | null = null;
  private work = Promise.resolve();
  private stopped = false;
  private lastStartedAt = -Infinity;
  private lastNoticeAt = -Infinity;
  private readonly users = new Map<string, number>();
  private readonly hourlyStarts: number[] = [];
  private readonly limits;

  constructor(private readonly config: LiveQuestionConfig, private readonly answer: QuestionAnswerer,
    private readonly announce: QuestionAnnounce, private readonly botUid?: string, private readonly maxChars = 40,
    private readonly authorize: QuestionAuthorize = () => false, private readonly record?: QuestionRecordWriter) {
    validateQuestionConfig(config);
    this.limits = Object.fromEntries(Object.entries(QUESTION_LIMITS).map(([key, value]) =>
      [key, config[key as keyof typeof QUESTION_LIMITS] ?? value])) as Record<keyof typeof QUESTION_LIMITS, number>;
  }

  ingest(message: VoteDanmaku, isRoomCurrent: () => boolean, now = Date.now()): boolean {
    const question = parseLiveQuestion(message.text);
    if (!this.config.enabled || this.stopped || question === null || !message.roomId || !isRoomCurrent() ||
        !/^[1-9]\d*$/u.test(message.uid) || message.uid === this.botUid || !this.authorize(message.roomId, message.uid) ||
        !Number.isFinite(message.sentAt) || Math.abs(now - message.sentAt) > 10000 ||
        !Object.prototype.hasOwnProperty.call(this.config.recordingRoots, message.roomId)) return false;
    const notice = (text: string) => {
      if (now - this.lastNoticeAt < this.limits.noticeCooldownMs) return;
      this.lastNoticeAt = now;
      this.announce(message.roomId!, text, () => !this.stopped && isRoomCurrent());
    };
    if (this.active) {
      notice(busyQuestionMessage(this.active.request.question, this.maxChars));
      return true;
    }
    if (!question) {
      notice('鹿饼在，请发「@鹿饼 你的问题」。');
      return true;
    }
    if (unsafeQuestionText(question)) {
      notice('只查直播内容，请问录像相关问题。');
      return true;
    }
    while (this.hourlyStarts.length && now - this.hourlyStarts[0] >= 3600000) this.hourlyStarts.shift();
    for (const [uid, at] of this.users) if (now - at >= this.limits.userCooldownMs) this.users.delete(uid);
    if (now - this.lastStartedAt < this.limits.globalCooldownMs ||
        now - (this.users.get(message.uid) ?? -Infinity) < this.limits.userCooldownMs ||
        this.hourlyStarts.length >= this.limits.maxQuestionsPerHour) {
      notice('查询频率较高，请稍后再问。');
      return true;
    }
    const task: ActiveQuestion = {
      request: { roomId: message.roomId, uid: message.uid, question, askedAt: now },
      controller: new AbortController(), valid: true, isRoomCurrent
    };
    this.active = task; // Acquire synchronously before invoking asynchronous adapters.
    this.lastStartedAt = now;
    this.users.set(message.uid, now);
    this.hourlyStarts.push(now);
    const current = () => !this.stopped && task.valid && task.isRoomCurrent();
    this.announce(task.request.roomId, receivedQuestionMessage(question, this.maxChars), current);
    const timeout = setTimeout(() => {
      if (current()) this.announce(task.request.roomId, '这次查询超时了，请稍后再问。', () => !this.stopped && task.isRoomCurrent());
      task.valid = false;
      task.controller.abort();
    }, this.limits.timeoutMs);
    this.work = Promise.resolve().then(() => {
      if (!current()) return null;
      return this.answer(task.request, task.controller.signal);
    }).then(async result => {
      if (!result || !current()) return;
      clearTimeout(timeout);
      this.announce(task.request.roomId, formatQuestionAnswer(result, this.maxChars), current);
      if (this.record) {
        try { await this.record({ request: task.request, result }, task.controller.signal, current); }
        catch { console.error('Question evidence record was not confirmed; no automatic resend.'); }
      }
    }).catch(() => {
      if (current()) this.announce(task.request.roomId, '查询暂时失败了，请稍后再问。', current);
    }).finally(() => {
      clearTimeout(timeout);
      // Keep the lease until aborted work really settles, even for an uncooperative adapter.
      if (this.active === task) this.active = null;
    });
    return true;
  }

  cancelRoom(roomId: string): void {
    if (this.active?.request.roomId !== roomId) return;
    this.active.valid = false;
    this.active.controller.abort();
  }

  disconnect(): void {
    if (this.active) this.cancelRoom(this.active.request.roomId);
  }

  stop(): void { this.stopped = true; this.disconnect(); }
  flush(): Promise<void> { return this.work; }
}
