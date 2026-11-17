import * as fs from 'fs';
import * as path from 'path';
import { AdminError, digest, readText } from './AdminFiles';
import type { AdminAIVideoQueueView, AdminAIVideoRow } from '../../core/admin/aiVideoQueue';
import { aiVideoCreditUsage } from './AdminAIVideoCredits';

const activeStates = new Set(['draft', 'pending', 'submitted', 'needs_review']);
const integer = (value: unknown, fallback = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const text = (value: unknown, maximum: number) => typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').slice(0, maximum) : '';
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;

/** A projection of the existing atomic queue only. Listing never locks, repairs, submits or queries a provider. */
export class AdminAIVideoQueue {
  constructor(private readonly queueFile: string) {}
  private read(): { tasks: any[]; updatedAt: number } {
    try {
      const stat = fs.lstatSync(this.queueFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid queue');
      const data = JSON.parse(readText(this.queueFile, 64 * 1024 * 1024));
      if (!Array.isArray(data.tasks) || data.tasks.length > 100000 || data.tasks.some((task: any) => !task || typeof task !== 'object' || typeof task.id !== 'string')) throw new Error('invalid tasks');
      return { tasks: data.tasks, updatedAt: stat.mtimeMs };
    } catch { throw new AdminError('AI 视频队列未配置、不可读或已损坏，请检查队列配置', 503); }
  }
  view(query: Record<string, unknown> = {}): AdminAIVideoQueueView {
    const { tasks, updatedAt } = this.read();
    const filter = String(query.view || 'active'), search = String(query.search || '').trim().toLowerCase();
    const pageValue = Number(query.page || 1);
    if (!['active', 'history', 'all'].includes(filter) || search.length > 200 || !Number.isSafeInteger(pageValue) || pageValue < 1) throw new AdminError('视频队列筛选无效');
    const counts: Record<string, number> = {};
    const rows: AdminAIVideoRow[] = tasks.map(task => {
      const attempts = Array.isArray(task.inflight) ? task.inflight : [];
      const reservations = Array.isArray(task.submission_reservations) ? task.submission_reservations : [];
      const status = reservations.some((item: any) => item?.state === 'needs_review') ? 'needs_review' : text(task.status, 40) || 'unknown';
      counts[status] = (counts[status] || 0) + 1;
      const submitted = [...attempts.map((attempt: any) => integer(attempt?.submitted_at)), integer(task.submitted_at)];
      const queries = attempts.map((attempt: any) => integer(attempt?.next_query_at)).filter((value: number) => value > 0);
      return { key: digest(task.id), id: text(task.id, 120), name: text(task.name, 200) || '未命名任务', prompt: text(task.prompt, 12000), status,
        ...(typeof task.failure_code === 'string' ? { failureCode: text(task.failure_code, 80) } : {}),
        backend: task.backend === 'dreamina-canvas' ? 'dreamina-canvas' : 'dreamina', source: task.qq ? 'qq' : 'operator',
        model: text(task.model_version, 80) || 'seedance2.0', ratio: text(task.ratio, 20) || '16:9', resolution: text(task.video_resolution, 20) || '720p',
        duration: integer(task.duration, 15), completed: integer(task.completed), repeat: integer(task.repeat, 1),
        active: attempts.length + reservations.length, referenceCount: Array.isArray(task.reference_images) ? task.reference_images.length : 0,
        audioCount: Array.isArray(task.audio_references) ? task.audio_references.length : 0, createdAt: timestamp(task.created_at),
        videoCount: Array.isArray(task.video_references) ? task.video_references.length : 0,
        lastSubmittedAt: timestamp(Math.max(...submitted)), nextQueryAt: queries.length ? timestamp(Math.min(...queries)) : undefined,
        ...(Number.isSafeInteger(task.required_credits) ? { requiredCredits: task.required_credits } : {}),
        playable: false };
    });
    const selected = rows.filter(row => (filter === 'all' || (filter === 'active' ? activeStates.has(row.status) || row.status === 'paused' : !activeStates.has(row.status) && row.status !== 'paused')) &&
      (!search || [row.name, row.prompt, row.id, row.model].some(value => value.toLowerCase().includes(search)))).reverse();
    const pages = Math.max(1, Math.ceil(selected.length / 30)), page = Math.min(pageValue, pages);
    const byKey = new Map(tasks.map(task => [digest(task.id), task]));
    return { updatedAt, counts, creditUsage: aiVideoCreditUsage(tasks), total: selected.length, pages, page, rows: selected.slice((page - 1) * 30, page * 30)
      .map(row => ({ ...row, playable: row.status === 'completed' && !!this.output(byKey.get(row.key)) })) };
  }
  private output(task: any): string | undefined {
    if (!/^qq_[1-9]\d{0,24}_[a-f0-9]{64}$/u.test(task.id) || typeof task.qq_output !== 'string') return;
    try {
      const root = fs.realpathSync(path.join(path.dirname(this.queueFile), 'qq-results'));
      const directory = fs.realpathSync(path.join(root, task.id));
      const file = fs.realpathSync(task.qq_output), relative = path.relative(directory, file);
      if (path.relative(root, directory).startsWith('..') || relative.startsWith('..') || path.isAbsolute(relative) || !/\.mp4$/iu.test(file)) return;
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size >= 12 && stat.size <= 100 * 1024 * 1024) return file;
    } catch { /* Missing outputs do not erase history. */ }
    return;
  }
  media(key: string): string {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new AdminError('视频标识无效');
    const task = this.read().tasks.find(item => digest(item.id) === key && item.status === 'completed');
    const file = task && this.output(task);
    if (!file) throw new AdminError('这条任务暂无可预览的视频', 404);
    return file;
  }
}
