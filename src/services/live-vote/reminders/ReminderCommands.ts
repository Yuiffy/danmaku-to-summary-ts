import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { ReminderItem, ReminderState, validateReminderState } from './ReminderPolicy';

export type ReminderEdit = { action: 'switch'; enabled: boolean }
  | { action: 'upsert'; item: ReminderItem }
  | { action: 'pause' | 'resume' };
export interface ReminderOperatorCommand {
  id: string;
  createdAt: string;
  edit: ReminderEdit;
}

export function validateReminderEdit(value: unknown, maxChars: number): asserts value is ReminderEdit {
  const edit = value as ReminderEdit;
  if (!edit || !['switch', 'upsert', 'pause', 'resume'].includes(edit.action)) throw new Error('无效提醒操作');
  if (edit.action === 'switch' && typeof edit.enabled !== 'boolean') throw new Error('提醒开关无效');
  if (edit.action === 'upsert') {
    validateReminderState({ version: 1, enabled: true, nextId: 1, receipts: [], items: [edit.item] }, maxChars);
  }
}

/** Retain send receipts and acknowledge each operator intent in the same state write. */
export function applyReminderEdit(state: ReminderState, edit: ReminderEdit, sessionStart?: number): void {
  if (edit.action === 'switch') state.enabled = edit.enabled;
  if (edit.action === 'pause') {
    if (!sessionStart) throw new Error('当前没有开播信息，无法暂停本场');
    state.pausedSession = sessionStart;
  }
  if (edit.action === 'resume') delete state.pausedSession;
  if (edit.action === 'upsert') {
    if (state.items.some(item => item.id !== edit.item.id && item.name === edit.item.name)) throw new Error('提醒名称已存在');
    const index = state.items.findIndex(item => item.id === edit.item.id);
    if (index < 0) {
      if (state.items.length >= 10) throw new Error('最多 10 个提醒项目');
      state.items.push(structuredClone(edit.item));
    } else state.items[index] = structuredClone(edit.item);
  }
}

/** The web service only appends operator intents; the bot remains the state writer. */
export class ReminderCommandInbox {
  readonly directory: string;
  constructor(statePath: string) { this.directory = `${statePath}.commands`; }
  enqueue(edit: ReminderEdit, maxChars: number): ReminderOperatorCommand {
    validateReminderEdit(edit, maxChars);
    if (this.list().length >= 100) throw new Error('提醒管理指令积压，请先检查机器人');
    const command = { id: randomUUID(), createdAt: new Date().toISOString(), edit };
    fs.mkdirSync(this.directory, { recursive: true });
    const file = path.join(this.directory, `${command.id}.json`), staging = `${file}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(command), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(staging, file);
    return command;
  }
  list(): ReminderOperatorCommand[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.json$/u.test(name)).map(name => {
      const file = path.join(this.directory, name);
      if (fs.statSync(file).size > 16 * 1024) throw new Error('提醒指令文件过大');
      const command = JSON.parse(fs.readFileSync(file, 'utf8')) as ReminderOperatorCommand;
      if (`${command.id}.json` !== name || !Number.isFinite(Date.parse(command.createdAt))) throw new Error('提醒指令文件无效');
      return command;
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
  complete(id: string, error?: string): void {
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new Error('提醒指令 ID 无效');
    const file = path.join(this.directory, `${id}.json`);
    fs.writeFileSync(path.join(this.directory, `${id}.result.json`), JSON.stringify({ id, at: new Date().toISOString(),
      status: error ? 'rejected' : 'applied', message: error || '修改已生效' }), 'utf8');
    if (error) {
      fs.writeFileSync(`${file}.error`, error, 'utf8');
      fs.renameSync(file, `${file}.rejected`);
    } else if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  results(): { id: string; at: string; status: string; message: string }[] {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.result\.json$/u.test(name))
      .map(name => JSON.parse(fs.readFileSync(path.join(this.directory, name), 'utf8')))
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20);
  }
}
