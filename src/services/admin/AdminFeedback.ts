import { AdminJob } from '../../core/admin/contracts';
import { AdminClipStore } from './AdminClipStore';
import { AdminJobs, CommandRunner } from './AdminJobs';
import { AdminError } from './AdminFiles';
import { AdminFeedbackSession } from './AdminFeedbackSession';
import { FeedbackAgentRunner } from './AdminFeedbackAgent';
import { ACTIVITY_TITLE_EVIDENCE_ERROR, feedbackPrompt, FeedbackPlan, FeedbackPlanner, isUnchangedReview, missingFeedbackFields, parseFeedbackPlan } from './AdminFeedbackPolicy';

/** One saved operator intent; all media/review/queue mutations remain with the existing CLIs. */
export class AdminFeedback {
  constructor(private readonly clips: AdminClipStore, private readonly jobs: AdminJobs,
    private readonly run: CommandRunner, private readonly plan: FeedbackPlanner, private readonly agent?: FeedbackAgentRunner,
    private readonly directFeedback = true) {}

  submit(id: string, body: any): AdminJob {
    if (body.publishApproved !== true) throw new AdminError('请明确授权修改完成后投稿');
    if (typeof body.note !== 'string' || !body.note.trim() || body.note.length > 1000 || body.note.includes('\0')) throw new AdminError('请填写修改意见（最多 1000 字）');
    const note = body.note.trim(), revision = body.revision;
    const validate = () => {
      if (this.clips.detail(id).revision !== revision) throw new AdminError('视频或审核内容已变化，请刷新后再提交', 409);
      this.assertEditable(id);
    };
    validate();
    const edits: Record<string, unknown> = {};
    for (const key of ['title', 'description', 'coverText']) if (body[key] !== undefined) {
      if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > (key === 'description' ? 10000 : 300)) throw new AdminError(`修改后的 ${key} 无效`);
      edits[key] = body[key];
    }
    if (body.sourceKind) {
      if (!['live_speech', 'recount', 'playback', 'audience'].includes(body.sourceKind)) throw new AdminError('内容归属无效');
      edits.sourceKind = body.sourceKind;
    }
    const previous = this.jobs.latest('feedback-publish', id);
    if (previous && ['queued', 'running'].includes(previous.status)) {
      if (previous.note !== note || JSON.stringify(previous.edits || {}) !== JSON.stringify(edits)) throw new AdminError('此切片正在处理已有意见，请等处理结束后再补充', 409);
      return structuredClone(previous);
    }
    return this.jobs.submitOperation('feedback-publish', id, { note, revision, edits, titleChoice: body.titleChoice }, async (output, update) => {
      const initial = this.clips.feedbackDetail(id);
      if (initial.category !== 'clip' && Object.keys(edits).length) throw new AdminError('完整包文案修改需要专用包装流程；意见已保存，未入队');
      const unchangedReview = !Object.keys(edits).length && isUnchangedReview(note);
      const publishCurrent = this.directFeedback && /^(?:投|投稿)[。.!！]?$/u.test(note);
      const session = new AdminFeedbackSession(id, note, revision, edits, this.clips, this.run, output, update, () => this.assertEditable(id), this.directFeedback);
      if (this.agent && !unchangedReview && !publishCurrent) {
        await this.agent(session, initial, edits, (phase, detail) => { update({ phase }); output(`\n${phase}${detail ? `：${detail}` : ''}\n`); });
        return 0;
      }
      let plan: FeedbackPlan = {};
      if (!unchangedReview && !publishCurrent) {
        update({ phase: '正在理解修改意见' });
        const raw = await this.plan(feedbackPrompt(initial, note, edits));
        validate(); // Also catch edits made while the model was planning.
        try { plan = parseFeedbackPlan(raw, initial, note); }
        catch (error) {
          if (initial.category !== 'activity' || !(error instanceof AdminError) || error.message !== ACTIVITY_TITLE_EVIDENCE_ERROR) throw error;
          update({ phase: '正在核对作品名称的原文引用' });
          output('\n名称引用未通过校验，正在按原文修正计划。\n');
          const repaired = await this.plan(`${feedbackPrompt(initial, note, edits)}\n上一份名称计划未执行，原文引用校验失败：${error.message}。仅使用对应活动附近 titleContext 的真实 index 和逐字 sourceAlias；已有正确名称不用重改。上一份无效答复：${JSON.stringify(raw)}`);
          validate(); plan = parseFeedbackPlan(repaired, initial, note);
        }
        const missing = missingFeedbackFields({ ...plan, ...edits }, initial, this.directFeedback);
        if (missing.length) {
          update({ phase: '正在补齐修改计划', plan: { ...plan } });
          const repaired = await this.plan(`${feedbackPrompt(initial, note, edits)}\n上一份计划缺少执行必需字段：${missing.join('；')}。回查已提供的完整上下文补齐，不借机更换用户看点。上一份计划：${JSON.stringify(plan)}`);
          validate(); plan = parseFeedbackPlan(repaired, initial, note);
          if (missingFeedbackFields({ ...plan, ...edits }, initial, this.directFeedback).length) throw new AdminError('修改计划缺少执行必需字段；意见已保存，未入队');
        }
      }
      Object.assign(plan, edits);
      update({ plan: { ...plan, ...(unchangedReview ? { reviewMode: 'human' } : {}) } });
      if (plan.blockedReason) throw new AdminError(plan.blockedReason);
      await session.revise(plan, unchangedReview);
      await session.enqueue();
      return 0;
    }, validate);
  }

  private assertEditable(id: string): void {
    const clip = this.clips.record(id);
    if (clip.status === 'uploaded' || clip.uploadState?.bvid) throw new AdminError('已投稿视频不能再次入队');
    if (clip.editorialExclusion) throw new AdminError('此切片已排除，不能投稿');
    if (this.clips.hasActiveUpload(id)) throw new AdminError('此切片已在投稿队列，由现有 worker 处理');
  }
}
