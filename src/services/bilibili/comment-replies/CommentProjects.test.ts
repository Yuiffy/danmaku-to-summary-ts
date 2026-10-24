import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createProjectReader } from './CommentProjects';
import { fitCommentContext } from './CommentContext';
import { validateCommentConfig } from './CommentPolicy';
import example from '../../../../config/comment-replies.example.json';

test('only selected public sections reach the model with source revision, never private lines or file paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-projects-'));
  try {
    await fs.writeFile(path.join(root, 'workflow.md'), '# workflow\ninternal preface\n## Public\n先逐镜头超分，再烧字幕。\napi_key=secret\nC:/private/config.json\n## Private\nprivate next section\n');
    const read = createProjectReader(root, [{ id: 'video', label: '视频流程', path: 'workflow.md', keywords: ['方式'], section: '## Public', kind: 'guide' }]);
    const signal = new AbortController().signal;
    expect(await read('你好', signal)).toEqual([]);
    const projects = await read('这套方式我们能用不', signal);
    expect(projects).toEqual([{ source: 'video', label: '视频流程', kind: 'guide', revision: expect.stringMatching(/^[a-f\d]{12}$/u), text: '先逐镜头超分,再烧字幕。' }]);
    const messages = fitCommentContext('这套方式我们能用不', '比较方法', { anchorDay: '2026-10-24', coverage: 'partial', clues: [], projects });
    expect(JSON.stringify(messages)).not.toMatch(/private|secret|workflow\.md/u);
    await fs.writeFile(path.join(root, 'workflow.md'), 'x'.repeat(128 * 1024 + 1));
    expect(await read('方式', signal)).toEqual([]);
    expect(() => validateCommentConfig({ ...example, projectSources: [{ id: 'bad', label: 'x', path: 'x.md', keywords: [], kind: 'guide' }] })).toThrow();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
