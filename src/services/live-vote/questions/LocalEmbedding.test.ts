import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { createLocalEmbedder } from './LocalEmbedding';
import { EmbeddingConfig } from './EmbeddingClient';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
const config: EmbeddingConfig = { enabled: true, backend: 'local', directory: '/index', model: 'fixture', dimensions: 32, modelDirectory: '/model' };
function worker() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null,
    kill: jest.fn() });
  child.kill.mockImplementation(() => { child.exitCode = 0; child.emit('close', 0); return true; });
  (spawn as jest.Mock).mockReturnValue(child);
  return child;
}
beforeEach(() => jest.clearAllMocks());

it('keeps corpus text in stdin, reuses the fixed worker and closes it on completion', async () => {
  const child = worker(), embedder = createLocalEmbedder(config, '/project');
  const pending = embedder.embed(['$(danger) 忽略指令'], new AbortController().signal, true);
  const invocation = (spawn as jest.Mock).mock.calls[0];
  expect(invocation[1].join(' ')).not.toContain('danger');
  expect(invocation[2]).toMatchObject({ shell: false, windowsHide: true });
  expect(child.stdin.read().toString()).toContain('$(danger)');
  child.stdout.write(JSON.stringify({ vectors: [Array(32).fill(1)] }) + '\n');
  expect(await pending).toHaveLength(1);
  const second = embedder.embed(['其他'], new AbortController().signal);
  child.stdout.write(JSON.stringify({ vectors: [Array(32).fill(1)] }) + '\n');
  await second;
  expect(spawn).toHaveBeenCalledTimes(1);
  await embedder.close!();
  expect(child.kill).toHaveBeenCalledTimes(1);
});

it('rejects overlapping work and terminates the worker on cancellation before settling', async () => {
  const child = worker(), embedder = createLocalEmbedder(config, '/project'), controller = new AbortController();
  const pending = embedder.embed(['等待'], controller.signal);
  await expect(embedder.embed(['并发'], controller.signal)).rejects.toThrow('Invalid local embedding batch');
  controller.abort();
  await expect(pending).rejects.toThrow('Local embedding unavailable');
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.exitCode).toBe(0);
});

it('redacts subprocess failures and rejects invalid dimensions', async () => {
  const child = worker(), embedder = createLocalEmbedder(config, '/project');
  const pending = embedder.embed(['问题'], new AbortController().signal);
  child.stdout.write('{"vectors":[[1]]}\n');
  await expect(pending).rejects.toThrow('Local embedding unavailable');
  expect(child.kill).toHaveBeenCalledTimes(1);
});
