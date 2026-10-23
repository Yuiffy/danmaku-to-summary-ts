import { AdminJob } from '../../core/admin/contracts';
import { AdminClipStore } from './AdminClipStore';
import { CommandRunner } from './AdminJobs';
import { AdminError } from './AdminFiles';
import { bundleCommand, clipCommand, OperatorCommand } from './AdminCommandPolicy';
import { FeedbackPlan, missingFeedbackFields, parseFeedbackPlan } from './AdminFeedbackPolicy';
import { activityRepairCommand } from './AdminWorkflowPolicy';

/** One revision-bound edit session. Tools can inspect results, but cannot grant their own approval. */
export class AdminFeedbackSession {
  private expected: string;
  private reviewed = false;
  private requestedTitle?: string;
  private attempts = 0;
  private queued = false;
  private songEvidencePath?: string;
  private boundaryAttempts = 0;
  constructor(readonly id: string, readonly note: string, revision: string,
    private readonly edits: Record<string, unknown>, private readonly clips: AdminClipStore,
    private readonly run: CommandRunner, private readonly output: (text: string) => void,
    private readonly update: (value: Pick<AdminJob, 'phase' | 'plan'>) => void,
    private readonly assertEditable: () => void, readonly directFeedback = false) { this.expected = revision; }

  validate(): void {
    if (this.clips.detail(this.id).revision !== this.expected) throw new AdminError('切片在处理期间被外部修改，已停止，未继续投稿', 409);
    this.assertEditable();
  }
  inspect(): Record<string, unknown> {
    this.validate();
    const detail = this.clips.feedbackDetail(this.id);
    const reviewDetails = Object.fromEntries(['publication', 'attribution', 'activity'].map(kind => {
      const review = detail.evidence[`${kind}Review`];
      return [kind, review ? { status: review.status, issues: review.issues, reason: review.reason,
        humanChecks: review.humanChecks, checks: review.checks } : undefined];
    }));
    return { id: this.id, category: detail.category, title: detail.title, description: detail.description,
      coverText: detail.coverText, requestedTitle: this.requestedTitle, status: detail.clip.status,
      issues: detail.clip.issues, pendingCut: detail.clip.pendingCut, sourceKind: detail.evidence.sourceKind,
      pendingRebuild: detail.pendingRebuild, media: detail.media, cover: detail.cover,
      review: { publication: detail.evidence.publicationReview?.issues, attribution: detail.evidence.attributionReview?.issues,
        activity: detail.evidence.activityReview?.issues, preflight: detail.evidence.aiReview,
        recovery: detail.evidence.candidateRecovery },
      reviewDetails,
      ...(detail.category === 'activity' ? { activities: this.clips.feedbackDetail(this.id).evidence.activities } : {}),
      reviewed: this.reviewed, ready: this.ready() };
  }
  context(): ReturnType<AdminClipStore['feedbackDetail']> { this.validate(); return this.clips.feedbackDetail(this.id); }
  async repairBoundaries(reviewPrelude = false, reviewAudio = false): Promise<Record<string, unknown>> {
    this.validate();
    const detail = this.clips.feedbackDetail(this.id);
    if (detail.category !== 'activity' || ++this.boundaryAttempts > 1) throw new AdminError('活动边界每次反馈最多独立修复一次');
    const metadata = this.clips.metadata(this.clips.record(this.id));
    const source = metadata.source;
    const body = { action: 'retry-boundaries', kind: metadata.kind, note: this.note, reviewPrelude, reviewAudio,
      mediaPath: this.clips.checkedInput(source?.mediaPath, ['.flv', '.mp4', '.mkv', '.ts', '.webm']),
      srtPath: this.clips.checkedInput(source?.srtPath, ['.srt']),
      ...(source?.xmlPath ? { xmlPath: this.clips.checkedInput(source.xmlPath, ['.xml']) } : {}) };
    this.reviewed = false;
    await this.step('正在独立核验并修复活动边界', activityRepairCommand(this.id, body));
    return this.inspect();
  }
  async identifySongs(activityId?: string): Promise<Record<string, unknown>> {
    this.validate();
    const detail = this.clips.feedbackDetail(this.id);
    if (detail.category !== 'activity' || detail.evidence.kind !== 'songs'
      || activityId && !detail.evidence.activities?.some((event: any) => event.id === activityId)) throw new AdminError('请选择此投稿包中的歌曲');
    const metadataPath = this.clips.checkedInput(this.clips.record(this.id).metadataPath, ['.json']);
    let captured = '';
    this.update({ phase: '正在结合弹幕、歌词搜索歌名' });
    const code = await this.run(bundleCommand(this.id, { action: 'identify-songs', activityId, hint: this.note }, 'activity', metadataPath),
      chunk => { captured = (captured + chunk).slice(-128000); this.output(chunk); });
    this.validate();
    if (code !== 0) throw new AdminError('歌名检索未完成，原意见和当前成片保留');
    const marker = captured.split(/\r?\n/u).find(line => line.startsWith('ACTIVITY_SONG_IDENTIFICATION_RESULT '));
    if (!marker) throw new AdminError('歌名检索没有返回有效结果');
    const result = JSON.parse(marker.slice('ACTIVITY_SONG_IDENTIFICATION_RESULT '.length));
    if (result.identified?.length) this.songEvidencePath = this.clips.checkedInput(result.evidencePath, ['.json']);
    const { evidencePath: _privatePath, ...summary } = result;
    return summary;
  }
  private ready(): boolean {
    const record = this.clips.record(this.id), detail = this.clips.detail(this.id);
    return !!(this.reviewed && detail.media && detail.cover && !detail.pendingRebuild && !record.pendingCut
      && !record.reviewPending && !record.editorialExclusion
      && (!this.requestedTitle || detail.title === this.requestedTitle));
  }
  private async step(phase: string, command: OperatorCommand): Promise<void> {
    this.validate(); this.update({ phase }); this.output(`\n${phase}\n`);
    const code = await this.run(command, this.output);
    // The existing CLI owns the locked mutation and may persist a failed review/revision.
    this.expected = this.clips.detail(this.id).revision;
    if (code !== 0) {
      const recovery = this.clips.feedbackDetail(this.id).evidence.candidateRecovery;
      const reason = recovery?.status === 'failed' && typeof recovery.error === 'string' ? `：${recovery.error.slice(0, 2000)}` : '';
      throw new AdminError(`${phase}失败（退出码 ${code}）${reason}，意见已保存；未继续投稿`);
    }
  }
  async revise(raw: unknown, humanReview = false): Promise<Record<string, unknown>> {
    this.validate();
    if (++this.attempts > 3) throw new AdminError('本次已完成三轮修改复核，仍未解决的问题已保存');
    const initial = this.clips.feedbackDetail(this.id);
    const plan: FeedbackPlan = { ...parseFeedbackPlan(JSON.stringify(raw), initial, this.note), ...this.edits };
    if (plan.blockedReason) throw new AdminError(plan.blockedReason);
    const missing = missingFeedbackFields(plan, initial, this.directFeedback);
    if (!humanReview && missing.length) throw new AdminError(`修改计划缺少：${missing.join('；')}`);
    this.reviewed = false;
    this.update({ plan: { ...plan, ...(humanReview ? { reviewMode: 'human' } : {}) } });
    if (initial.category === 'clip') {
      const copy = { title: plan.title || initial.title, description: plan.description || initial.description,
        coverText: plan.coverText || initial.coverText, ...this.edits };
      this.requestedTitle = copy.title as string;
      const record = this.clips.record(this.id), metadata = this.clips.metadata(record);
      const sourceKind = plan.sourceKind || initial.evidence.sourceKind || (this.directFeedback ? 'live_speech' : undefined);
      if (!sourceKind && !record.pendingCut) throw new AdminError('需根据现有证据确认发言、转述或播放内容的归属');
      if (humanReview || this.directFeedback && initial.media && !metadata.selectionRejection && !initial.pendingRebuild && !record.pendingCut
        && plan.start === undefined && !plan.corrections?.length
        // A title edit changes public copy and the reviewed cover, not video timing.
        // In particular, highlight-first subtitles use the composed timeline.
        && ['description', 'coverText'].every(key => !plan[key as keyof FeedbackPlan] || plan[key as keyof FeedbackPlan] === initial[key as keyof typeof initial])) {
        if (initial.pendingRebuild) throw new AdminError('存在待制作修订，不能批准旧成片；请先完成该修订');
        if (!initial.media || !initial.mediaSubtitles || record.pendingCut) throw new AdminError('尚无完整成片可供人工确认；请先制作并核对');
        const approve = clipCommand(this.id, { action: 'approve-review', note: this.note, ...copy, sourceKind });
        if (this.directFeedback) approve.args.push('--feedback-authorized');
        await this.step(this.directFeedback ? '正在保存反馈直投授权' : '正在保存人工审核并校验成片', approve);
      } else {
        if (!this.directFeedback && record.pendingCut && plan.sourceKind && plan.sourceKind !== initial.evidence.sourceKind) {
          throw new AdminError('未制作的关键词候选暂不支持此次归属修改；意见已保存，未入队');
        }
        if (!record.pendingCut || plan.start !== undefined) {
          const rejectedWindow = this.directFeedback && metadata.selectionRejection
            ? this.clips.sourceWindow(record, metadata) || metadata.reviewPresentation?.window || {} : {};
          const command = clipCommand(this.id, { action: 'rebuild', note: this.note, ...copy, sourceKind,
            start: plan.start ?? rejectedWindow.start, end: plan.end ?? rejectedWindow.end });
          if (this.directFeedback) command.args.push('--feedback-authorized');
          if (!record.pendingCut) command.args.push('--allow-long', '--allow-short', '--duration-note', plan.durationNote || `按用户意见保留完整主题并独立复核起因和收尾：${this.note}`);
          if (record.pendingCut || metadata.selectionRejection && metadata.selectionRejection.reason !== 'duration_out_of_bounds') {
            if (plan.start === undefined && !this.directFeedback) throw new AdminError('被剔除的片段需要明确新的完整范围；意见已保存，未入队');
            command.args.push('--replan');
          }
          await this.step('正在准备修改', command);
        }
        for (const correction of plan.corrections || []) {
          const current = this.clips.metadata(this.clips.record(this.id));
          const draft = current.renderedSubtitles || current.candidateSubtitles;
          const cues = draft?.cues?.filter((_cue: unknown, index: number) => correction.cue === undefined || correction.cue === index + 1) || [];
          const currentText = cues.map((cue: any) => cue.text).join('');
          if (this.directFeedback && currentText && !currentText.includes(correction.from) && currentText.includes(correction.to)) continue;
          await this.step('正在修改字幕', clipCommand(this.id, { action: 'correct', note: this.note, ...correction }));
        }
        const cut = clipCommand(this.id, { action: 'cut', note: this.note, ...(record.pendingCut ? copy : {}) });
        cut.args.push(this.directFeedback ? '--feedback-authorized' : '--automatic-review');
        await this.step(this.directFeedback ? '正在按反馈制作成片' : '正在制作并复核成片', cut);
      }
    } else {
      const metadataPath = this.clips.checkedInput(this.clips.record(this.id).metadataPath, ['.json']);
      if (initial.category === 'activity' && plan.activityTitles) {
        const titleEvidencePath = this.clips.feedbackTitleInput(this.id, plan.activityTitles);
        await this.step('正在修改歌名、封面和分 P 文案', bundleCommand(this.id, { action: 'restyle', titleEvidencePath }, 'activity', metadataPath));
      }
      if (initial.category === 'activity' && plan.useIdentifiedSongNames) {
        if (!this.songEvidencePath) throw new AdminError('请先用歌名检索工具得到有歌词支持的识别结果');
        await this.step('正在应用核验后的歌名和包装', bundleCommand(this.id, { action: 'restyle', titleEvidencePath: this.songEvidencePath }, 'activity', metadataPath));
      }
      if (!humanReview && !this.directFeedback && initial.category === 'game') throw new AdminError('游戏包需要专用完整成片审核；不能把自动分析登记为人工审核');
      await this.step('正在核验完整投稿包', bundleCommand(this.id,
        { action: humanReview || this.directFeedback ? 'approve-review' : 'automatic-review', note: this.note,
          feedbackAuthorized: this.directFeedback }, initial.category, metadataPath));
    }
    this.reviewed = true;
    const result = this.inspect();
    if (this.requestedTitle && result.title !== this.requestedTitle) {
      result.issues = [...(result.issues as string[]), '制作或复核结果没有保留本次选定的标题；必须修复后重新复核'];
    }
    return result;
  }
  async enqueue(): Promise<Record<string, unknown>> {
    this.validate();
    if (this.queued) throw new AdminError('本次已加入投稿队列');
    if (!this.ready()) throw new AdminError(`成片复核尚未通过，未入队：${this.clips.detail(this.id).clip.issues.join('；') || '尚未完成当前版本复核或标题与修改计划不一致'}`);
    const final = this.clips.record(this.id), detail = this.clips.detail(this.id);
    const command = detail.category === 'clip' ? clipCommand(this.id, { action: 'enqueue', note: this.note, publishApproved: true })
      : bundleCommand(this.id, { action: 'enqueue', note: this.note, publishApproved: true }, detail.category,
        this.clips.checkedInput(final.metadataPath, ['.json']));
    await this.step('正在加入投稿队列', command);
    this.queued = true; this.update({ phase: '已加入投稿队列' });
    return { queued: true, id: this.id, title: detail.title };
  }
}
