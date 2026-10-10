'use client';
import { useEffect, useState } from 'react';
import { ConfigDocument } from '../../core/admin/contracts';
import { api, dateText, useResource } from './client';

const names: Record<string, string> = { production: '生产配置', default: '开发配置', 'live-vote': '直播机器人', secrets: '凭据覆盖', 'generation-modes': '生成模式' };
const sections: Record<string, string> = { app: '应用', webhook: '录播与 Webhook', audio: '音频与存储', asr: '字幕识别', ai: '文本与模型',
  ownStreamClips: '本场切片', clipTopics: '关键词切片', streamActivityClips: '歌曲与同步视听', streamGameClips: '游戏归档', bilibili: 'B 站与回复',
  wechatWork: '通知', questions: '历史问答', reminders: '直播提醒', storage: '存储', fusion: '融合', comic: '漫画' };
export function ConfigEditor() {
  const list = useResource<{ names: string[] }>('/configs'), [name, setName] = useState('production');
  const doc = useResource<ConfigDocument>(`/configs/${name}`);
  const [value, setValue] = useState<Record<string, any>>(), [section, setSection] = useState(''), [draft, setDraft] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!doc.data) return;
    setValue(doc.data.value); const first = Object.keys(doc.data.value)[0] || ''; setSection(first);
    setDraft(JSON.stringify(doc.data.value[first], null, 2)); setDirty(false); setError('');
  }, [doc.data]);
  function choose(key: string) {
    try {
      const next = { ...value, [section]: JSON.parse(draft) }; setValue(next); setSection(key); setDraft(JSON.stringify(next[key], null, 2)); setError('');
    } catch { setError('当前分组的 JSON 无效，请修正后切换'); }
  }
  async function save() {
    if (!doc.data) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = { ...value, [section]: JSON.parse(draft) };
      await api(`/configs/${name}`, { revision: doc.data.revision, value: next }, 'PUT');
      setMessage('配置已保存，原文件已备份。常驻服务需要在下次部署或重启后读取新配置。'); doc.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败'); }
    finally { setBusy(false); }
  }
  function addReminderPolicy() {
    if (!value) return;
    const base = typeof value.statePath === 'string' ? value.statePath.replace(/[^\\/]+$/u, '') : '';
    const next = { ...value, reminders: { enabled: false, roomId: '25788785', statePath: `${base}live-reminders.json`,
      notificationConfigPath: value.credentialConfigPath || '', startMinutes: 15, endMinutes: 60, minGapMinutes: 10, quietMaxPerMinute: 12, quietRatio: 0.5 } };
    setValue(next); setSection('reminders'); setDraft(JSON.stringify(next.reminders, null, 2)); setDirty(true);
  }
  return <>
    <div className="toolbar"><div className="segmented">{(list.data?.names || ['production', 'default', 'live-vote']).map(item => <button key={item} className={name === item ? 'selected' : ''} onClick={() => {
      if (dirty && !window.confirm('有未保存修改，确定切换配置？')) return; setName(item); setMessage('');
    }}>{names[item] || item}</button>)}</div><button className="primary" disabled={busy || !dirty || !doc.data} onClick={() => void save()}>{busy ? '保存中…' : '保存配置'}</button></div>
    {(error || doc.error || list.error) && <div role="alert" className="notice error">{error || doc.error || list.error}</div>}
    {message && <div role="status" className="notice">{message}</div>}
    {doc.loading ? <div className="empty">读取配置…</div> : value && <div className="config-layout">
      <aside className="section-list"><div className="eyebrow">配置分组</div>{Object.keys(value).map(key => <button key={key} className={key === section ? 'selected' : ''} onClick={() => choose(key)}>{sections[key] || key}</button>)}
        {name === 'live-vote' && !value.reminders && <button onClick={addReminderPolicy}>＋ 添加提醒配置</button>}</aside>
      <section className="config-editor"><div className="section-heading"><h2>{sections[section] || section}</h2><span>{dirty ? '有未保存修改' : `更新于 ${dateText(doc.data?.updatedAt)}`}</span></div>
        <p className="muted">保留隐藏占位值可保持原凭据；填写新值可替换凭据。</p>
        {name !== 'secrets' && <p className="muted">凭据覆盖和环境变量优先于主配置；常驻服务的修改需在下次部署时应用。</p>}
        <textarea aria-label="配置 JSON" className="code-editor" value={draft} onChange={event => { setDraft(event.target.value); setDirty(true); setMessage(''); }} spellCheck={false} />
        <div className="toolbar"><span className="muted">修改整个分组，其他分组保留。</span><button onClick={() => { if (!dirty || window.confirm('放弃未保存修改？')) doc.refresh(); }}>重新加载</button></div>
      </section>
    </div>}
  </>;
}
