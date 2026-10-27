import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readQQSecrets } from './QQSecrets';
import { QQConfig, QQ_PRIVATE_REPLY, validateQQConfig } from './QQPolicy';
import { redact } from '../admin/AdminFiles';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-secrets-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const config: QQConfig = { secretConfigPath: 'secret.json', dailyTokenBudget: 409600, maxQueue: 20, maxUserQueue: 2, privateReply: QQ_PRIVATE_REPLY };
test('reads dedicated central QQ section and masks both provider and bot secret', () => {
  const qqbot = { appId: '900000001', appSecret: 'fake-bot-secret', keyName: 'qq鹿饼用', baseUrl: 'http://127.0.0.1:8080', apiKey: 'fake-qq-key' };
  fs.writeFileSync(path.join(root, 'secret.json'), JSON.stringify({ qqbot, daiYu: { apiKey: 'wrong-key' } }));
  expect(() => validateQQConfig(config)).not.toThrow();
  expect(readQQSecrets(root, config)).toEqual({ credentials: { appId: qqbot.appId, appSecret: qqbot.appSecret },
    provider: { keyName: qqbot.keyName, baseUrl: qqbot.baseUrl, apiKey: qqbot.apiKey } });
  const masked = JSON.stringify(redact({ qqbot }));
  expect(masked).not.toContain('fake-bot-secret'); expect(masked).not.toContain('fake-qq-key');
});
test('missing QQ key never falls back to other central providers or legacy files', () => {
  fs.writeFileSync(path.join(root, 'secret.json'), JSON.stringify({ qqbot: { appId: '900000001', appSecret: 'fake' }, daiYu: { apiKey: 'wrong-key' } }));
  expect(readQQSecrets(root, { ...config, providerConfigPath: 'missing.json' }).provider.apiKey).toBeUndefined();
  fs.writeFileSync(path.join(root, 'secret.json'), JSON.stringify({ daiYu: { apiKey: 'wrong-key' } }));
  expect(() => readQQSecrets(root, config)).toThrow('QQ secrets section required');
});
