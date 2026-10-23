import * as fs from 'fs';
import * as path from 'path';
import { BilibiliLoginInput, BilibiliLoginSaved, BilibiliLoginStatus } from '../../core/admin/bilibiliLogin';
import { AdminConfigStore } from './AdminConfigStore';
import { AdminError, digest, readJson, readText } from './AdminFiles';
import { checkCommentLogin, createBilibiliLoginProbe, LoginProbe } from './BilibiliLoginProbe';

interface LoginAdapters {
  probe: (cookie: string, signal: AbortSignal) => Promise<LoginProbe>;
  service: (signal: AbortSignal) => Promise<BilibiliLoginStatus['service']>;
}
const cookieValue = (cookie: string, key: string): string => cookie.split(';').map(item => item.trim())
  .find(item => item.startsWith(key + '='))?.slice(key.length + 1) || '';

function loginInput(value: unknown): BilibiliLoginInput {
  const input = value as BilibiliLoginInput;
  if (!input || Object.keys(input).some(key => !['revision', 'cookie', 'acTimeValue'].includes(key)) ||
      typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/u.test(input.revision) ||
      typeof input.cookie !== 'string' || input.cookie.length > 32768 || typeof input.acTimeValue !== 'string' ||
      !input.acTimeValue.trim() || input.acTimeValue.length > 8192 || /[\s\p{Cc}\p{Cf}]/u.test(input.acTimeValue.trim())) {
    throw new AdminError('请填写完整 Cookie 和同次登录的 ac_time_value');
  }
  const cookie = input.cookie.trim().replace(/^Cookie:\s*/iu, '');
  const keys = cookie.split(';').map(item => item.trim().split('=')[0]).filter(Boolean);
  if (/[\p{Cc}\p{Cf}]/u.test(cookie) || new Set(keys).size !== keys.length ||
      !cookieValue(cookie, 'SESSDATA') || !cookieValue(cookie, 'bili_jct') || !/^[1-9]\d*$/u.test(cookieValue(cookie, 'DedeUserID'))) {
    throw new AdminError('Cookie 需要包含 SESSDATA、bili_jct 和 DedeUserID，请从请求头复制');
  }
  return { revision: input.revision, cookie, acTimeValue: input.acTimeValue.trim() };
}

/** Dedicated credential recovery within the existing authenticated operator API. */
export class AdminBilibiliLogin {
  private saving = false;
  constructor(private readonly configs: AdminConfigStore, private readonly root: string,
    private readonly adapters: LoginAdapters = { probe: createBilibiliLoginProbe(), service: checkCommentLogin }) {}

  private snapshot() {
    const file = this.configs.path('secrets'), text = readText(file), config = JSON.parse(text);
    const cookie = typeof config.bilibili?.cookie === 'string' ? config.bilibili.cookie : '';
    const expectedUid = String(this.configs.rawVote().botUid || cookieValue(cookie, 'DedeUserID'));
    if (!/^[1-9]\d*$/u.test(expectedUid)) throw new AdminError('请先在直播机器人配置中设置鹿饼账号 UID');
    return { file, text, config, cookie, expectedUid, revision: digest(text), updatedAt: fs.statSync(file).mtime.toISOString() };
  }

  private recorderSync(cookie: string): BilibiliLoginStatus['recorderSync'] {
    try {
      const settings = readJson(path.join(this.root, 'data/runtime/recorder_watchdog.settings.json'), {});
      const sync = settings.cookieSync;
      if (!sync?.enabled || path.resolve(sync.sourcePath || '') !== path.resolve(this.configs.path('secrets'))) return 'disabled';
      const state = readJson(path.join(this.root, 'data/runtime/recorder_watchdog.state.json'), {});
      if (!Number.isFinite(state.heartbeatAt) || Date.now() - state.heartbeatAt > 120000 || state.heartbeatAt > Date.now() + 60000) return 'unavailable';
      const target = readJson(sync.recorderConfigPath).global?.Cookie?.Value;
      if (typeof target !== 'string') return 'unavailable';
      return ['DedeUserID', 'SESSDATA', 'bili_jct', 'buvid3', 'buvid4'].every(key => cookieValue(cookie, key) === cookieValue(target, key)) &&
        state.phase === 'healthy' && ['current', 'applied'].includes(state.cookieSync?.status) ? 'current' : 'pending';
    } catch { return 'unavailable'; }
  }

  private summary(snapshot: ReturnType<AdminBilibiliLogin['snapshot']>, probe: LoginProbe | undefined,
    service: BilibiliLoginStatus['service']): BilibiliLoginStatus {
    return { revision: snapshot.revision, expectedUid: snapshot.expectedUid,
      login: snapshot.cookie ? probe?.login === 'valid' && probe.uid !== snapshot.expectedUid ? 'invalid' : probe?.login || 'unavailable' : 'missing',
      accountName: probe?.uid === snapshot.expectedUid ? probe.accountName : undefined,
      refresh: probe?.refresh || 'unavailable', hasRefreshToken: !!(snapshot.config.bilibili?.ac_time_value || snapshot.config.bilibili?.acTimeValue),
      service, recorderSync: this.recorderSync(snapshot.cookie), updatedAt: snapshot.updatedAt, checkedAt: new Date().toISOString() };
  }

  async status(signal: AbortSignal): Promise<BilibiliLoginStatus> {
    const snapshot = this.snapshot();
    const [probe, service] = await Promise.all([
      snapshot.cookie ? this.adapters.probe(snapshot.cookie, signal) : undefined, this.adapters.service(signal)
    ]);
    return this.summary(snapshot, probe, service);
  }

  async save(value: unknown, signal: AbortSignal): Promise<BilibiliLoginSaved> {
    const input = loginInput(value);
    if (this.saving) throw new AdminError('另一次登录恢复正在验证，请稍候', 409);
    const before = this.snapshot();
    if (input.revision !== before.revision) throw new AdminError('配置已经变化，请先重新检查登录状态再保存', 409);
    if (cookieValue(input.cookie, 'DedeUserID') !== before.expectedUid) throw new AdminError('Cookie 账号与鹿饼账号不一致，未保存');
    this.saving = true;
    try {
      const probe = await this.adapters.probe(input.cookie, signal);
      signal.throwIfAborted();
      if (probe.login !== 'valid') throw new AdminError(probe.login === 'invalid' ? '登录已失效，请重新复制完整 Cookie' : '暂时无法验证 B 站登录，请稍后重试；配置未修改');
      if (probe.uid !== before.expectedUid) throw new AdminError('B 站返回的登录账号与鹿饼账号不一致，未保存');
      before.config.bilibili = { ...before.config.bilibili, cookie: input.cookie, csrf: cookieValue(input.cookie, 'bili_jct'), ac_time_value: input.acTimeValue };
      this.configs.save('secrets', input.revision, before.config); // Rechecks revision after network IO and keeps the existing backup contract.
      const snapshot = this.snapshot(), service = await this.adapters.service(signal).catch(() => 'unavailable' as const);
      return { status: this.summary(snapshot, probe, service), message: service === 'valid'
        ? '已保存新登录信息，评论服务检查有效。' : '新登录信息已验证并保存；评论服务尚未确认恢复，请稍后重新检查。' };
    } finally { this.saving = false; }
  }
}
