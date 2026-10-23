'use client';
import { FormEvent, useState } from 'react';
import type { BilibiliLoginSaved, BilibiliLoginStatus } from '../../core/admin/bilibiliLogin';
import { api, dateText, useResource } from './client';

export function BilibiliLogin() {
  const resource = useResource<BilibiliLoginStatus>('/bilibili/login');
  const [saved, setSaved] = useState<BilibiliLoginStatus>();
  const [cookie, setCookie] = useState(''), [acTimeValue, setAcTimeValue] = useState('');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const status = saved || resource.data;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!status || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api<BilibiliLoginSaved>('/bilibili/login', { revision: status.revision, cookie, acTimeValue });
      setSaved(result.status); setCookie(''); setAcTimeValue(''); setMessage(result.message);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重新检查状态'); }
    finally { setBusy(false); }
  }
  return <div className="login-recovery">
    <div className="toolbar"><p className="muted">检查鹿饼登录，或用浏览器中同次登录的凭据恢复。</p>
      <button disabled={busy || resource.loading} onClick={() => { setSaved(undefined); resource.refresh(); }}> {resource.loading ? '检查中…' : '重新检查'}</button></div>
    {(error || resource.error) && <div className="notice error" role="alert">{error || resource.error}</div>}
    {message && <div className="notice" role="status">{message}</div>}
    {status && <section className="login-status" aria-label="当前登录状态">
      <h2>{({ valid: '登录有效', invalid: '登录需要恢复', missing: '尚未配置登录', unavailable: '暂时无法检查登录' })[status.login]}</h2>
      <p>{status.accountName || '鹿饼'} · UID {status.expectedUid}</p>
      <dl>
        <div><dt>评论服务</dt><dd>{{ valid: '登录有效', invalid: '登录失效', unavailable: '暂时无法确认' }[status.service]}</dd></div>
        <div><dt>Cookie 刷新检查</dt><dd>{{ needed: '需要刷新', 'not-needed': '暂不需要刷新', unavailable: '暂时无法确认' }[status.refresh]}</dd></div>
        <div><dt>自动刷新凭据</dt><dd>{status.hasRefreshToken ? '已配置' : '未配置'}</dd></div>
        <div><dt>录播 Cookie 同步</dt><dd>{{ current: '已同步，守护正常', pending: '等待同步或守护恢复', disabled: '未启用自动同步', unavailable: '暂时无法确认' }[status.recorderSync]}</dd></div>
      </dl>
      <p className="muted">配置更新于 {dateText(status.updatedAt)} · 检查于 {dateText(status.checkedAt)}</p>
    </section>}
    <form onSubmit={submit} autoComplete="off">
      <h2>恢复登录</h2>
      <p>在浏览器登录鹿饼账号，从开发者工具“网络”中复制 B 站请求头的完整 Cookie；需包含 SESSDATA、bili_jct 和 DedeUserID。</p>
      <label htmlFor="login-cookie">完整 Cookie</label>
      <textarea id="login-cookie" required rows={5} maxLength={32768} value={cookie} onChange={event => setCookie(event.target.value)} spellCheck={false} autoCapitalize="none" disabled={busy} />
      <label htmlFor="login-refresh">ac_time_value</label>
      <input id="login-refresh" required type="password" maxLength={8192} value={acTimeValue} onChange={event => setAcTimeValue(event.target.value)} autoComplete="off" disabled={busy} />
      <p className="muted">从同次登录的“应用 → 本地存储 → https://www.bilibili.com”复制 ac_time_value。请勿使用 document.cookie，它不包含完整登录凭据。</p>
      <p className="muted">保存前会核对账号，保存时备份原配置。已保存的凭据不会回显；开启录播同步时，守护会自动同步，必要时短暂重启录播服务。</p>
      <button className="primary" disabled={busy || resource.loading || !status || !cookie.trim() || !acTimeValue.trim()}>{busy ? '验证并保存中…' : '验证并保存登录'}</button>
    </form>
  </div>;
}
