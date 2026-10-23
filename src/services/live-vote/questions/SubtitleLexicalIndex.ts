import * as fs from 'fs/promises';
import * as path from 'path';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { SubtitleCue, SubtitleSource } from './SubtitleCorpus';

const compress = promisify(gzip), decompress = promisify(gunzip);
const MAX_SHARD = 8 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024 * 1024;
const MAX_CANDIDATES = 50000;
export interface LexicalSource extends SubtitleSource { key: string; hash: string }
export interface IndexedCueMatch extends LexicalSource { cue: number; score: number }

/** Additive metadata: the embedding shards and existing cue-map format remain compatible. */
export async function writeSubtitleLexical(directory: string, key: string, cues: SubtitleCue[]): Promise<void> {
  const file = path.join(directory, `${key}.lex.json.gz`);
  // Rebuild cheap metadata on every maintenance pass, including when embeddings are reused.
  const bytes = await compress(Buffer.from(JSON.stringify(cues.map(cue => cue.text)), 'utf8'));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

function queryGrams(question: string): string[] {
  const text = question.normalize('NFKC').toLowerCase()
    .replace(/(?:说了什么|说过什么|有说|说了|说过|有没有|是不是|是否|什么|多少|上次|那次|这次)/gu, ' ');
  const ignored = new Set(['什么', '多少', '有没有', '有没', '没有', '的是', '了吗', '的吗', '说了', '有说', '上次', '那次']);
  return [...new Set([...text.matchAll(/[\p{L}\p{N}]+/gu)].flatMap(match => {
    const chars = Array.from(match[0]);
    return chars.slice(1).map((char, index) => chars[index] + char);
  }))].filter(gram => !ignored.has(gram)).slice(0, 120);
}

/** One question owns this bounded cache; no archive source is read until a ranked hit is verified. */
export class SubtitleLexicalReader {
  private compressedBytes = 0;
  private textBytes = 0;
  private readonly snapshots = new Map<string, Promise<string[] | undefined>>();

  private read(directory: string, key: string, signal: AbortSignal): Promise<string[] | undefined> {
    const file = path.join(directory, 'shards', `${key}.lex.json.gz`);
    let operation = this.snapshots.get(file);
    if (!operation) {
      operation = (async () => {
        try {
          signal.throwIfAborted();
          const stat = await fs.lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SHARD || this.compressedBytes + stat.size > MAX_READ_BYTES) return undefined;
          this.compressedBytes += stat.size;
          const bytes = await fs.readFile(file);
          if (bytes.length > MAX_SHARD) return undefined;
          const text = await decompress(bytes, { maxOutputLength: Math.min(MAX_SHARD * 4, MAX_TEXT_BYTES - this.textBytes) });
          this.textBytes += text.length;
          signal.throwIfAborted();
          const value: unknown = JSON.parse(text.toString('utf8'));
          if (!Array.isArray(value) || value.length > 100000 || value.some(item => typeof item !== 'string' || item.length > 1000)) return undefined;
          return value.map(item => item.normalize('NFKC').toLowerCase());
        } catch { signal.throwIfAborted(); return undefined; }
      })();
      this.snapshots.set(file, operation);
    }
    return operation;
  }

  async search(directory: string, sources: LexicalSource[], terms: string[], question: string, signal: AbortSignal,
    date: string | null, files?: ReadonlySet<string>): Promise<{ matches: IndexedCueMatch[]; complete: boolean }> {
    const normalized = [...new Set(terms.map(term => term.normalize('NFKC').toLowerCase()))];
    const concepts = normalized.filter(term => !normalized.some(other => other !== term && term.includes(other)));
    const grams = queryGrams(question), frequencies = grams.map(() => 0);
    const candidates: Array<{ source: LexicalSource; cue: number; matched: number; grams: number[] }> = [];
    const seen = new Set<string>();
    let complete = true;
    for (const source of sources) {
      signal.throwIfAborted();
      if (date && !source.date?.startsWith(date) || files && !files.has(source.file) || seen.has(source.key)) continue;
      seen.add(source.key);
      const texts = await this.read(directory, source.key, signal);
      if (!texts) { complete = false; continue; }
      for (let cue = 0; cue < texts.length; cue++) {
        const matched = concepts.filter(term => texts[cue].includes(term)).length;
        if (!matched) continue;
        if (candidates.length >= MAX_CANDIDATES) { complete = false; break; }
        const found = grams.flatMap((gram, index) => texts[cue].includes(gram) ? [index] : []);
        for (const index of found) frequencies[index]++;
        candidates.push({ source, cue, matched, grams: found });
      }
    }
    // Rare question details break ties among event hits, without requiring a supplied date or rewriting event keywords.
    const ranked = candidates.map(item => ({ ...item, score: item.matched * 8 + item.grams.reduce((sum, index) =>
      sum + Math.log(1 + candidates.length / (1 + frequencies[index])), 0) })).sort((a, b) => b.score - a.score);
    const matches: IndexedCueMatch[] = [], perSource = new Map<string, number>();
    for (const item of ranked) {
      const count = perSource.get(item.source.file) || 0;
      if (count >= 4) continue;
      matches.push({ ...item.source, cue: item.cue, score: item.score });
      perSource.set(item.source.file, count + 1);
      if (matches.length === 32) break;
    }
    return { matches, complete };
  }
}
