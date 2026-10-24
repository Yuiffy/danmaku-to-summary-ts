'use client';
import { useState } from 'react';
import { AsrQueueItem, AsrQueueStatus } from '../../core/admin/asrStatus';
import { dateText, useResource } from './client';
import { AsrHistory } from './AsrHistory';

function duration(seconds?: number): string {
  if (seconds === undefined) return '时间未记录';
  const minutes = Math.floor(seconds / 60);
  return minutes < 1 ? '不足 1 分钟' : minutes < 60 ? `${minutes} 分钟` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}
function device(task?: AsrQueueItem): string {
  if (task?.ownerAlive === false) return '处理进程已退出';
  if (!task?.activity) return '设备待确认';
  if (task.activity.asrCompleted) return '字幕已生成';
  const tier = task.activity.progress?.performanceTier;
  const name = tier === 'waiting' ? '等待资源' : tier === 'postprocessing' ? '字幕后处理'
    : { cpu: 'CPU 后台 · 2 线程', gpu: task.activity.progress?.batchSeconds !== undefined
        && task.activity.progress.batchSeconds <= 30 ? 'GPU 低占用' : 'GPU 高吞吐', unknown: '设备待确认' }[task.activity.device];
  return task.activity.stale ? `最近记录：${name}` : name;
}
function speed(task?: AsrQueueItem): string {
  const progress = task?.activity?.progress;
  return progress?.speedX && !task?.activity?.stale ? `${progress.speedX.toFixed(1)}×${progress.speedProvisional ? '（初步）' : ''}` : '采样中';
}
function estimate(task?: AsrQueueItem): string {
  const activity = task?.activity, progress = activity?.progress;
  if (activity?.asrCompleted || progress?.performanceTier === 'postprocessing') return '转写完成，后处理中';
  if (progress?.performanceTier === 'waiting') return '等待资源后估算';
  if (activity?.stale) return '等待新进度';
  return progress?.etaSeconds !== undefined ? `约 ${duration(Math.ceil(progress.etaSeconds))}` : '速度稳定后估算';
}
function phase(task: AsrQueueItem): string {
  if (task.ownerAlive === false) return '原处理进程已退出，等待队列恢复';
  if (task.status === 'pending') return '等待前序任务完成';
  const activity = task.activity;
  return activity ? `${activity.phase}${activity.batch ? ` · 第 ${activity.batch} 批` : ''}${activity.stale ? ' · 记录较旧' : ''}` : '已开始，等待运行记录';
}

