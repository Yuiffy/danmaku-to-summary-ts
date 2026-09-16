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

/** Resolve presets before any language-specific defaults. Room overrides win. */
export function resolveGenerationModes(config: ConfigObject, catalog: ConfigObject = {}): ConfigObject {
  if (!isObject(config.ai)) return config;
  const ai = config.ai;
  const modes = deepMerge(catalog, isObject(ai.generationModes) ? ai.generationModes : {});
  const rooms = isObject(ai.roomSettings) ? ai.roomSettings : {};
  const allowed = new Set(['wordLimit', 'minComicDurationMinutes', 'comicGenerationProbability',
    'fullLiveContextExperiment', 'imageGeneration']);
  const resolved = new Map<string, ConfigObject>();
  const resolve = (name: unknown, visiting: string[] = []): ConfigObject => {
    if (typeof name !== 'string' || !name || !Object.prototype.hasOwnProperty.call(modes, name)) {
      throw new Error(`Unknown generation mode: ${String(name)}`);
    }
    if (visiting.includes(name)) throw new Error(`Generation mode inheritance cycle: ${[...visiting, name].join(' -> ')}`);
    const cached = resolved.get(name);
    if (cached) return cached;
    const mode = modes[name];
    if (!isObject(mode) || !isObject(mode.settings)) throw new Error(`Invalid generation mode: ${name}`);
    for (const key of Object.keys(mode.settings)) if (!allowed.has(key)) throw new Error(`Invalid generation mode setting: ${name}.${key}`);
    const parent = mode.extends === undefined ? {} : resolve(mode.extends, [...visiting, name]);
    const settings = deepMerge(parent, mode.settings);
    resolved.set(name, settings);
    return settings;
  };
  for (const name of Object.keys(modes)) resolve(name);
  if (ai.defaultGenerationMode !== undefined) resolve(ai.defaultGenerationMode);
  const expanded = Object.fromEntries(Object.entries(rooms).map(([id, room]) => {
    if (!isObject(room)) throw new Error(`Invalid room settings: ${id}`);
    const name = room.generationMode ?? ai.defaultGenerationMode;
    return [id, name === undefined ? room : { ...deepMerge(structuredClone(resolve(name)), room), generationMode: name }];
  }));
  return { ...config, ai: { ...ai, ...(Object.keys(modes).length ? { generationModes: modes } : {}),
    ...(ai.roomSettings !== undefined ? { roomSettings: expanded } : {}) } };
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
  const modesFile = path.join(root, 'config', 'generation-modes.json');
  let modes: ConfigObject = {};
  if (fs.existsSync(modesFile)) {
    const catalog = readJsonObject(modesFile);
    if (catalog.schemaVersion !== 1 || !isObject(catalog.modes)) throw new Error('Invalid generation mode catalog');
    modes = catalog.modes;
  }
  return resolveGenerationModes(config, modes);
}
