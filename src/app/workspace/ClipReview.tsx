'use client';
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { ClipDetail, ClipSummary } from '../../core/admin/contracts';
import { api, statusText, useResource } from './client';
import { ActivityRevision } from './StreamWorkflows';

interface ClipList { clips: ClipSummary[]; total: number; page: number; counts: Record<string, number>; rooms: string[] }
function subtitleRows(text: string): { id: string; at: number; time: string; text: string }[] {
  return text.replace(/\r/gu, '').trim().split(/\n\s*\n/gu).flatMap(block => {
    const rows = block.split('\n'), line = rows.findIndex(row => row.includes('-->'));
    const match = /^(\d+):(\d+):(\d+)[,.](\d+)/u.exec(rows[line] || '');
    if (!match) return [];
    return [{ id: rows[0], at: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000,
      time: rows[line].split('-->')[0].trim(), text: rows.slice(line + 1).join('\n') }];
  });
}
export function ClipReview({ onJobs }: { onJobs: () => void }) {
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [status, setStatus] = useState(''), [room, setRoom] = useState(''), [page, setPage] = useState(1), [selected, setSelected] = useState<number>();
  const list = useResource<ClipList>(`/clips?${new URLSearchParams({ search: query, status, room, page: String(page) })}`);
  useEffect(() => { const value = new URLSearchParams(window.location.search).get('clip'); if (value && /^[1-9]\d{0,8}$/u.test(value)) setSelected(Number(value)); }, []);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  const held = Object.entries(list.data?.counts || {}).filter(([key]) => !['uploaded', 'excluded', 'cancelled'].includes(key)).reduce((sum, [, count]) => sum + count, 0);
  return <>
    <div className="toolbar"><div className="summary-line"><strong>{list.data?.total ?? '—'}</strong> 个视频 <span>·</span> {held} 个待处理</div><button onClick={list.refresh}>刷新列表</button></div>
    <div className="review-layout"><section className="clip-browser">
      <div className="clip-filters"><input aria-label="搜索视频" placeholder="搜索编号、标题或主播" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="filter-row"><select aria-label="审核状态" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option>{Object.keys(list.data?.counts || {}).map(key => <option key={key} value={key}>{statusText(key)} ({list.data?.counts[key]})</option>)}</select>
          <select aria-label="房间" value={room} onChange={event => { setRoom(event.target.value); setPage(1); }}><option value="">全部房间</option>{list.data?.rooms.map(id => <option key={id}>{id}</option>)}</select></div>
      </div>
      {list.error && <div className="notice error" role="alert">{list.error}</div>}
      {list.loading ? <div className="empty">读取视频…</div> : !list.data?.clips.length ? <div className="empty">没有匹配的视频</div> : <div className="clip-list">{list.data.clips.map(clip => <button key={clip.id} className={selected === clip.id ? 'selected' : ''} onClick={() => setSelected(clip.id)}>
        <div className="clip-row-meta"><span className="mono">#{clip.id}</span><span className={`status status-${clip.status}`}>{statusText(clip.status)}</span></div>
        <strong>{clip.title || '未命名视频'}</strong><small>{clip.streamerName || clip.roomId || '房间未标记'} <span>·</span> {clip.duration || '时长待确认'}</small>
        {clip.issues.length > 0 && <span className="issue-preview">{clip.issues[0]}</span>}
      </button>)}</div>}
      <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil((list.data?.total || 0) / 40))}</span><button disabled={page * 40 >= (list.data?.total || 0)} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </section><section className="review-inspector">{selected ? <ClipInspector key={selected} id={selected} onJobs={onJobs} /> : <div className="review-empty"><span>▷</span><h2>选择一个视频开始审核</h2><p>预览画面、核对字幕与文案，再决定制作或投稿。</p></div>}</section></div>
  </>;
}

