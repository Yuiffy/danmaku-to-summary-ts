import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { CommentReplyConfig } from './CommentPolicy';
import { CommentProject, safeEvidenceText } from './CommentContext';

/** Operator-approved public files only. Public comments cannot select paths or sections. */
export function createProjectReader(root: string, sources: NonNullable<CommentReplyConfig['projectSources']>) {
  const fixed = sources.map(source => ({ ...source, path: path.resolve(root, source.path) }));
  return async (query: string, signal: AbortSignal): Promise<CommentProject[]> => {
    const selected = fixed.filter(source => source.keywords.some(word => query.toLowerCase().includes(word.toLowerCase()))).slice(0, 3);
    const evidence: CommentProject[] = [];
    for (const source of selected) {
      signal.throwIfAborted();
      let handle: fs.FileHandle | undefined;
      try {
        if (!/\.(?:md|ts|py)$/iu.test(source.path) || (await fs.lstat(source.path)).isSymbolicLink() ||
          path.normalize(await fs.realpath(source.path)).toLowerCase() !== path.normalize(source.path).toLowerCase()) continue;
        handle = await fs.open(source.path, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 128 * 1024) continue;
        const buffer = Buffer.alloc(128 * 1024 + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 128 * 1024) continue;
        const raw = buffer.subarray(0, bytesRead).toString('utf8');
        const lines = raw.split(/\r?\n/u);
        const start = source.section ? lines.indexOf(source.section) : 0;
        if (start < 0) continue;
        const tail = lines.slice(start + (source.section ? 1 : 0));
        const next = source.section?.startsWith('#') ? tail.findIndex(line => /^#{1,6} /u.test(line)) : -1;
        const candidates = (next >= 0 ? tail.slice(0, next) : tail).map((line, index) => ({ line,
          index, score: source.keywords.filter(word => line.toLowerCase().includes(word.toLowerCase())).length }));
        if (candidates.some(item => item.score)) candidates.sort((a, b) => b.score - a.score || a.index - b.index);
        const text = candidates.map(item => safeEvidenceText(item.line, 280)).filter(Boolean).join(' ').slice(0, 280);
        if (text) evidence.push({ source: source.id, label: source.label, kind: source.kind,
          revision: createHash('sha256').update(raw).digest('hex').slice(0, 12), text });
      } catch { signal.throwIfAborted(); /* An unavailable optional source is not proof of capability. */ }
      finally { await handle?.close(); }
    }
    return evidence;
  };
}