export function AsrQueue() {
  const [historyOpen, setHistoryOpen] = useState(false);
  const resource = useResource<AsrQueueStatus>('/queues/asr', 5000, true), status = resource.data;
  if (!status) return <section className="upload-global asr-global" aria-label="字幕处理队列"><p>{resource.error ? `字幕队列读取失败：${resource.error}` : '正在读取字幕处理队列…'}</p>{resource.error && <button onClick={resource.refresh}>重新读取</button>}</section>;
  const current = status.queue.find(task => task.status === 'processing'), next = status.queue.find(task => task.status === 'pending');
  return <section className="upload-global asr-global" aria-label="字幕处理队列">
    <div className="upload-heading"><h2>字幕处理队列</h2><span className="upload-state">{status.activeJobs ? `正在处理 ${status.activeJobs} 场` : status.queuedJobs ? '等待处理' : '队列已清空'}</span><button onClick={resource.refresh} aria-label="刷新字幕处理队列">刷新</button></div>
    {resource.error && <p className="upload-stale" role="alert">刷新失败，以下为 {dateText(status.observedAt)} 的旧状态：{resource.error}</p>}
    <dl className="upload-metrics asr-metrics">
      <div><dt>正在处理</dt><dd>{current?.streamerName || '暂无'}</dd><small title={current?.title}>{current?.title || '等待队列调度'}</small></div>
      <div><dt>性能档位 / 阶段</dt><dd>{current ? device(current) : '—'}</dd><small>{current ? phase(current) : '暂无运行任务'}{current?.activity?.progress?.windowSeconds ? ` · ${current.activity.progress.windowSeconds} 秒音频窗口` : ''}</small></div>
      <div><dt>等待处理</dt><dd><strong>{status.queuedJobs}</strong> 场</dd><small>下一场：{next?.streamerName || '暂无'}</small></div>
      <div><dt>本场已用时</dt><dd>{current ? duration(current.elapsedSeconds) : '—'}</dd><small>{current?.startedAt ? `开始于 ${dateText(current.startedAt)}` : '开始时间待记录'}</small></div>
      <div><dt>转写进度</dt><dd>{current?.activity?.progress ? `${current.activity.progress.percent.toFixed(1)}%` : '—'}</dd>{current?.activity?.progress && <><progress aria-label="本场转写进度" max={100} value={current.activity.progress.percent} /><small>已保存 {duration(current.activity.progress.audioDoneSeconds)} / 共 {duration(current.activity.progress.audioTotalSeconds)}</small></>}</div>
      <div><dt>近期实测速度</dt><dd>{current ? speed(current) : '—'}</dd><small>{current?.activity?.progress?.speedWindowSeconds ? `统计约 ${Math.round(current.activity.progress.speedWindowSeconds)} 秒；1× 为实时速度` : '根据同档位已保存进度计算'}</small></div>
      <div><dt>预计转写剩余</dt><dd>{current ? estimate(current) : '—'}</dd><small>随资源与语音密度变化；不含后处理</small></div>
    </dl>
    <details className="upload-expanded asr-expanded"><summary>查看字幕排队顺序与运行详情</summary>
      <p className="muted asr-policy">{status.policy.cpuFallbackEnabled ? `已启用 CPU 后台转写：GPU 繁忙时，支持的模型可用低优先级、2 线程继续处理；启动要求可用内存至少 ${status.policy.minAvailableMemoryGb} GiB。` : '当前配置未启用 CPU 后台转写。'}{status.policy.deviceHandoffEnabled ? '标准 Paraformer 按资源切换 CPU / GPU；新任务支持中断未完成窗口，保留已保存进度。' : ''}</p>
      <p className="muted">速度取同设备连续进度的最近约两分钟，切换设备或重做窗口后重新采样，至少观察一分钟才估算剩余转写时间；旧路线没有音频总进度时不估算。按优先级和入队先后排队。每 5 秒刷新，读取于 {dateText(status.observedAt)}。</p>
      {!status.logAvailable && <p className="upload-stale">运行记录暂不可读，设备和阶段待确认；排队顺序仍来自现有队列。</p>}
      <div className="table-scroll asr-queue-table"><table><thead><tr><th>顺序</th><th>主播 / 场次</th><th>状态 / 进度</th><th>等待 / 已用时</th><th>入队时间</th></tr></thead><tbody>{status.queue.map(task => <tr key={task.id}>
        <td>{task.status === 'processing' ? '处理中' : `等待 ${task.position}`}<small>优先级 {task.priority}</small></td>
        <td><b>{task.streamerName}</b><p>{task.title}</p><small>录制于 {dateText(task.recordedAt)}</small></td>
        <td>{task.status === 'processing' && <span className="status status-processing">{device(task)}</span>}<p>{phase(task)}</p>{task.activity?.progress && <small>{task.activity.progress.percent.toFixed(1)}% · {speed(task)} · {estimate(task)}{task.activity.progress.batchSeconds ? ` · 批量上限 ${task.activity.progress.batchSeconds} 秒` : ''}</small>}{task.activity && <small>进度记录：{dateText(task.activity.at)}</small>}</td>
        <td>等待 {duration(task.waitSeconds)}{task.status === 'processing' && <small>已处理 {duration(task.elapsedSeconds)}</small>}</td>
        <td>{dateText(task.addedAt)}</td>
      </tr>)}</tbody></table>{!status.queue.length && <div className="empty">暂无待处理字幕任务</div>}</div>
      <p className="muted asr-footnote">历史失败 {status.failedJobs} 场。字幕生成后，同场总结等后续流程仍可能继续运行。设备与阶段为本场运行记录；较旧记录会标明时间，排队状态不代表进程持续在线。</p>
    </details>
    <details className="upload-expanded asr-expanded" onToggle={event => setHistoryOpen(event.currentTarget.open)}><summary>查看历史字幕处理：档位、速度与耗时</summary>{historyOpen && <AsrHistory />}</details>
  </section>;
}
