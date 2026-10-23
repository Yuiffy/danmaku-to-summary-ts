'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { AdminJob, ClipDetail, ClipSummary } from '../../core/admin/contracts';
import { api, statusText, useResource } from './client';
import { ActivityRevision } from './StreamWorkflows';
import { subtitleRows } from '../../core/admin/subtitles';
import { SourcePlayer } from './SourcePlayer';
import { CoverEditor } from './CoverEditor';
import { TitleChoiceRef, TitlePicker, TitleStatistics } from './TitlePicker';

interface ClipList { clips: ClipSummary[]; total: number; page: number; counts: Record<string, number>; rooms: string[] }
const feedbackActive = (job?: AdminJob) => !!job && ['queued', 'running'].includes(job.status);
const feedbackFinished = (job?: AdminJob) => !!job && ['succeeded', 'failed', 'interrupted'].includes(job.status);
export function ClipReview({ onJobs }: { onJobs: () => void }) {
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [status, setStatus] = useState(''), [room, setRoom] = useState(''), [page, setPage] = useState(1), [selected, setSelected] = useState<number>();
  const list = useResource<ClipList>(`/clips?${new URLSearchParams({ search: query, status, room, page: String(page) })}`, 5000, true);
  const operations = useResource<{ jobs: AdminJob[] }>('/jobs', 3000, true);
  const [feedbackJobs, setFeedbackJobs] = useState<Record<string, AdminJob>>({});
  const knownJobs = useRef<Record<string, AdminJob>>({});
  const refreshList = list.refresh;
  const updateFeedback = useCallback((job: AdminJob) => {
    const previous = knownJobs.current[job.target];
    if (previous && (previous.createdAt > job.createdAt || previous.id === job.id && (previous.updatedAt > job.updatedAt
      || previous.updatedAt === job.updatedAt && previous.status === job.status && previous.phase === job.phase && previous.output === job.output))) return;
    knownJobs.current[job.target] = job;
    setFeedbackJobs(current => ({ ...current, [job.target]: job }));
    if (previous?.id === job.id && feedbackActive(previous) && feedbackFinished(job)) refreshList();
  }, [refreshList]);
  useEffect(() => {
    for (const job of operations.data?.jobs || []) if (job.action === 'feedback-publish') updateFeedback(job);
  }, [operations.data, updateFeedback]);
  useEffect(() => { const value = new URLSearchParams(window.location.search).get('clip'); if (value && /^[1-9]\d{0,8}$/u.test(value)) setSelected(Number(value)); }, []);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  const held = Object.entries(list.data?.counts || {}).filter(([key]) => !['uploaded', 'excluded', 'cancelled'].includes(key)).reduce((sum, [, count]) => sum + count, 0);
  return <>
    <div className="toolbar"><div className="summary-line"><strong>{list.data?.total ?? '—'}</strong> 个视频 <span>·</span> {held} 个待处理</div><button onClick={list.refresh}>刷新列表</button></div>
    <TitleStatistics />
    <div className="review-layout"><section className="clip-browser">
      <div className="clip-filters"><input aria-label="搜索视频" placeholder="搜索编号、标题或主播" value={search} onChange={event => setSearch(event.target.value)} />
        <div className="filter-row"><select aria-label="审核状态" value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">全部状态</option>{Object.keys(list.data?.counts || {}).map(key => <option key={key} value={key}>{statusText(key)} ({list.data?.counts[key]})</option>)}</select>
          <select aria-label="房间" value={room} onChange={event => { setRoom(event.target.value); setPage(1); }}><option value="">全部房间</option>{list.data?.rooms.map(id => <option key={id}>{id}</option>)}</select></div>
      </div>
      {list.error && <div className="notice error" role="alert">{list.error}</div>}
      {list.loading && !list.data ? <div className="empty">读取视频…</div> : !list.data?.clips.length ? <div className="empty">没有匹配的视频</div> : <div className="clip-list">{list.data.clips.map(clip => {
        const job = feedbackJobs[clip.id], active = feedbackActive(job);
        const label = ['uploaded', 'queued', 'uploading'].includes(clip.status) ? statusText(clip.status)
          : active ? '已提交反馈，正在处理' : job?.status === 'failed' ? '反馈处理失败' : job?.status === 'interrupted' ? '处理已中断'
          : job?.status === 'succeeded' && !['uploaded', 'uploading'].includes(clip.status) ? '已入队投稿' : statusText(clip.status);
        return <button key={clip.id} className={selected === clip.id ? 'selected' : ''} onClick={() => setSelected(clip.id)}>
        <div className="clip-row-meta"><span className="mono">#{clip.id}</span><span className={`status status-${active ? 'queued' : clip.status}`}>{label}</span></div>
        <strong>{clip.reviewTitle || clip.title || '未命名视频'}</strong><small>{clip.streamerName || clip.roomId || '房间未标记'} <span>·</span> {clip.start && `源 ${clip.start} · `}{clip.duration || '时长待确认'}</small>
        {clip.subtitleExcerpt && <span className="subtitle-excerpt">字幕：{clip.subtitleExcerpt}</span>}
        {active ? <span className="issue-preview">{job?.phase || '等待后台处理，可以继续审核其他切片'}</span> : clip.issues.length > 0 && <span className="issue-preview">{clip.issues[0]}</span>}
      </button>; })}</div>}
      <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil((list.data?.total || 0) / 40))}</span><button disabled={page * 40 >= (list.data?.total || 0)} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </section><section className="review-inspector">{selected ? <ClipInspector key={selected} id={selected} onJobs={onJobs} currentFeedback={feedbackJobs[selected]} onFeedback={updateFeedback} /> : <div className="review-empty"><span>▷</span><h2>选择一个视频开始审核</h2><p>预览画面、核对字幕与文案，再决定制作或投稿。</p></div>}</section></div>
  </>;
}

