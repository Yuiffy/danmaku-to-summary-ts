import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QQKnowledgeBase } from './QQKnowledgeBase';

test('local QQ knowledge base seeds, searches, updates and deletes entries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-knowledge-'));
  const base = new QQKnowledgeBase(path.join(root, 'knowledge.sqlite'));
  try {
    base.seedDefaults(); base.seedDefaults();
    expect(base.search('群主 全部消息', 4)).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: 'qq.group-message-scope' })]));
    const first = base.upsert({ id: 'test.rule', title: '测试规则', content: '管理员可以设置机器人消息范围。', tags: ['配置'] });
    expect(first.createdAt).toBeLessThanOrEqual(first.updatedAt);
    expect(base.search('管理员')).toEqual(expect.arrayContaining([expect.objectContaining({ evidenceId: 'test.rule', text: first.content })]));
    base.upsert({ id: 'test.rule', title: '更新规则', content: '群主可以修改设置。', enabled: false });
    expect(base.search('群主').some(hit => hit.evidenceId === 'test.rule')).toBe(false);
    expect(base.list().find(entry => entry.id === 'test.rule')?.enabled).toBe(false);
    base.delete('test.rule'); expect(base.get('test.rule')).toBeUndefined();
  } finally { base.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('knowledge search rejects unsafe or empty input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-knowledge-'));
  const base = new QQKnowledgeBase(path.join(root, 'knowledge.sqlite'));
  try { expect(base.search('" OR 1=1 --')).toEqual([]); expect(() => base.search('')).toThrow(); }
  finally { base.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
