const fs = require('fs');
const os = require('os');
const path = require('path');
const { withSelectionCache } = require('./selection_cache');

describe('selection stage cache', () => {
  let directory;
  const validate = value => typeof value?.text === 'string' && value.text.startsWith('valid');
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-cache-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  test('reuses successful stages and joins concurrent requests', async () => {
    const options = { directory, phase: 'recall', prompt: 'source', signature: { model: 'unchanged' }, validate };
    const generate = jest.fn().mockResolvedValue({ text: 'valid result', meta: { model: 'unchanged' } });
    const results = await Promise.all([withSelectionCache(options, generate), withSelectionCache(options, generate)]);
    expect(results[0].text).toBe(results[1].text);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await withSelectionCache(options, generate)).meta.selectionCache.hit).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    await withSelectionCache({ ...options, prompt: 'changed source' }, generate);
    await withSelectionCache({ ...options, signature: { model: 'changed' } }, generate);
    await withSelectionCache({ ...options, phase: 'rerank' }, generate);
    expect(generate).toHaveBeenCalledTimes(4);
  });

  test('never persists invalid output or turns generation failure into an implicit retry', async () => {
    const options = { directory, phase: 'recall', prompt: 'source', signature: {}, validate };
    const invalid = jest.fn().mockResolvedValue({ text: 'malformed' });
    await withSelectionCache(options, invalid);
    await withSelectionCache(options, invalid);
    expect(invalid).toHaveBeenCalledTimes(2);
    const failed = jest.fn().mockRejectedValue(new Error('upstream failure'));
    await expect(withSelectionCache(options, failed)).rejects.toThrow('upstream failure');
    expect(failed).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(directory).filter(name => name !== '.attempt-outcomes')).toEqual([]);
  });

  test('does not persist incomplete results and selectively replaces an old incomplete cache', async () => {
    const options = { directory, phase: 'recall', prompt: 'source', signature: {}, validate };
    const unfinished = jest.fn().mockResolvedValue({ text: 'valid looking fragment', meta: { finishReason: 'max_output_tokens' } });
    await withSelectionCache(options, unfinished);
    expect(unfinished).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(directory).filter(name => name !== '.attempt-outcomes')).toEqual([]);
    const complete = jest.fn().mockResolvedValue({ text: 'valid complete output', meta: { finishReason: 'stop' } });
    await withSelectionCache(options, complete);
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json')));
    const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    cached.result.meta.finishReason = 'incomplete';
    fs.writeFileSync(file, JSON.stringify(cached));
    await withSelectionCache(options, complete);
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await withSelectionCache(options, complete)).meta.selectionCache.hit).toBe(true);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  test('deduplicates two real Node processes using the same stage key', async () => {
    const { execFile } = require('child_process');
    const cache = path.join(directory, 'cache');
    const counter = path.join(directory, 'calls.txt');
    const modulePath = require.resolve('./selection_cache');
    const source = `
      const fs=require('fs');
      const {withSelectionCache}=require(process.argv[1]);
      withSelectionCache({directory:process.argv[2],phase:'recall',prompt:'source',signature:{model:'same'},
        validate:r=>r?.text==='valid'},async()=>{
          fs.appendFileSync(process.argv[3],'called\\n');
          await new Promise(r=>setTimeout(r,150));
          return {text:'valid',meta:{model:'same'}};
        }).then(r=>process.stdout.write(r.text)).catch(e=>{console.error(e);process.exitCode=1;});
    `;
    const run = () => new Promise((resolve, reject) => execFile(process.execPath,
      ['-e', source, modulePath, cache, counter], { windowsHide: true, timeout: 10000 },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(await Promise.all([run(), run()])).toEqual(['valid', 'valid']);
    expect(fs.readFileSync(counter, 'utf8')).toBe('called\n');
  });

  test('recovers an abandoned lock without reusing invalid output', async () => {
    const options = { directory, phase: 'recall', prompt: 'source', signature: {}, validate };
    const generate = jest.fn().mockResolvedValue({ text: 'valid' });
    await withSelectionCache(options, generate);
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json')));
    fs.unlinkSync(file);
    fs.writeFileSync(file + '.lock', JSON.stringify({ pid: 0 }));
    await withSelectionCache(options, generate);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(file + '.lock')).toBe(false);
  });

  test('filesystem cache and completion checks do not require a compiled model runtime', () => {
    const { spawnSync } = require('child_process');
    const script = `
      const {withSelectionCache}=require(process.argv[1]);
      const options={directory:process.argv[2],phase:'test',prompt:'source',signature:{},validate:r=>r.text==='valid'};
      let calls=0;
      const generate=async()=>{calls++;return {text:'valid',meta:{finishReason:'stop'}};};
      (async()=>{await withSelectionCache(options,generate);await withSelectionCache(options,generate);
        if(calls!==1)throw Error('Expected one generation');process.stdout.write('CACHE_OK');})()
        .catch(error=>{console.error(error);process.exitCode=1;});
    `;
    const result = spawnSync(process.execPath, ['-e', script, require.resolve('./selection_cache'), directory], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: '', DANMAKU_WORKFLOW_RELEASE: path.join(directory, 'missing-runtime') }
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('CACHE_OK');
  });
});
