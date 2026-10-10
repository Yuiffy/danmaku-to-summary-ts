import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

export class AdminError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function readText(file: string, maxBytes = 8 * 1024 * 1024): string {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > maxBytes) throw new AdminError('文件超出读取限制');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '');
}
export function readJson(file: string, fallback?: any): any {
  if (!fs.existsSync(file) && fallback !== undefined) return structuredClone(fallback);
  return JSON.parse(readText(file, 64 * 1024 * 1024));
}
export function atomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staging, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(staging, file);
  } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
}
export const HIDDEN = '•••• 已隐藏，保留此值则不修改 ••••';
const secretKey = /(?:cookie|token|password|secret|api[_-]?key|webhookurl|authorization|credential)$/iu;
export function redact(value: any, key = '', mask: (secret: any) => string = () => HIDDEN): any {
  if (secretKey.test(key) && value !== null && value !== '') return mask(value);
  if (typeof value === 'string' && /[?&](?:key|token|api_key)=/iu.test(value)) return mask(value);
  if (Array.isArray(value)) return value.map(item => redact(item, '', mask));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name, mask)]));
  return value;
}
export function restoreHidden(value: any, original: any, secrets?: Map<string, any>): any {
  if (secrets?.has(value)) return secrets.get(value);
  if (typeof value === 'string' && value.startsWith(HIDDEN) && secrets) throw new AdminError('隐藏凭据已过期，请重新加载配置');
  if (value === HIDDEN) {
    if (original === undefined) throw new AdminError('隐藏占位值没有对应的原配置');
    return original;
  }
  if (Array.isArray(value)) return value.map((item, index) => restoreHidden(item, original?.[index], secrets));
  if (value && typeof value === 'object') {
    if (Object.keys(value).some(key => ['__proto__', 'constructor', 'prototype'].includes(key))) throw new AdminError('配置包含非法字段');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreHidden(item, original?.[key], secrets)]));
  }
  return value;
}
