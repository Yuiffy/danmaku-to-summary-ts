'use client';
import { useState } from 'react';
import { api } from './client';

export function StreamWorkflowForm({ onQueued }: { onQueued: () => void }) {
  const [form, setForm] = useState({ workflow: 'activity', kind: 'both', mediaPath: '', srtPath: '', xmlPath: '', summaryPath: '', fullContextPath: '' });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(action: string) {
    setBusy(true); setError('');
    try { await api('/workflows/actions', { ...form, action }); onQueued(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '制作失败'); }
    finally { setBusy(false); }
  }
  return <section className="manual-review"><h2>完整直播内容制作</h2><p className="muted">沿用歌曲、同步视听和游戏的专用工作流，保留连续内容和原音。制作使用人工审核模式，完成后到视频审核页检查整包。</p>
    {error && <div className="notice error" role="alert">{error}</div>}
    <form onSubmit={event => { event.preventDefault(); void submit('run'); }}><div className="form-grid">
      <label>工作流<select value={form.workflow} onChange={event => setForm({ ...form, workflow: event.target.value })}><option value="activity">歌切 / 同步视听</option><option value="game">完整游戏归档</option></select></label>
      {form.workflow === 'activity' && <label>内容类型<select value={form.kind} onChange={event => setForm({ ...form, kind: event.target.value })}><option value="both">歌曲与同步视听</option><option value="songs">歌曲</option><option value="watch">同步视听</option></select></label>}
    </div><div className="form-stack"><label>完整录播路径<input required value={form.mediaPath} onChange={event => setForm({ ...form, mediaPath: event.target.value })} /></label><label>整场 SRT 路径<input required value={form.srtPath} onChange={event => setForm({ ...form, srtPath: event.target.value })} /></label><label>弹幕 XML（可选）<input value={form.xmlPath} onChange={event => setForm({ ...form, xmlPath: event.target.value })} /></label>
      {form.workflow === 'activity' && <><label>共享 LIVE_CONTENT.json（可选）<input value={form.summaryPath} onChange={event => setForm({ ...form, summaryPath: event.target.value })} /></label><label>共享 FULL_LIVE_CONTEXT.json（可选）<input value={form.fullContextPath} onChange={event => setForm({ ...form, fullContextPath: event.target.value })} /></label><p className="muted">留空时沿用录播旁的共享梗概；缺少匹配梗概时报告失败，请先完成原有直播总结。</p></>}
    </div><div className="button-row"><button type="button" disabled={busy || !form.mediaPath || !form.srtPath} onClick={() => void submit('plan')}>只生成计划</button><button className="primary" disabled={busy} type="submit">制作完整投稿包</button></div><p className="muted">计划与制作会使用既有模型 / ASR 配置。这里不自动投稿或发送通知。</p></form>
  </section>;
}

export function ActivityRevision({ busy, kind, act }: { busy: boolean; kind?: string; act: (action: string, extra: Record<string, unknown>) => Promise<void> }) {
  const [form, setForm] = useState({ summaryPath: '', fullContextPath: '', transcriptRecordPath: '', titleEvidencePath: '', contentName: '', evidenceFrame: '', reviseVerifier: false, reviewPrelude: false });
  return <section className="inspector-section"><p className="muted">修订沿用本包源录播和数字 ID，保留旧视频。修订完成后重新审核；说明填写在下方。</p>
    <details><summary>曲名 / 作品名证据与包装</summary><div className="form-stack"><label>已核对名称证据 JSON 路径<input value={form.titleEvidencePath} onChange={event => setForm({ ...form, titleEvidencePath: event.target.value })} placeholder="包含 items、activityId、name、segmentIndices、note" /></label><label>单活动作品名（可选）<input value={form.contentName} onChange={event => setForm({ ...form, contentName: event.target.value })} /></label><label>作品名原帧路径<input value={form.evidenceFrame} onChange={event => setForm({ ...form, evidenceFrame: event.target.value })} /></label></div><button disabled={busy} onClick={() => void act('restyle', { titleEvidencePath: form.titleEvidencePath, contentName: form.contentName, evidenceFrame: form.evidenceFrame })}>按已核对证据更新包装</button></details>
    <details><summary>原音边界重审 / 字幕时间修复</summary><div className="form-stack"><label>匹配的新 LIVE_CONTENT.json（可选）<input value={form.summaryPath} onChange={event => setForm({ ...form, summaryPath: event.target.value })} /></label><label>匹配的新 FULL_LIVE_CONTEXT.json（可选）<input value={form.fullContextPath} onChange={event => setForm({ ...form, fullContextPath: event.target.value })} /></label><label>可信时间修复 RESULT.json<input value={form.transcriptRecordPath} onChange={event => setForm({ ...form, transcriptRecordPath: event.target.value })} /></label></div>
      <label className="check-label"><input type="checkbox" checked={form.reviseVerifier} onChange={event => setForm({ ...form, reviseVerifier: event.target.checked })} />使用当前配置修订边界复核路线</label>
      {kind === 'songs' && <label className="check-label"><input type="checkbox" checked={form.reviewPrelude} onChange={event => setForm({ ...form, reviewPrelude: event.target.checked })} />补充独立 ASR 前奏复核</label>}
      <div className="button-row"><button disabled={busy} onClick={() => void act('retry-boundaries', { summaryPath: form.summaryPath, fullContextPath: form.fullContextPath, reviseVerifier: form.reviseVerifier, reviewPrelude: form.reviewPrelude })}>重审未确认边界</button><button disabled={busy || !form.transcriptRecordPath} onClick={() => void act('repair-timing', { summaryPath: form.summaryPath, fullContextPath: form.fullContextPath, transcriptRecordPath: form.transcriptRecordPath })}>修复时间并重制本场两类包</button></div><p className="muted">仅适用现有待核包。原 CLI 检查同源身份、预算与修复证据；已批准或投稿中的包受原保护约束。</p>
    </details>
  </section>;
}
