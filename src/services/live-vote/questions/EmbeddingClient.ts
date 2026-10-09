import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

export interface EmbeddingConfig {
  enabled: boolean;
  directory: string;
  model: string;
  dimensions: number;
  backend: 'daiyu' | 'local';
  /** Local model snapshot, installed separately; never supplied by a question. */
  modelDirectory?: string;
  python?: string;
}
export interface Embedder {
  embed(texts: string[], signal: AbortSignal, query?: boolean): Promise<Float32Array[]>;
  close?(): Promise<void>;
}
export function normalizedVector(values: unknown, dimensions: number): Float32Array {
  if (!Array.isArray(values) || values.length !== dimensions || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('Invalid embedding dimensions or values');
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm < 1e-10) throw new Error('Invalid embedding norm');
  return Float32Array.from(values, value => value / norm);
}

/** OpenAI-compatible embeddings only; no provider error bodies or credentials in logs. */
export function createRemoteEmbedder(config: EmbeddingConfig,
  settings: { url: string; apiKey: string; proxy?: string }, transport = fetch): Embedder {
  const url = settings.url.replace(/chat\/completions$/u, 'embeddings');
  const agent = settings.proxy ? new HttpsProxyAgent(settings.proxy) : undefined;
  return { async embed(texts, signal) {
    signal.throwIfAborted();
    if (!texts.length || texts.length > 32 || texts.some(text => !text || text.length > 2000)) throw new Error('Invalid embedding batch');
    try {
      const response = await transport(url, {
        method: 'POST', redirect: 'error', signal: signal as any, timeout: 30000, size: 8 * 1024 * 1024, agent,
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, input: texts, dimensions: config.dimensions, encoding_format: 'float' })
      });
      if (!response.ok) throw new Error('Embedding provider rejected request');
      const body = await response.json() as { data?: Array<{ index: number; embedding: unknown }> };
      if (!Array.isArray(body.data) || body.data.length !== texts.length) throw new Error('Invalid embedding response');
      const rows = [...body.data].sort((a, b) => a.index - b.index);
      return rows.map((row, index) => {
        if (row.index !== index) throw new Error('Invalid embedding order');
        return normalizedVector(row.embedding, config.dimensions);
      });
    } catch { throw new Error('Embedding provider request failed'); }
  } };
}
