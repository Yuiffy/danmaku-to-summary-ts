import * as path from 'path';
import { AdminCampaignCandidates } from './AdminCampaignCandidates';
import { AdminClipStore } from './AdminClipStore';
import { AdminFeedback } from './AdminFeedback';
import { AdminJobs, CommandRunner } from './AdminJobs';
import { AdminError } from './AdminFiles';

/** Registration and ordinary feedback share one durable serialized operator intent. */
export class AdminCampaignFeedback {
  constructor(private readonly candidates: AdminCampaignCandidates, private readonly clips: AdminClipStore,
    private readonly jobs: AdminJobs, private readonly run: CommandRunner, private readonly feedback: AdminFeedback,
    private readonly promotionCli = path.resolve(__dirname, `../../tools/clipping/promoteCampaignCandidate${__filename.endsWith('.ts') ? '.ts' : '.js'}`)) {}

  private clipId(metadataPath: string): string | undefined {
    const normalized = (file: string) => path.resolve(file).toLowerCase();
    return Object.entries(this.clips.records()).find(([, row]) => [row.metadataPath, row.precisionSelection?.originalMetadataPath]
      .some(file => file && normalized(file) === normalized(metadataPath)))?.[0];
  }
  view(id: string) {
    this.candidates.detail(id);
    const job = this.jobs.latest('campaign-feedback-publish', id);
    const clipId = job?.plan?.clipId;
    let clip;
    if (typeof clipId === 'string') { try { clip = this.clips.summary(this.clips.record(clipId)); } catch { /* Registration may have failed. */ } }
    return { job: job || null, clip: clip || null };
  }
  submit(id: string, body: any) {
    if (body.publishApproved !== true) throw new AdminError('请明确授权制作完成后投稿');
    const note = body.note === undefined || body.note === '' ? '投' : body.note;
    if (typeof note !== 'string' || !note.trim() || note.length > 1000 || note.includes('\0')) throw new AdminError('修改意见无效（最多 1000 字）');
    const edits: Record<string, unknown> = {};
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 300 || body.title.includes('\0')) throw new AdminError('标题无效（最多 300 字）');
      edits.title = body.title.trim();
    }
    const registration = this.candidates.registration(id, body.revision);
    const previous = this.jobs.latest('campaign-feedback-publish', id);
    if (previous && ['queued', 'running'].includes(previous.status)) {
      if (previous.note !== note.trim() || JSON.stringify(previous.edits || {}) !== JSON.stringify(edits)) throw new AdminError('此候选正在处理，请完成后再修改意见', 409);
      return structuredClone(previous);
    }
    const assertEditable = () => {
      const clipId = this.clipId(registration.metadataPath);
      if (!clipId) return;
      const clip = this.clips.record(clipId);
      if (clip.status === 'uploaded' || clip.uploadState?.bvid || this.clips.hasActiveUpload(clipId)
        || ['queued', 'uploading', 'excluded', 'cancelled'].includes(clip.status) || clip.editorialExclusion) throw new AdminError('此候选已投稿、已在队列或已排除，请核对正式候选状态', 409);
      if (['queued', 'running'].includes(this.jobs.latest('feedback-publish', clipId)?.status || '')) throw new AdminError('正式候选正在处理，请等处理结束', 409);
    };
    assertEditable();
    const validate = () => { this.candidates.registration(id, body.revision); assertEditable(); };
    return this.jobs.submitOperation('campaign-feedback-publish', id, { note: note.trim(), edits, revision: body.revision }, async (output, update) => {
      let clipId = this.clipId(registration.metadataPath);
      if (!clipId) {
        update({ phase: '正在登记所选候选' });
        const prepared = await this.run({ executable: 'node', action: 'register-campaign-candidate', target: id,
          args: [...(this.promotionCli.endsWith('.ts') ? ['-r', 'ts-node/register'] : []), this.promotionCli,
            '--state', registration.state, '--id', id, '--selection-digest', registration.selectionDigest, '--source-digest', registration.sourceDigest] }, output);
        if (prepared !== 0) throw new AdminError('候选登记准备失败，未制作或投稿；意见已保存');
        validate();
        const imported = await this.run({ executable: 'python', action: 'import-campaign-candidate', target: id,
          args: ['src/scripts/clip_upload_registry.py', 'import-json', '--manifest', registration.metadataPath, '--include-pending'] }, output);
        if (imported !== 0) throw new AdminError('候选登记失败，未制作或投稿；意见已保存');
        clipId = this.clipId(registration.metadataPath);
        if (!clipId) throw new AdminError('候选登记未返回可用编号，未继续投稿');
      }
      update({ plan: { clipId } });
      validate();
      return this.feedback.execute(clipId, note.trim(), this.clips.detail(clipId).revision, edits, output,
        value => update({ ...value, ...(value.plan ? { plan: { ...value.plan, clipId } } : {}) }));
    }, validate);
  }
}
