import * as fs from 'fs';
import * as path from 'path';
import contract from './config-contract.json';
import { getProjectRoot } from './ProjectPaths';

export type ConfigObject = { [key: string]: unknown };
export interface LayerOptions {
  root?: string;
  env?: NodeJS.ProcessEnv;
  configPath?: string;
}

function isObject(value: unknown): value is ConfigObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(target: ConfigObject, source: ConfigObject): ConfigObject {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const previous = result[key];
    result[key] = isObject(previous) && isObject(value) ? deepMerge(previous, value) : value;
  }
  return result;
}

function getValue(source: ConfigObject, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((value, key) => isObject(value) ? value[key] : undefined, source);
}

function setValue(target: ConfigObject, dottedPath: string, value: unknown): void {
  const keys = dottedPath.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(current[key])) current[key] = {};
    current = current[key] as ConfigObject;
  }
  const key = keys[keys.length - 1];
  current[key] = isObject(current[key]) && isObject(value) ? deepMerge(current[key], value) : value;
}

export function transformSecrets(secrets: ConfigObject): ConfigObject {
  const result: ConfigObject = {};
  for (const mapping of contract.secretMappings) {
    const value = mapping.sources.map(source => getValue(secrets, source)).find(value => Boolean(value));
    if (value !== undefined) setValue(result, mapping.target, value);
  }
  const alias = contract.daiYuTextAlias;
  const provider = getValue(result, alias.provider);
  if (isObject(provider) && provider.apiKey) {
    setValue(result, `${alias.target}.apiKey`, provider.apiKey);
    setValue(result, `${alias.target}.baseUrl`, typeof provider.baseURL === 'string' && provider.baseURL
      ? provider.baseURL.replace(/\/v1$/, '') : (provider.baseUrl || alias.defaultBaseUrl));
  }
  return result;
}

export function readJsonObject(file: string): ConfigObject {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!isObject(value)) throw new Error(`Configuration must be a JSON object: ${file}`);
  return value;
}

export function findConfigPaths(options: LayerOptions = {}): string[] {
  const root = options.root || getProjectRoot();
  const env = options.env || process.env;
  const base = path.join(root, 'config', contract.baseFile);
  const explicit = options.configPath || env.CONFIG_PATH;
  const selected = explicit
    ? path.resolve(root, explicit)
    : contract.productionEnvironments.includes(env.NODE_ENV || contract.defaultEnvironment)
      ? path.join(root, 'config', contract.productionFile) : base;
  if (explicit && !fs.existsSync(selected)) throw new Error(`Explicit configuration file does not exist: ${selected}`);
  return [fs.existsSync(selected) ? selected : base].filter(file => fs.existsSync(file));
}

export function findSecretsPath(root = getProjectRoot()): string {
  return path.join(root, 'config', contract.secretFile);
}

/** Shared precedence before runtime-specific schema validation/defaults. */
export function loadConfigLayers(options: LayerOptions = {}): ConfigObject {
  const root = options.root || getProjectRoot();
  const env = options.env || process.env;
  let config: ConfigObject = {};
  for (const file of findConfigPaths({ ...options, root, env })) config = deepMerge(config, readJsonObject(file));
  const secretFile = findSecretsPath(root);
  if (fs.existsSync(secretFile)) config = deepMerge(config, transformSecrets(readJsonObject(secretFile)));
  for (const [variable, target] of Object.entries(contract.environmentMappings)) {
    if (env[variable]) setValue(config, target, env[variable]);
  }
  return config;
}
