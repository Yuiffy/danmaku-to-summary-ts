import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { deepMerge, findConfigPaths, loadConfigLayers, transformSecrets } from './ConfigLayers';
import { getProjectRoot } from './ProjectPaths';

describe('Node/Python configuration contract', () => {
  let root: string;
  const scripts = path.join(getProjectRoot(), 'src/scripts');

  function python(env: NodeJS.ProcessEnv, configPath?: string) {
    const result = spawnSync(process.env.PYTHON || 'python', ['-c',
      'import json,sys; sys.path.insert(0,sys.argv[1]); from config_contract import load_config_layers; data=json.load(sys.stdin); print(json.dumps(load_config_layers(data["root"], data["env"], data.get("configPath"))))', scripts], {
      cwd: os.tmpdir(), windowsHide: true, encoding: 'utf8',
      env: { ...process.env, PYTHONUTF8: '1' },
      input: JSON.stringify({ root, env, configPath }), timeout: 10000
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'configuration-contract-'));
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/default.json'), JSON.stringify({ marker: 'default', bilibili: { anchors: { sample: { enabled: true } } } }));
    fs.writeFileSync(path.join(root, 'config/production.json'), '\uFEFF' + JSON.stringify({ marker: 'production', bilibili: { anchors: {} }, list: [1, 2], nested: { enabled: false } }));
    fs.writeFileSync(path.join(root, 'explicit.json'), JSON.stringify({ marker: 'explicit', list: [] }));
    fs.writeFileSync(path.join(root, 'config/secret.json'), JSON.stringify({
      gemini: { apiKey: 'fixture-gemini' }, tuZi: { apiKey: 'fixture-image', textApiKey: 'fixture-text' },
      providers: { daiYu: { apiKey: 'fixture-old', baseURL: 'https://example.invalid/v1' } },
      ai: { providers: { daiYu: { apiKey: 'fixture-current' } } },
      bilibili: { cookie: 'fixture-cookie' }, wechatWork: { webhookUrl: 'https://example.invalid' },
      tuZiBalance: { accessToken: 'fixture-balance' }
    }));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it.each([
    [{ NODE_ENV: 'production' }, 'production'],
    [{ NODE_ENV: 'automation' }, 'production'],
    [{ NODE_ENV: 'development' }, 'default'],
    [{ NODE_ENV: 'production', CONFIG_PATH: 'explicit.json' }, 'explicit']
  ] as Array<[NodeJS.ProcessEnv, string]>)('resolves the same selected file, secrets and overrides for %j', (env, marker) => {
    env.GEMINI_API_KEY = 'fixture-environment';
    env.WEBHOOK_PORT = '12345';
    const node = loadConfigLayers({ root, env });
    expect(node).toEqual(python(env));
    expect(node.marker).toBe(marker);
    expect(node).toMatchObject({ ai: {
      text: { gemini: { apiKey: 'fixture-environment' }, tuZi: { apiKey: 'fixture-text' }, daiYu: { apiKey: 'fixture-current', baseUrl: 'https://example.invalid' } },
      comic: { tuZi: { apiKey: 'fixture-image' } }
    } });
    if (marker === 'production') expect(node.bilibili).toEqual({ anchors: {}, cookie: 'fixture-cookie' });
  });

  it('falls back only when the optional production file is absent', () => {
    fs.unlinkSync(path.join(root, 'config/production.json'));
    const env = { NODE_ENV: 'production' };
    expect(loadConfigLayers({ root, env })).toEqual(python(env));
    expect(findConfigPaths({ root, env })).toEqual([path.join(root, 'config/default.json')]);
    expect(() => loadConfigLayers({ root, env, configPath: 'missing.json' })).toThrow('Explicit configuration');
    expect(() => python(env, 'missing.json')).toThrow('Explicit configuration');
  });

  it('preserves JSON replacement semantics and empty secret maps in both languages', () => {
    expect(deepMerge({ list: [1], value: { previous: true } }, { list: [], value: null })).toEqual({ list: [], value: null });
    fs.writeFileSync(path.join(root, 'config/secret.json'), JSON.stringify({ providers: {} }));
    const env = { NODE_ENV: 'production' };
    expect(loadConfigLayers({ root, env })).toEqual(python(env));
    expect(transformSecrets({ providers: {} })).toEqual({ ai: { providers: {} } });
  });

  it('loads the source JS facade from another cwd against an explicitly selected root', () => {
    const result = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(require(process.argv[1]).getConfig()))', path.join(scripts, 'config-loader.js')], {
      cwd: os.tmpdir(), windowsHide: true, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, DANMAKU_PROJECT_ROOT: root, NODE_ENV: 'production', CONFIG_PATH: path.join(root, 'explicit.json') }
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).marker).toBe('explicit');
  });
});
