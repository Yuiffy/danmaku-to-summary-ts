import { AdminError } from './AdminFiles';
import { QQKnowledgeBase, QQKnowledgeEntry, QQKnowledgeInput } from '../qqbot/QQKnowledgeBase';

export class AdminQQKnowledge {
  private readonly base: QQKnowledgeBase;
  constructor(file: string) { this.base = new QQKnowledgeBase(file); this.base.seedDefaults(); }
  list(query: { search?: unknown; includeDisabled?: unknown } = {}): { entries: QQKnowledgeEntry[]; total: number } {
    const search = String(query.search || '').trim();
    if (search.length > 300) throw new AdminError('知识库搜索词过长');
    const entries = search ? this.base.search(search, 16).map(hit => this.base.get(hit.evidenceId)).filter((entry): entry is QQKnowledgeEntry => !!entry)
      : this.base.list(query.includeDisabled !== '0');
    return { entries, total: entries.length };
  }
  get(id: string): QQKnowledgeEntry { const entry = this.base.get(id); if (!entry) throw new AdminError('知识条目不存在', 404); return entry; }
  save(id: string, body: unknown): QQKnowledgeEntry {
    if (!body || typeof body !== 'object') throw new AdminError('知识条目内容无效');
    try { return this.base.upsert({ ...(body as QQKnowledgeInput), id }); }
    catch (error) { throw new AdminError(error instanceof Error ? error.message : '知识条目无效'); }
  }
  remove(id: string): { id: string; deleted: true } { this.get(id); this.base.delete(id); return { id, deleted: true }; }
  close(): void { this.base.close(); }
}
