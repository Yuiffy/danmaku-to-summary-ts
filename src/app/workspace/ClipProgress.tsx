'use client';
import { useState } from 'react';
import { ClipProgressItem, ClipProgressStatus, clipStages } from '../../core/admin/clipProgress';
import { dateText, statusText, useResource } from './client';
import { ProgressPanel } from './ProgressPanel';

function stageText(task: ClipProgressItem): string {
  if (task.status === 'interrupted') return '处理进程待确认，等待队列恢复';
  if (task.status === 'retry_wait') return `等待重试：${dateText(task.nextAttemptAt)}`;
  if (task.status === 'pending') return '等待前序场次完成';
  if (task.status === 'done') return '本场切片流程已结束';
  if (task.status === 'failed') return '自动重试已用尽，需检查运行记录';
  const index = task.steps?.indexOf(task.stage || '') ?? -1;
  return task.stage ? `${index >= 0 ? `第 ${index + 1}/${task.steps!.length} 步 · ` : ''}${clipStages[task.stage]}` : '已开始，等待阶段记录';
}
function videoText(task: ClipProgressItem): string {
  const videos = task.videos;
  if (!videos) return '视频数量待选材完成后确定';
  return `初次制作 ${videos.processed}/${videos.total} · 已生成 ${videos.rendered} 个 · 制作方式已处理 ${videos.refined}/${videos.rendered}${task.stage === 'own' && videos.phase === 'final_review' ? ' · 精切与成片审核中' : ''}`;
}
const videoStates = { waiting: '等待审核或制作', rendering: '制作中', rendered: '已生成', needs_review: '切前暂缓，待复核', failed: '制作失败' };
const editions = { initial: '初版', ordinary: '普通成片', highlight_first: '重点前置版', precision: '精切版' };
function VideoResults({ task }: { task: ClipProgressItem }) {
  const [selected, setSelected] = useState<number>(), [error, setError] = useState(false);
  const active = task.videos?.items.find(item => item.index === selected && item.previewKey);
  return <>
    <div className="clip-video-list">{task.videos?.items.map(item => <div className="clip-video-item" key={item.index}>
      <div><b>视频 {item.index}/{task.videos!.total}{item.title ? ` · ${item.title}` : ''}</b>
        <small>{item.edition ? editions[item.edition] : videoStates[item.state]}{item.review ? ` · 质量复核${item.review === 'passed' ? '通过' : item.review === 'pending' ? '中' : '待处理'}` : ''}{item.state === 'rendered' ? ` · 投稿审核${item.finalReview === 'passed' ? '通过' : item.finalReview === 'failed' ? '待处理' : item.finalReview === 'pending' ? '中' : '待完成'}` : ''}{item.issue ? ` · ${item.issue}` : ''}</small></div>
      {item.previewKey && <button aria-label={`预览视频 ${item.index}`} aria-pressed={selected === item.index} onClick={() => { setSelected(item.index); setError(false); }}>预览{item.edition === 'initial' ? '初版' : '成片'}</button>}
    </div>)}</div>
    {active && <div className="clip-intermediate-preview"><div><b>视频 {active.index} · {active.title || '中途成果'}</b><button onClick={() => setSelected(undefined)}>关闭预览</button></div>
      <video key={`${task.id}-${active.previewKey}`} controls playsInline preload="metadata" aria-label={`视频 ${active.index} 中途成果预览`} src={`/api/admin/queues/clips/${encodeURIComponent(task.id)}/videos/${active.index}/${active.previewKey}/media`} onError={() => setError(true)} />
      {error && <p role="alert">视频可能正在更新版本，请刷新进度后重新打开预览。</p>}
      <p className="muted">生成一条即可先看一条；后续精切、修正会更新此处版本，投稿审核状态单独显示。</p>
    </div>}
  </>;
}
function since(value: string | undefined, observedAt: string): string {
  if (!value) return '时间待记录';
  const minutes = Math.max(0, Math.floor((Date.parse(observedAt) - Date.parse(value)) / 60000));
  return (minutes < 1 ? '不足 1 分钟' : minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`) + '前';
}
export function ClipProgress() {
  const resource = useResource<ClipProgressStatus>('/queues/clips', 5000, true), status = resource.data;
  if (!status) return <section className="upload-global clip-progress" aria-label="自动切片进度"><p>{resource.error ? `自动切片进度读取失败：${resource.error}` : '正在读取自动切片进度…'}</p>{resource.error && <button onClick={resource.refresh}>重新读取</button>}</section>;
  const current = status.queue.find(task => task.status === 'processing' || task.status === 'interrupted');
  const next = status.queue.find(task => task.status === 'pending' || task.status === 'retry_wait');
  return <ProgressPanel title="自动切片进度" className="clip-progress" state={status.activeJobs ? '正在制作' : current ? '等待恢复' : status.queuedJobs ? '等待处理' : '当前无切片任务'}
    summary={<>{current && <>{current.streamerName} · {stageText(current)}{current.videos ? ` · 初次制作 ${current.videos.processed}/${current.videos.total}${current.stage === 'own' && current.videos.phase === 'final_review' ? ` · 制作方式 ${current.videos.refined}/${current.videos.rendered}` : ''}` : ''}{current.stale ? ' · 记录较旧' : ''}</>}<span>等待 {status.queuedJobs} 场</span></>}
    onRefresh={resource.refresh} notice={<>
    {resource.error && <p className="upload-stale" role="alert">刷新失败，以下为 {dateText(status.observedAt)} 的旧状态：{resource.error}</p>}
    {status.unreadableJobs > 0 && <p className="upload-stale" role="alert">有 {status.unreadableJobs} 条任务记录暂不可读，队列统计可能不完整。</p>}
    </>}>
    <dl className="upload-metrics clip-progress-metrics">
      <div><dt>当前场次</dt><dd>{current?.streamerName || '暂无'}</dd><small title={current?.title}>{current?.title || '自动选材、制作与审核在此显示'}</small></div>
      <div><dt>处理阶段</dt><dd>{current ? stageText(current) : '—'}</dd><small>{current?.activity?.label || '等待阶段进展'}{current?.stale ? ' · 记录较旧' : ''}</small></div>
      <div><dt>排队等待</dt><dd><strong>{status.queuedJobs}</strong> 场</dd><small>下一场：{next?.streamerName || '暂无'}</small></div>
      <div><dt>最近进展</dt><dd>{current ? since(current.activity?.at || current.updatedAt, status.observedAt) : '—'}</dd><small>{status.worker === 'online' ? '后台进程在线' : status.worker === 'offline' ? '后台进程未在线' : '后台进程状态待确认'}</small></div>
    </dl>
    {current && <div className="clip-video-progress"><p><strong>{videoText(current)}</strong></p>
      {current.videos ? <><progress aria-label="初次制作已处理视频数" max={current.videos.total} value={current.videos.processed} /><p className="muted">已生成 {current.videos.rendered} 个 · 切前暂缓 {current.videos.needsReview} 个 · 制作失败 {current.videos.failed} 个。计数包括已处理的暂缓与失败候选；初次制作结束后，成片复核、修正和投稿审核仍可能继续。</p>
        <VideoResults key={current.id} task={current} /></>
        : <p className="muted">选材与 AI 等待按实际阶段展示；视频总数确定后显示制作数量。当前没有可核实的视频时间进度。</p>}
    </div>}
    {current && <div className="clip-stage-list" aria-label="本场已完成的阶段">{current.completedStages.map(stage => <span key={stage}>✓ {clipStages[stage]}</span>)}<span className="clip-stage-current">{stageText(current)}</span></div>}
    {status.latestOutput && status.latestOutput.id !== current?.id && <details className="upload-expanded"><summary>最近生成 · {status.latestOutput.streamerName} · {status.latestOutput.videos?.items.filter(item => item.previewKey).length} 条可预览</summary><p className="muted">{status.latestOutput.title}</p><VideoResults key={status.latestOutput.id} task={status.latestOutput} /></details>}
    <details className="upload-expanded"><summary>查看自动切片排队与近期结果</summary>
      <div className="table-scroll"><table><thead><tr><th>主播 / 场次</th><th>状态 / 阶段</th><th>最近进展</th><th>入队时间</th></tr></thead><tbody>{[...status.queue, ...status.recent].map(task => <tr key={task.id}>
        <td><b>{task.streamerName}</b><p>{task.title}</p><small>直播间 {task.roomId}</small></td>
        <td><span className={`status status-${task.status}`}>{statusText(task.status)}</span><p>{stageText(task)}</p>{task.attempts > 0 && <small>已失败 {task.attempts} 次</small>}</td>
        <td>{task.videos ? videoText(task) : task.activity?.label || '暂无详细进展'}<small>{dateText(task.activity?.at || task.updatedAt)}{task.stale && task.status === 'processing' ? ' · 记录较旧' : ''}</small>{!task.progressAvailable && <small>阶段记录暂不可读</small>}{!task.logAvailable && <small>详细运行记录暂不可读</small>}{task.videos && task.id !== current?.id && <details><summary>逐条查看成果</summary><VideoResults task={task} /></details>}</td>
        <td>{dateText(task.enqueuedAt)}</td>
      </tr>)}</tbody></table>{!status.queue.length && !status.recent.length && <div className="empty">暂无自动切片记录</div>}</div>
      <p className="muted">每 5 秒刷新；近期结果按队列记录更新时间取 3 条已结束任务。选材、制作、审核耗时不同，当前按实际阶段展示。流程结束后，投稿进度请查看投稿队列。读取于 {dateText(status.observedAt)}。</p>
    </details>
  </ProgressPanel>;
}