function ClipInspector({ id, onJobs, currentFeedback, onFeedback }: { id: number; onJobs: () => void; currentFeedback?: AdminJob; onFeedback: (job: AdminJob) => void }) {
  const [part, setPart] = useState(1);
  const resource = useResource<ClipDetail>(`/clips/${id}?part=${part}`, 5000, true), detail = resource.data;
  const [tab, setTab] = useState('subtitles'), [mode, setMode] = useState('media'), [note, setNote] = useState('');
  const [from, setFrom] = useState(''), [to, setTo] = useState(''), [cue, setCue] = useState(''), [enqueue, setEnqueue] = useState(false);
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [coverText, setCoverText] = useState(''), [sourceKind, setSourceKind] = useState('');
  const [titleChoice, setTitleChoice] = useState<TitleChoiceRef>(), [titleBusy, setTitleBusy] = useState(false);
  const [start, setStart] = useState(''), [end, setEnd] = useState(''), [allowLong, setAllowLong] = useState(false), [durationNote, setDurationNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const submitting = useRef(false);
  const video = useRef<HTMLVideoElement>(null);
  const [sourceOrigin, setSourceOrigin] = useState<number>();
  const feedback = useResource<{ job: AdminJob | null }>(`/clips/${id}/feedback`, 0, true);
  const polled = feedback.data?.job;
  const job = polled && (!currentFeedback || polled.createdAt > currentFeedback.createdAt || polled.id === currentFeedback.id && polled.updatedAt > currentFeedback.updatedAt) ? polled : currentFeedback;
  const processing = busy || titleBusy || feedbackActive(job);
  const publicationComplete = !!detail && ['uploaded', 'queued', 'uploading'].includes(detail.clip.status);
  const feedbackFailed = !!job && ['failed', 'interrupted'].includes(job.status) && !publicationComplete;
  const restored = useRef(false);
  const observedJob = useRef<AdminJob>();
  const refreshDetail = resource.refresh;
  useEffect(() => {
    if (polled) onFeedback(polled);
  }, [polled, onFeedback]);
  useEffect(() => {
    const previous = observedJob.current; observedJob.current = job;
    if (previous?.id === job?.id && feedbackActive(previous) && feedbackFinished(job)) refreshDetail();
  }, [job, refreshDetail]);
  useEffect(() => {
    if (restored.current || !feedback.data) return;
    restored.current = true;
    const retryNote = feedback.data.job && ['failed', 'interrupted'].includes(feedback.data.job.status) ? feedback.data.job.note || '' : '';
    try { setNote(localStorage.getItem(`clip-feedback-${id}`) ?? retryNote); }
    catch { setNote(retryNote); }
  }, [feedback.data, id]);
  function changeNote(value: string) {
    restored.current = true; setNote(value);
    try { localStorage.setItem(`clip-feedback-${id}`, value); } catch { /* Server saves submitted opinions independently. */ }
  }
  const savedTitle = detail?.title, savedDescription = detail?.description, savedCoverText = detail?.coverText;
  useEffect(() => { if (savedTitle !== undefined) setTitle(savedTitle); }, [savedTitle]);
  useEffect(() => { if (savedDescription !== undefined) setDescription(savedDescription); }, [savedDescription]);
  useEffect(() => { if (savedCoverText !== undefined) setCoverText(savedCoverText); }, [savedCoverText]);
  const loaded = !!detail, hasMedia = !!detail?.media, sourceAvailable = !!detail?.source.available;
  useEffect(() => { if (loaded) setMode(hasMedia ? 'media' : sourceAvailable ? 'source' : 'preview'); }, [loaded, hasMedia, sourceAvailable]);
  async function act(action: string, extra: Record<string, unknown> = {}, actionNote = note) {
    if (!detail || submitting.current) return;
    if (!['preview', 'subtitles'].includes(action) && !actionNote.trim()) { setError('请填写审核或修改说明'); return; }
    const publishing = action === 'feedback-publish' || action === 'enqueue' || action === 'correct' && enqueue;
    if (publishing && action !== 'feedback-publish' && !window.confirm(`确认授权 #${id} 入队投稿到 B 站？${action === 'correct' ? '后台将先重制字幕与视频。' : ''}`)) return;
    if (action === 'exclude' && !window.confirm(`确认排除 #${id}，阻止后续投稿？`)) return;
    submitting.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const body: any = { ...extra, action, revision: detail.revision, note: actionNote, publishApproved: publishing };
      if (titleChoice) Object.assign(body, { titleSetId: titleChoice.setId, titleRevision: titleChoice.revision });
      if (action === 'correct') Object.assign(body, { from, to, cue, enqueue });
      if (['cut', 'approve-review', 'rebuild'].includes(action)) Object.assign(body, { title, description, coverText, sourceKind: action === 'cut' ? '' : sourceKind });
      if (action === 'rebuild') Object.assign(body, { start, end, allowLong, durationNote });
      if (action === 'feedback-publish' && detail.category === 'clip') {
        if (sourceKind) body.sourceKind = sourceKind;
        for (const [key, value] of Object.entries({ title, description, coverText })) {
          if (value !== detail[key as 'title' | 'description' | 'coverText']) body[key] = value;
        }
      }
      const result = await api<AdminJob>(`/clips/${id}/actions`, body);
      if (action === 'feedback-publish') {
        onFeedback(result); setNote('');
        try { localStorage.removeItem(`clip-feedback-${id}`); } catch { /* The saved job retains the submitted opinion. */ }
      }
      else setMessage('操作已提交，请在任务中确认实际执行结果。');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { submitting.current = false; setBusy(false); }
  }
  const asset = (kind: string) => `/api/admin/clips/${id}/assets/${kind}?v=${['media', 'media-subtitles'].includes(kind) ? detail?.mediaRevision || detail?.revision : detail?.revision}&part=${part}`;
  const isPreview = mode === 'preview', isSource = mode === 'source', hasVideo = detail && (isPreview ? detail.preview : detail.media);
  const rows = subtitleRows(isSource ? detail?.source.subtitles || '' : isPreview ? detail?.previewSubtitles || '' : detail?.category !== 'clip' ? detail?.partSubtitles || '' : detail?.subtitles || '');
  return <>
    <div className="inspector-heading"><span className="mono">#{id}</span><button onClick={resource.refresh} disabled={processing}>刷新审核内容</button></div>
    {resource.loading && !detail && <div className="empty">读取审核内容…</div>}
    {(error || resource.error) && <div className="notice error" role="alert">{error || resource.error}</div>}
    {message && <div className="notice" role="status">{message}<button onClick={onJobs}>查看任务 ↗</button></div>}
    {feedback.error && <div className="notice error" role="alert">处理进度暂时无法读取：{feedback.error}</div>}
    {job && <div className={`notice${feedbackFailed ? ' error' : ''}`} role={feedbackFailed ? 'alert' : 'status'}>
      <strong>{publicationComplete ? statusText(detail!.clip.status) : feedbackActive(job) ? '已提交，正在处理' : job.status === 'succeeded' ? '处理完成，已加入投稿队列' : `${statusText(job.status)} · ${job.phase || '等待处理'}`}</strong>
      {feedbackActive(job) && <p>{job.phase || '等待后台处理'}。可以继续选择其他切片，结果会自动更新。</p>}
      {feedbackFailed && <p>修改意见已保留，请根据下方原因补充意见后重试。</p>}
      <details><summary>查看处理过程和已保存的意见</summary><p>{job.note}</p><pre>{job.output || '等待执行…'}</pre></details>
    </div>}
    {detail && <>
      <h2 className="clip-title">{detail.clip.reviewTitle || detail.clip.title}</h2><div className="muted">{detail.clip.streamerName || detail.clip.roomId} · 源起点 {detail.clip.start || '—'} · {detail.clip.duration || '时长待确认'}</div>
      {detail.category === 'clip' && <TitlePicker id={id} clipRevision={detail.revision} baseTitle={detail.title}
        disabled={busy || feedbackActive(job) || publicationComplete} onTitle={setTitle} onChoice={setTitleChoice} onBusy={setTitleBusy} />}
      {detail.clip.subtitleExcerpt && <p className="candidate-excerpt">字幕：{detail.clip.subtitleExcerpt}</p>}
      <div className="media-heading"><div className="segmented"><button className={mode === 'media' ? 'selected' : ''} onClick={() => setMode('media')} disabled={!detail.media && !detail.subtitles}>{detail.media ? '成片' : '候选字幕'}</button><button className={mode === 'preview' ? 'selected' : ''} onClick={() => setMode('preview')} disabled={!detail.preview}>粗剪预览</button><button className={isSource ? 'selected' : ''} onClick={() => { setSourceOrigin(undefined); setMode('source'); }} disabled={!detail.source.available}>原片定位</button></div>
        {detail.category === 'clip' && <button disabled={processing} onClick={() => void act('preview')}>生成 / 更新粗剪</button>}</div>
      {detail.parts.length > 0 && <label className="part-selector">投稿分 P<select value={part} onChange={event => setPart(Number(event.target.value))}>{detail.parts.map((next, index) => <option key={index} value={index + 1}>P{index + 1} · {next.title}</option>)}</select></label>}
      {isSource ? <SourcePlayer id={id} revision={detail.sourceRevision || detail.revision} subtitles={detail.source.subtitles} video={video} onOrigin={setSourceOrigin} /> : hasVideo ? <video ref={video} key={`${mode}-${part}`} className="review-video" src={asset(mode)} controls preload="metadata">
        {(isPreview ? detail.previewSubtitles : detail.parts.length ? detail.parts[part - 1]?.subtitles : detail.mediaSubtitles) && <track kind="subtitles" src={asset(isPreview ? 'preview-subtitles' : 'media-subtitles')} srcLang="zh" label="中文字幕" default />}
      </video> : <div className="media-empty">{mode === 'media' ? '尚无成片，先查看粗剪或执行制作。' : '尚无粗剪，可点击生成粗剪。'}</div>}
      {detail.pendingRebuild && <div className="notice">修订尚未制作。播放器显示已有视频，字幕编辑区显示待制作修订。</div>}
      {detail.clip.issues.length > 0 && <div className="review-issues"><strong>待核对</strong>{detail.clip.issues.map((issue, index) => <p key={index}>{issue}</p>)}</div>}
      <div className="tabs">{[['subtitles', '字幕'], ['copy', '文案与封面'], ['evidence', '审核证据'], ['rebuild', '重制与精剪']].map(([key, label]) => <button key={key} className={tab === key ? 'selected' : ''} onClick={() => setTab(key)}>{label}</button>)}</div>
      {tab === 'subtitles' && <section className="inspector-section">
        <div className="section-heading"><h3>{isSource ? '此时间段的原片字幕' : isPreview ? '粗剪字幕' : '候选 / 成片字幕'}</h3>{detail.category === 'clip' && <button onClick={() => void act('subtitles')} disabled={processing}>准备可修改字幕</button>}</div>
        <div className="subtitle-list">{rows.length ? rows.map((row, index) => <button key={index} onClick={() => { if (video.current && (isSource ? sourceOrigin !== undefined : !detail.pendingRebuild || isPreview)) video.current.currentTime = Math.max(0, row.at - (isSource ? sourceOrigin || 0 : 0)); if (!isSource) { setCue(isPreview ? '' : row.id); setFrom(row.text); } }}><span className="mono">{row.id} · {row.time}</span><span>{row.text}</span></button>) : <p className="muted">{isSource ? '此时间段没有可读取的原片字幕，可直接听原音核对。' : '还没有字幕文件，点击准备可修改字幕。'}</p>}</div>
        {isSource && detail.category === 'clip' && <p className="muted">原片字幕用于选材和定位。确认改词时请切换“{detail.media ? '成片' : '候选字幕'}”，使用候选字幕行号。</p>}
        {isPreview && <p className="muted">粗剪字幕包含上下文。改词使用候选字幕行号，可切换成片核对或留空替换全部匹配。</p>}
        {detail.category === 'clip' && !isSource && <><p className="muted">确认改词可直接写在下方修改意见中，例如：“建功”改成“建构”。</p><details><summary>高级逐字修改</summary><div className="form-grid"><label>原文字<input value={from} onChange={event => setFrom(event.target.value)} /></label><label>替换为<input value={to} onChange={event => setTo(event.target.value)} /></label><label>候选字幕行号（可选）<input value={cue} onChange={event => setCue(event.target.value)} inputMode="numeric" /></label></div>
          <label className="check-label"><input type="checkbox" checked={enqueue} onChange={event => setEnqueue(event.target.checked)} />改词后重制并入队投稿</label><button disabled={processing || !from} onClick={() => void act('correct')}>保存确认改词</button></details></>}
        {detail.category !== 'clip' && <p className="muted">请逐 P 核对原音与边界。没有问题可直接投稿，需要修改时在下方填写意见。</p>}
      </section>}
      {tab === 'copy' && <section className="inspector-section copy-layout"><div className="form-stack"><label>标题<input readOnly value={title} /></label>{detail.category === 'clip' && <p className="muted">在上方“标题方案”中选择或保存手写标题。</p>}<label>简介<textarea readOnly={detail.category !== 'clip'} value={description} onChange={event => setDescription(event.target.value)} rows={5} /></label><label>封面文字<textarea readOnly={detail.category !== 'clip'} value={coverText} onChange={event => setCoverText(event.target.value)} rows={2} /></label>{detail.category === 'clip' && <><label>内容归属<select value={sourceKind} onChange={event => setSourceKind(event.target.value)}><option value="">沿用现有归属</option><option value="live_speech">主播本人发言</option><option value="recount">转述 / 引用</option><option value="playback">播放音频</option><option value="audience">观众弹幕</option></select></label><p className="muted">改好的文案会随“按意见修改并投稿”一起保存和制作。</p></>}{detail.category === 'activity' && <button disabled={processing} onClick={() => void act('restyle')}>更新歌切 / 视听包装</button>}</div>
        <div>{detail.cover && <Image className="review-cover" src={asset('cover')} alt="当前视频封面" width={480} height={300} unoptimized />}
          {detail.media ? <CoverEditor key={`${id}-${part}-${detail.mediaRevision}`} id={id} part={part} detail={detail} text={coverText} onText={setCoverText} disabled={processing} onSaved={resource.refresh} />
            : <p className="muted">成片制作完成后，可以拖动选帧并裁剪封面。</p>}</div></section>}
      {tab === 'evidence' && <pre className="evidence-view">{JSON.stringify(detail.evidence, null, 2)}</pre>}
      {tab === 'rebuild' && (detail.category === 'clip' ? <section className="inspector-section"><p className="muted">源时间使用整场录播的绝对秒数。重制准备修订，制作生成新视频；精剪会调用配置的 AI 流程。</p><div className="form-grid"><label>开始秒数<input value={start} onChange={event => setStart(event.target.value)} /></label><label>结束秒数<input value={end} onChange={event => setEnd(event.target.value)} /></label></div><label className="check-label"><input type="checkbox" checked={allowLong} onChange={event => setAllowLong(event.target.checked)} />保留完整的长话题</label>{allowLong && <label>完整话题说明<input value={durationNote} onChange={event => setDurationNote(event.target.value)} /></label>}<div className="button-row"><button disabled={processing} onClick={() => void act('rebuild')}>准备重制修订</button><button disabled={processing} onClick={() => void act('precision')}>AI 精剪</button></div></section> : detail.category === 'activity' ? <ActivityRevision busy={processing} kind={detail.evidence.kind} act={act} /> : <p className="muted inspector-section">完整游戏包保留连续内容，可逐 P 预览、审核和整包投稿。</p>)}
      <footer className="review-actions"><label>修改意见（可选）<textarea value={note} disabled={processing || publicationComplete || job?.status === 'succeeded'} onChange={event => changeNote(event.target.value)} placeholder="没有问题直接点下方投稿。有修改再填写，例如：把字幕“建功”改成“建构”，标题保留。" rows={3} maxLength={1000} /></label>
        <p className="muted">无需填写确认语。点击即授权投稿；有修改意见则先按意见修改，尚无成片或有待制作修订则先制作。进度与失败原因会显示在这里。</p>
        <button className="primary" disabled={processing || job?.status === 'succeeded' || publicationComplete} onClick={() => void act('feedback-publish', {}, note.trim() || '投')}>{detail.clip.status === 'uploaded' ? '已投稿' : publicationComplete ? '已加入投稿队列' : busy ? '正在提交…' : feedbackActive(job) ? '已提交，正在处理' : job?.status === 'succeeded' ? '已加入投稿队列' : note.trim() ? feedbackFailed ? '按补充意见重试并投稿' : '按意见修改并投稿' : !detail.media || detail.pendingRebuild ? '按当前内容制作并投稿' : '没问题，直接投稿'}</button>
        <details><summary>高级操作</summary><div className="button-row">{detail.category === 'clip' && <button disabled={processing} onClick={() => void act('cut')}>只制作成片</button>}<button disabled={processing || !detail.media} onClick={() => void act('approve-review')}>只保存审核</button><button disabled={processing || detail.clip.status === 'uploaded'} onClick={() => void act('enqueue')}>只入队投稿</button>{detail.category === 'clip' && <button className="danger-link" disabled={processing || detail.clip.status === 'uploaded'} onClick={() => void act('exclude')}>排除</button>}</div></details>
      </footer>
    </>}
  </>;
}
