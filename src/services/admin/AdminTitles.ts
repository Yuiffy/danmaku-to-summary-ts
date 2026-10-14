import * as fs from 'fs';
import * as path from 'path';
import { AdminJob, ClipDetail } from '../../core/admin/contracts';
import { TitleDecision, TitleSelection, TitleStats, TitleView, titleStrategyLabels } from '../../core/admin/titles';
import { AdminClipStore } from './AdminClipStore';
import { AdminJobs } from './AdminJobs';
import { AdminError, atomicJson, digest, readJson } from './AdminFiles';
import { parseTitleOptions, titleEvidence, titlePrompt, titleSetId, TITLE_VERSION } from './AdminTitlePolicy';

interface SavedSet extends Omit<TitleView, 'revision' | 'job'> {
  shown: string[];
  history: (TitleSelection & { at: string })[];
}
interface SavedTitles { sets: SavedSet[] }
/** Sole writer of optional title drafts/choice history, never clip metadata or upload queues. */
export class AdminTitles {
  constructor(private readonly directory: string, private readonly clips: Pick<AdminClipStore, 'detail' | 'hasActiveUpload'>,
    private readonly jobs: AdminJobs, private readonly generate: (prompt: string) => Promise<string>) {}

  private file(id: string): string {
    if (!/^[1-9]\d{0,8}$/u.test(id)) throw new AdminError('视频 ID 无效');
    return path.join(this.directory, `${id}.json`);
  }
  private current(id: string) {
    const detail = this.clips.detail(id), data: SavedTitles = readJson(this.file(id), { sets: [] });
    const key = titleSetId(detail);
    let set = data.sets.find(item => item.id === key);
    if (!set) {
      set = { id: key, version: TITLE_VERSION, options: [{ id: 'default', strategy: 'default', title: detail.title }],
        selection: null, generated: false, shown: [], history: [] };
      data.sets.push(set);
    }
    return { detail, data, set };
  }
  private revision(set: SavedSet): string {
    return digest(JSON.stringify([set.id, set.options, set.selection, set.history.length]));
  }
  view(id: string): TitleView {
    const { set } = this.current(id), job = this.jobs.latest('title-options', id);
    return { id: set.id, version: set.version, revision: this.revision(set), options: set.options, selection: set.selection,
      generated: set.generated, ...(job?.revision === set.id ? { job: { id: job.id, status: job.status, output: job.output } } : {}) };
  }
  private editable(id: string, detail: ClipDetail): void {
    if (detail.category !== 'clip') throw new AdminError('完整包请使用专用包装流程');
    if (['queued', 'uploading', 'uploaded', 'excluded', 'cancelled'].includes(detail.clip.status) || this.clips.hasActiveUpload(id)) throw new AdminError('请在未入队的待审核切片中选择标题', 409);
    if (this.jobs.list().some(job => job.target === id && job.action !== 'title-options' && ['queued', 'running'].includes(job.status))) throw new AdminError('此切片正在处理，请完成后再选择标题', 409);
  }
  private checked(id: string, body: { setId?: string; revision?: string }) {
    const current = this.current(id);
    if (body.setId !== current.set.id || body.revision !== this.revision(current.set)) throw new AdminError('标题或片内证据已变化，请刷新标题候选后再选', 409);
    return current;
  }
  expose(id: string, body: { setId?: string; optionIds?: unknown }): TitleView {
    const { detail, data, set } = this.current(id);
    if (body.setId !== set.id) throw new AdminError('标题证据已变化，请刷新', 409);
    if (!Array.isArray(body.optionIds) || body.optionIds.length > 4 || body.optionIds.some(id => !set.options.some(option => option.id === id))) throw new AdminError('展示的标题候选无效');
    // Reading a completed clip is not an opportunity to choose a publishing title.
    if (detail.category !== 'clip' || ['queued', 'uploading', 'uploaded', 'excluded', 'cancelled'].includes(detail.clip.status) || this.clips.hasActiveUpload(id)) return this.view(id);
    const shown = [...new Set([...set.shown, ...body.optionIds as string[]])];
    if (shown.length !== set.shown.length) { set.shown = shown; atomicJson(this.file(id), data); }
    return this.view(id);
  }
  select(id: string, body: { setId?: string; revision?: string; optionId?: unknown; title?: unknown; reset?: boolean }): TitleView {
    const { detail, data, set } = this.checked(id, body); this.editable(id, detail);
    let selection: TitleSelection | null = null;
    if (body.reset !== true) {
      if (body.optionId !== undefined) {
        const option = set.options.find(item => item.id === body.optionId);
        if (!option || !option.title) throw new AdminError('标题候选不存在');
        selection = { optionId: option.id, strategy: option.strategy, title: option.title };
      } else {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80 || /[\r\n\x00-\x1f]/u.test(body.title)) throw new AdminError('请输入 1–80 字的单行标题');
        selection = { strategy: 'custom', title: body.title.trim() };
      }
    }
    if (JSON.stringify(selection) !== JSON.stringify(set.selection)) {
      set.selection = selection;
      set.shown = [...new Set([...set.shown, selection?.optionId || 'default'])];
      set.history.push({ ...(selection || { strategy: 'default', title: detail.title }), at: new Date().toISOString() });
      atomicJson(this.file(id), data);
    }
    return this.view(id);
  }
  start(id: string, body: { setId?: string; revision?: string }): AdminJob | TitleView {
    const { detail, set } = this.checked(id, body); this.editable(id, detail);
    if (set.generated) return this.view(id);
    const prior = this.jobs.latest('title-options', id);
    if (prior && ['queued', 'running'].includes(prior.status)) return prior;
    if (!titleEvidence(detail).trim()) throw new AdminError('缺少片内字幕，暂时不能生成有据标题');
    const validate = () => {
      const latest = this.current(id);
      if (latest.set.id !== set.id) throw new AdminError('生成期间标题或片内证据发生变化，请重新生成', 409);
      this.editable(id, latest.detail);
    };
    return this.jobs.submitOperation('title-options', id, { revision: set.id }, async output => {
      let raw: string;
      try { raw = await this.generate(titlePrompt(detail)); }
      catch { throw new AdminError('候选生成服务暂时不可用，默认标题和已保存选择不受影响'); }
      validate();
      const latest = this.current(id); // Preserve a choice saved while the model was running.
      latest.set.options.push(...parseTitleOptions(raw, detail)); latest.set.generated = true;
      atomicJson(this.file(id), latest.data);
      output(`已生成 ${latest.set.options.length - 1} 条可选标题；默认标题未改变。`);
      return 0;
    }, validate);
  }
  prepare(id: string, input: Record<string, any>): { body: Record<string, any>; decision?: TitleDecision } {
    const { detail, set } = this.current(id);
    const body: Record<string, any> = { ...input, titleChoice: undefined };
    if (detail.category !== 'clip') return { body };
    const applies = ['feedback-publish', 'cut', 'approve-review', 'rebuild'].includes(body.action);
    const publishes = body.action === 'enqueue' || body.action === 'correct' && body.enqueue === true;
    if (!applies && !publishes) return { body };
    if (body.titleSetId !== undefined && (body.titleSetId !== set.id || body.titleRevision !== this.revision(set))) throw new AdminError('标题选择已变化，请刷新后再提交', 409);
    if (set.selection && body.titleSetId === undefined) throw new AdminError('已有保存的标题选择，请刷新审核页后再提交', 409);
    const title = typeof body.title === 'string' && body.title.trim() ? body.title : set.selection?.title || detail.title;
    if (publishes && title !== detail.title) throw new AdminError('选定标题尚未应用，请使用“按意见修改并投稿”', 409);
    if (applies && set.selection && body.title === undefined) body.title = set.selection.title;
    const selection: TitleSelection = set.selection && title === set.selection.title ? set.selection
      : title === detail.title ? { strategy: 'default' as const, title } : { strategy: 'custom' as const, title };
    const decision: TitleDecision = { ...selection, setId: set.id, version: set.version,
      mode: set.selection || title !== detail.title ? 'explicit' : 'retained' };
    body.titleChoice = decision;
    return { body, decision };
  }
  stats(): TitleStats {
    const rows: TitleStats['rows'] = Object.keys(titleStrategyLabels).map(strategy => ({ strategy: strategy as TitleSelection['strategy'], shown: 0, selected: 0, changes: 0, submitted: 0, succeeded: 0, failed: 0 }));
    const row = (strategy: TitleSelection['strategy']) => rows.find(item => item.strategy === strategy)!;
    let sets = 0, passiveDefault = 0;
    for (const name of fs.existsSync(this.directory) ? fs.readdirSync(this.directory).filter(name => /^[1-9]\d{0,8}\.json$/u.test(name)) : []) {
      const data: SavedTitles = readJson(path.join(this.directory, name));
      for (const set of data.sets.filter(set => set.version === TITLE_VERSION)) {
        if (!set.shown.length) continue;
        sets++;
        for (const option of set.options.filter(option => set.shown.includes(option.id))) row(option.strategy).shown++;
        if (set.selection) row(set.selection.strategy).selected++;
        else passiveDefault++;
        for (const event of set.history) row(event.strategy).changes++;
      }
    }
    // A retry is another task, not another independent sample; keep the latest task per evidence set.
    const submissions = new Map<string, ReturnType<AdminJobs['titleDecisions']>[number]>();
    for (const job of this.jobs.titleDecisions()) if (job.titleChoice?.version === TITLE_VERSION) submissions.set(job.titleChoice.setId, job);
    for (const job of submissions.values()) {
      const count = row(job.titleChoice!.strategy); count.submitted++;
      if (job.status === 'succeeded') count.succeeded++;
      if (['failed', 'interrupted'].includes(job.status)) count.failed++;
    }
    return { version: TITLE_VERSION, rows, sets, passiveDefault };
  }
}
