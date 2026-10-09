import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as path from 'path';
import { Embedder, EmbeddingConfig, normalizedVector } from './EmbeddingClient';

/** A fixed local inference worker, not an agent tool. One request in flight; no shell. */
export function createLocalEmbedder(config: EmbeddingConfig, projectRoot: string): Embedder {
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<void> | undefined;
  let active = false;
  async function close(): Promise<void> {
    const current = child;
    child = undefined;
    if (current && current.exitCode === null) current.kill();
    await exited;
  }
  return {
    close,
    async embed(texts, signal, query = false) {
      signal.throwIfAborted();
      if (active || !texts.length || texts.length > 32 || texts.some(text => !text || text.length > 2000)) throw new Error('Invalid local embedding batch');
      active = true;
      if (!child) {
        child = spawn(config.python || 'python', [path.join(projectRoot, 'src', 'scripts', 'python', 'subtitle_embedding.py'),
          '--model-directory', config.modelDirectory!], { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' } });
        child.stderr.resume(); // No raw runtime paths/errors enter question logs or model context.
        exited = new Promise(resolve => { child!.once('close', () => resolve()); });
        child.stdin.on('error', () => {});
      }
      const current = child;
      try {
        return await new Promise<Float32Array[]>((resolve, reject) => {
          let buffer = '';
          const cleanup = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', failed);
            current.stdout.off('data', data);
            current.off('error', failed);
            current.off('close', failed);
          };
          const failed = () => { cleanup(); reject(new Error('Local embedding unavailable')); };
          const data = (bytes: Buffer) => {
            buffer += bytes.toString('utf8');
            if (buffer.length > 2 * 1024 * 1024) { failed(); return; }
            if (!buffer.includes('\n')) return;
            try {
              const response = JSON.parse(buffer.trim()) as { vectors?: unknown[] };
              if (!Array.isArray(response.vectors) || response.vectors.length !== texts.length) throw new Error('Invalid local vectors');
              const vectors = response.vectors.map(row => normalizedVector(row, config.dimensions));
              cleanup(); resolve(vectors);
            } catch { failed(); }
          };
          const timer = setTimeout(failed, 30000);
          signal.addEventListener('abort', failed, { once: true });
          current.stdout.on('data', data);
          current.once('error', failed);
          current.once('close', failed);
          current.stdin.write(JSON.stringify({ texts, query }) + '\n');
        });
      } catch (error) { await close(); throw error; }
      finally { active = false; }
    }
  };
}
