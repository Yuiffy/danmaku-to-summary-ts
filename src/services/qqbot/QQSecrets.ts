import * as path from 'path';
import { ConfigObject, readJsonObject } from '../../core/config/ConfigLayers';
import { QQConfig } from './QQPolicy';

/** Dedicated QQ fields only; never falls back to global provider/env keys. */
export function readQQSecrets(root: string, config: QQConfig): { credentials: ConfigObject; provider: ConfigObject } {
  if (config.secretConfigPath) {
    const qqbot = readJsonObject(path.resolve(root, config.secretConfigPath)).qqbot;
    if (!qqbot || typeof qqbot !== 'object' || Array.isArray(qqbot)) throw new Error('QQ secrets section required');
    const { appId, appSecret, keyName, baseUrl, apiKey } = qqbot as ConfigObject;
    return { credentials: { appId, appSecret }, provider: { keyName, baseUrl, apiKey } };
  }
  return { credentials: readJsonObject(path.resolve(root, config.credentialsPath!)),
    provider: readJsonObject(path.resolve(root, config.providerConfigPath!)) };
}
