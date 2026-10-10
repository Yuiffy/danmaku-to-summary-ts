import * as fs from 'fs';
import * as path from 'path';
import { createHmac, randomBytes } from 'crypto';
import { ConfigDocument } from '../../core/admin/contracts';
import { ConfigValidator } from '../../core/config/ConfigValidator';
import { reminderOptions } from '../live-vote/reminders/ReminderPolicy';
import { validateQuestionConfig } from '../live-vote/questions/QuestionPolicy';
import { resolveGenerationModes } from '../../core/config/ConfigLayers';
import { AdminError, atomicJson, digest, HIDDEN, readJson, readText, redact, restoreHidden } from './AdminFiles';

export class AdminConfigStore {
  private readonly files: Record<string, string>;
  private readonly maskKey = randomBytes(32);
  constructor(private readonly root: string, voteConfig = path.join(root, 'data/runtime/live-vote.json')) {
    this.files = { production: path.join(root, 'config/production.json'), default: path.join(root, 'config/default.json'),
      'live-vote': voteConfig, secrets: path.join(root, 'config/secret.json'), 'generation-modes': path.join(root, 'config/generation-modes.json') };
  }
  path(name: string): string {
    if (!Object.hasOwn(this.files, name)) throw new AdminError('未知配置', 404);
    return this.files[name];
  }
  list(): string[] { return Object.keys(this.files).filter(name => fs.existsSync(this.files[name])); }
  get(name: string): ConfigDocument {
    const file = this.path(name), text = readText(file);
    return { name, value: redact(JSON.parse(text), '', secret => this.marker(secret)), revision: digest(text), updatedAt: fs.statSync(file).mtime.toISOString() };
  }
  private marker(secret: any): string { return `${HIDDEN} [${createHmac('sha256', this.maskKey).update(JSON.stringify(secret)).digest('hex').slice(0, 24)}]`; }
  rawVote(): any { return readJson(this.path('live-vote'), {}); }
  save(name: string, revision: string, value: unknown): ConfigDocument {
    const file = this.path(name), text = readText(file);
    if (revision !== digest(text)) throw new AdminError('配置已被其他操作修改，请重新加载后再保存', 409);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminError('配置必须是 JSON 对象');
    const secrets = new Map<string, any>();
    redact(JSON.parse(text), '', secret => { const marker = this.marker(secret); secrets.set(marker, secret); return marker; });
    const restored = restoreHidden(value, JSON.parse(text), secrets);
    if (name === 'live-vote') {
      if (!['recorder', 'xml', 'bilibili'].includes(restored.source)) throw new AdminError('直播机器人来源无效');
      if (restored.maxMessageChars !== undefined && (!Number.isInteger(restored.maxMessageChars) || restored.maxMessageChars < 20 || restored.maxMessageChars > 40)) throw new AdminError('弹幕字数应为 20–40');
      if (restored.reminders) {
        try { reminderOptions(restored.reminders); } catch { throw new AdminError('直播提醒策略无效，请核对时间窗、房间 ID 与安静阈值'); }
        if (!path.isAbsolute(restored.reminders.statePath || '') || !path.isAbsolute(restored.reminders.notificationConfigPath || '')) throw new AdminError('提醒状态与通知配置需要绝对路径');
        if (restored.reminders.enabled && (restored.source !== 'recorder' || restored.rooms !== 'auto-record')) throw new AdminError('提醒需要 recorder / auto-record 模式');
      }
      if (restored.questions) { try { validateQuestionConfig(restored.questions); } catch (error) { throw new AdminError(error instanceof Error ? error.message : '问答配置无效'); } }
    } else if (name === 'generation-modes') {
      if (restored.schemaVersion !== 1 || !restored.modes || typeof restored.modes !== 'object' || Array.isArray(restored.modes)) throw new AdminError('生成模式目录无效');
      try { resolveGenerationModes({ ai: {} }, restored.modes); } catch (error) { throw new AdminError(error instanceof Error ? error.message : '生成模式无效'); }
    } else if (name !== 'secrets') {
      const result = ConfigValidator.validate(restored);
      if (!result.valid) throw new AdminError(result.errors.map(error => `${error.path}: ${error.message}`).join('；'));
    }
    // Preserve the original bytes in ignored operator storage before the atomic replacement.
    const backup = path.join(this.root, 'data/runtime/admin/config-backups', `${name}-${Date.now()}-${digest(text).slice(0, 12)}.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, text, { encoding: 'utf8', flag: 'wx' });
    atomicJson(file, restored);
    return this.get(name);
  }
}