function ClipInspector({ id, onJobs }: { id: number; onJobs: () => void }) {
  const [part, setPart] = useState(1);
  const resource = useResource<ClipDetail>(`/clips/${id}?part=${part}`), detail = resource.data;
  const [tab, setTab] = useState('subtitles'), [mode, setMode] = useState('media'), [note, setNote] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [cue, setCue] = useState(''), [enqueue, setEnqueue] = useState(false);
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [coverText, setCoverText] = useState(''), [sourceKind, setSourceKind] = useState('');
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [allowLong, setAllowLong] = useState(false), [durationNote, setDurationNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (detail) { setTitle(detail.title); setDescription(detail.description); setCoverText(detail.coverText); setMode(detail.media ? 'media' : 'preview'); } }, [detail]);
  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!detail) return;
    if (!['preview', 'subtitles'].includes(action) && !note.trim()) { setError('请填写审核或修改说明'); return; }
    const publishing = action === 'enqueue' || action === 'correct' && enqueue;
    if (publishing && !window.confirm(`确认授权 #${id} 入队投稿到 B 站？${action === 'correct' ? '后台将先重制字幕与视频。' : ''}`)) return;
    if (action === 'exclude' && !window.confirm(`确认排除 #${id}，阻止后续投稿？`)) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const body: any = { ...extra, action, revision: detail.revision, note, publishApproved: publishing };
      if (action === 'correct') Object.assign(body, { from, to, cue, enqueue });
      if (['cut', 'approve-review', 'rebuild'].includes(action)) Object.assign(body, { title, description, coverText, sourceKind: action === 'cut' ? '' : sourceKind });
      if (action === 'rebuild') Object.assign(body, { start, end, allowLong, durationNote });
      await api(`/clips/${id}/actions`, body);
      setMessage('操作已排队，在任务与队列中查看执行结果。完成后刷新审核内容。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  }
  const asset = (kind: string) => `/api/admin/clips/${id}/assets/${kind}?v=${detail?.revision}&part=${part}`;
  const isPreview = mode === 'preview', hasVideo = detail && (isPreview ? detail.preview : detail.media);
  const rows = subtitleRows(isPreview ? detail?.previewSubtitles || '' : detail?.category !== 'clip' ? detail?.partSubtitles || '' : detail?.subtitles || '');
  return <>
    <div className="inspector-heading"><span className="mono">#{id}</span><button onClick={resource.refresh} disabled={busy}>刷新审核内容</button></div>
    {resource.loading && <div className="empty">读取审核内容…</div>}
    {(error || resource.error) && <div className="notice error" role="alert">{error || resource.error}</div>}
    {message && <div className="notice" role="status">{message}<button onClick={onJobs}>查看任务 ↗</button></div>}
    {detail && <>
      <h2 className="clip-title">{detail.clip.title}</h2><div className="muted">{detail.clip.streamerName || detail.clip.roomId} · 源起点 {detail.clip.start || '—'} · {detail.clip.duration || '时长待确认'}</div>
      <div className="media-heading"><div className="segmented"><button className={mode === 'media' ? 'selected' : ''} onClick={() => setMode('media')} disabled={!detail.media}>成片</button><button className={mode === 'preview' ? 'selected' : ''} onClick={() => setMode('preview')} disabled={!detail.preview}>粗剪预览</button></div>
        {detail.category === 'clip' && <button disabled={busy} onClick={() => void act('preview')}>生成 / 更新粗剪</button>}</div>
      {detail.parts.length > 0 && <label className="part-selector">投稿分 P<select value={part} onChange={event => setPart(Number(event.target.value))}>{detail.parts.map((next, index) => <option key={index} value={index + 1}>P{index + 1} · {next.title}</option>)}</select></label>}
      {hasVideo ? <video ref={video} key={`${mode}-${part}-${detail.revision}`} className="review-video" src={asset(mode)} controls preload="metadata">
        {(isPreview ? detail.previewSubtitles : detail.parts.length ? detail.parts[part - 1]?.subtitles : detail.mediaSubtitles) && <track kind="subtitles" src={asset(isPreview ? 'preview-subtitles' : 'media-subtitles')} srcLang="zh" label="中文字幕" default />}
      </video> : <div className="media-empty">{mode === 'media' ? '尚无成片，先查看粗剪或执行制作。' : '尚无粗剪，可点击生成粗剪。'}</div>}
      {detail.pendingRebuild && <div className="notice">修订尚未制作。播放器显示已有视频，字幕编辑区显示待制作修订。</div>}
      {detail.clip.issues.length > 0 && <div className="review-issues"><strong>待核对</strong>{detail.clip.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
      <div className="tabs">{[['subtitles', '字幕'], ['copy', '文案与封面'], ['evidence', '审核证据'], ['rebuild', '重制与精剪']].map(([key, label]) => <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
      {tab === 'subtitles' && <section className="inspector-section">
        <div className="section-heading"><h3>{isPreview ? '粗剪字幕' : '候选 / 成片字幕'}</h3>{detail.category === 'clip' && <button onClick={() => void act('subtitles')} disabled={busy}>准备可修改字幕</button>}</div>
        <div className="subtitle-list">{rows.length ? rows.map((row, index) => <button key={index} onClick={() => { if (video.current && (!detail.pendingRebuild || isPreview)) video.current.currentTime = row.at; setCue(isPreview ? '' : row.id); setFrom(row.text); }}><span className="mono">{row.id} · {row.time}</span><span>{row.text}</span></button>) : <p className="muted">还没有字幕文件，点击准备可修改字幕。</p>}</div>
        {isPreview && <p className="muted">粗剪字幕包含上下文。改词使用候选字幕行号，可切换成片核对或留空替换全部匹配。</p>}
        {detail.category === 'clip' && <><div className="form-grid"><label>原文字<input value={from} onChange={event => setFrom(event.target.value)} /></label><label>替换为<input value={to} onChange={event => setTo(event.target.value)} /></label><label>候选字幕行号（可选）<input value={cue} onChange={event => setCue(event.target.value)} inputMode="numeric" /></label></div>
          <label className="check-label"><input type="checkbox" checked={enqueue} onChange={event => setEnqueue(event.target.checked)} />改词后重制并入队投稿</label><button disabled={busy || !from} onClick={() => void act('correct')}>保存确认改词</button></>}
        {detail.category !== 'clip' && <p className="muted">完整投稿包需逐 P 核对原音与边界，使用下方专用审核按钮保存结果。</p>}
      </section>}
      {tab === 'copy' && <section className="inspector-section copy-layout"><div className="form-stack"><label>标题<input readOnly={detail.category !== 'clip'} value={title} onChange={event => setTitle(event.target.value)} /></label><label>简介<textarea readOnly={detail.category !== 'clip'} value={description} onChange={event => setDescription(event.target.value)} rows={5} /></label><label>封面文字<textarea readOnly={detail.category !== 'clip'} value={coverText} onChange={event => setCoverText(event.target.value)} rows={2} /></label>{detail.category === 'clip' && <><label>内容归属<select value={sourceKind} onChange={event => setSourceKind(event.target.value)}><option value="">沿用现有归属</option><option value="live_speech">主播本人发言</option><option value="recount">转述 / 引用</option><option value="playback">播放音频</option><option value="audience">观众弹幕</option></select></label><p className="muted">文案随“制作”或“通过审核”保存；需要新封面时使用“重制”。</p></>}{detail.category === 'activity' && <button disabled={busy} onClick={() => void act('restyle')}>更新歌切 / 视听包装</button>}</div>
        {detail.cover && <Image className="review-cover" src={asset('cover')} alt="当前视频封面" width={480} height={300} unoptimized />}</section>}
      {tab === 'evidence' && <pre className="evidence-view">{JSON.stringify(detail.evidence, null, 2)}</pre>}
      {tab === 'rebuild' && (detail.category === 'clip' ? <section className="inspector-section"><p className="muted">源时间使用整场录播的绝对秒数。重制准备修订，制作生成新视频；精剪会调用配置的 AI 流程。</p><div className="form-grid"><label>开始秒数<input value={start} onChange={event => setStart(event.target.value)} /></label><label>结束秒数<input value={end} onChange={event => setEnd(event.target.value)} /></label></div><label className="check-label"><input type="checkbox" checked={allowLong} onChange={event => setAllowLong(event.target.checked)} />保留完整的长话题</label>{allowLong && <label>完整话题说明<input value={durationNote} onChange={event => setDurationNote(event.target.value)} /></label>}<div className="button-row"><button disabled={busy} onClick={() => void act('rebuild')}>准备重制修订</button><button disabled={busy} onClick={() => void act('precision')}>AI 精剪</button></div></section> : detail.category === 'activity' ? <ActivityRevision busy={busy} kind={detail.evidence.kind} act={act} /> : <p className="muted inspector-section">完整游戏包保留连续内容，可逐 P 预览、审核和整包投稿。</p>)}
      <footer className="review-actions"><label>审核 / 修改说明<textarea value={note} onChange={event => setNote(event.target.value)} placeholder="记录已核对的字幕、归属、边界和修改依据" rows={2} /></label><div className="button-row">{detail.category === 'clip' && <button disabled={busy} onClick={() => void act('cut')}>制作成片</button>}<button disabled={busy || !detail.media} onClick={() => void act('approve-review')}>{detail.category === 'clip' ? '通过审核' : '整包通过审核'}</button><button className="primary" disabled={busy || detail.clip.status === 'uploaded'} onClick={() => void act('enqueue')}>入队投稿</button>{detail.category === 'clip' && <button className="danger-link" disabled={busy || detail.clip.status === 'uploaded'} onClick={() => void act('exclude')}>排除</button>}</div></footer>
    </>}
  </>;
}
