'use client';
import { UploadQueueStatus } from '../../core/admin/uploadStatus';
import { dateText, statusText, useResource } from './client';

function waitText(at: string | undefined, observedAt: string) {
  if (!at) return '时间待定';
  const seconds = Math.ceil((Date.parse(at) - Date.parse(observedAt)) / 1000);
  if (seconds <= 0) return '已到可尝试时间';
  const minutes = Math.ceil(seconds / 60);
  return minutes < 60 ? `约 ${minutes} 分钟后` : `约 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后`;
}

function RollingWindow({ status }: { status: UploadQueueStatus }) {
  const rolling = status.rolling;
  const width = 600, height = 100, duration = rolling.windowSeconds * 1000;
  let previousY = height - Math.min(1, rolling.count / rolling.limit) * height;
  let line = `M 0 ${previousY}`;
  for (const release of rolling.releases) {
    const x = Math.min(width, Math.max(0, (Date.parse(release.at) - Date.parse(status.observedAt)) / duration * width));
    const y = height - Math.min(1, release.remainingCount / rolling.limit) * height;
    line += ` L ${x.toFixed(2)} ${previousY.toFixed(2)} L ${x.toFixed(2)} ${y.toFixed(2)}`;
    previousY = y;
  }
  line += ` L ${width} ${previousY.toFixed(2)}`;
  return <section className="upload-window" aria-label="滚动24小时投稿额度">
    <div className="section-heading"><h3>滚动 24 小时</h3><span>本地保护上限 {rolling.limit} 条</span></div>
    <p>已记录 <strong>{rolling.count}</strong> 条 · 剩余额度 <strong>{rolling.remaining}</strong> 条{rolling.blockedUntil ? ` · 保护等待至 ${dateText(rolling.blockedUntil)}` : ''}</p>
    <progress aria-label="已用滚动24小时额度" max={rolling.limit} value={Math.min(rolling.count, rolling.limit)} />
    <p className="muted">每条成功投稿满 24 小时后移出窗口；投稿进程在释放边界额外等待 {rolling.boundaryBufferSeconds} 秒。</p>
    <figure className="upload-release-chart"><figcaption>若无新增投稿，窗口内条数将这样减少</figcaption>
      <svg viewBox="0 0 600 114" role="img" aria-label={`当前 ${rolling.count} 条，未来24小时逐条释放；具体时间见下方明细`} preserveAspectRatio="none">
        <path d="M 0 0 H 600 M 0 50 H 600 M 0 100 H 600" className="upload-grid" />
        <path d={`${line} L 600 100 L 0 100 Z`} className="upload-area" />
        <path d={line} className="upload-line" />
      </svg><div className="upload-chart-axis"><span>现在 · {rolling.count} 条</span><span>+12 小时</span><span>+24 小时</span></div>
    </figure>
    <p>下一次数量减少：<strong>{rolling.nextDecreaseAt ? dateText(rolling.nextDecreaseAt) : '暂无已记录投稿'}</strong></p>
    <p className="muted">创作中心最近同步：{dateText(rolling.syncedAt)}{rolling.syncFailed ? ' · 最近同步失败，当前数据可能不完整' : !rolling.syncedAt ? ' · 尚无同步记录，当前为已知记录' : ''}{!rolling.available ? ' · 账号保护状态尚未建立' : ''}</p>
    <details className="upload-release-details"><summary>查看逐条释放时间与最近投稿（{rolling.events.length} 条）</summary>
      <div className="table-scroll"><table><thead><tr><th>退出窗口时间</th><th>成功投稿时间</th><th>标题</th></tr></thead><tbody>{rolling.events.map((event, index) => <tr key={`${event.at}-${event.bvid || event.clipId || index}`}><td>{dateText(new Date(Date.parse(event.at) + duration).toISOString())}</td><td>{dateText(event.at)}</td><td>{event.clipId ? `#${event.clipId} · ` : ''}{event.title || event.bvid || '未记录标题'}</td></tr>)}</tbody></table></div>
    </details>
  </section>;
}

export function UploadQueue() {
  const resource = useResource<UploadQueueStatus>('/queues/status', 5000, true);
  const status = resource.data;
  if (!status) return <section className="upload-global" aria-label="全局投稿进度"><p>{resource.error ? `投稿进度读取失败：${resource.error}` : '正在读取全局投稿进度…'}</p>{resource.error && <button onClick={resource.refresh}>重新读取</button>}</section>;
  const attempt = status.lastAttempt;
  const next = status.activeJobs ? '当前任务结束后，时间待定' : status.nextAttemptAt ? dateText(status.nextAttemptAt) : '暂无自动尝试计划';
  return <section className="upload-global" aria-label="全局投稿进度">
    <div className="upload-heading"><h2>全局投稿进度</h2><span className={`upload-state upload-state-${status.state}`}>{status.summary}</span><button onClick={resource.refresh} aria-label="刷新全局投稿进度">刷新</button></div>
    {resource.error && <p className="upload-stale" role="alert">刷新失败，以下为 {dateText(status.observedAt)} 的旧状态：{resource.error}</p>}
    <dl className="upload-metrics">
      <div><dt>排队 / 执行中</dt><dd><strong>{status.queuedJobs}</strong> / {status.activeJobs} 个任务</dd><small>共 {status.queuedClips} 个未完成视频 · 阻塞 {status.blockedJobs}</small></div>
      <div><dt>上次成功投稿</dt><dd>{dateText(status.lastSubmission?.at)}</dd><small title={status.lastSubmission?.title}>{status.lastSubmission?.title || '暂无成功记录'}</small></div>
      <div><dt>下一次预计尝试</dt><dd>{next}</dd><small>{status.activeJobs ? '当前有任务执行，无法估算结束时间' : status.nextAttemptAt ? waitText(status.nextAttemptAt, status.observedAt) : '等待入队或人工核对'}</small></div>
      <div><dt>滚动 24 小时</dt><dd><strong>{status.rolling.count}</strong> / {status.rolling.limit} 条</dd><small>已知剩余 {status.rolling.remaining} 条{status.rolling.syncFailed || !status.rolling.syncedAt ? ' · 同步数据待确认' : ''}</small></div>
    </dl>
    {status.reasons.length > 0 && <p className="upload-wait-reason">{status.reasons.join('；')}</p>}
    <details className="upload-expanded"><summary>查看排队列表、频控与额度释放时间</summary>
      <div className="upload-diagnostics">
        <p><strong>最近一次已结束尝试：</strong>{attempt ? `${dateText(attempt.at)} · ${attempt.jobId} · ${statusText(attempt.status)}` : '暂无记录'}</p>
        {attempt && <p>投稿接口频控（137022）：{attempt.submissionRateLimited ? '遇到' : '未记录到'} · 预上传频控：{attempt.preuploadRateLimited ? '遇到' : '未记录到'}{attempt.outcomeUnknown ? ' · 投稿结果待核对' : ''}</p>}
        <p><strong>账号投稿冷却：</strong>{status.rateLimit ? `${status.rateLimit.active ? '生效中' : '已到期'} · 返回码 ${status.rateLimit.code} · 连续 ${status.rateLimit.streak} 次 · 记录于 ${dateText(status.rateLimit.at)} · 截止 ${dateText(status.rateLimit.until)}` : '当前无投稿接口频控冷却记录'}</p>
        <p className="muted">预计时间按账号冷却、滚动额度及各任务重试时间共同计算。实际开始时间还取决于当前任务耗时和投稿进程调度；此处仅展示队列记录，未检测进程是否在线。读取于 {dateText(status.observedAt)}，每 5 秒刷新。</p>
      </div>
      <RollingWindow status={status} />
      <div className="section-heading"><h3>待处理队列（{status.queue.length} 个任务）</h3><span>历史失败 {status.failedJobs} 个 · 历史与取消操作见「任务与队列」</span></div>
      <p className="muted">执行中优先展示，其余按当前可尝试时间推算顺序。处理时会跳过未到重试时间的任务；一项任务可含多个视频。</p>
      <div className="table-scroll upload-queue-table"><table><thead><tr><th>顺序 / 任务</th><th>视频</th><th>状态 / 原因</th><th>最早可尝试</th></tr></thead><tbody>{status.queue.map((entry, index) => <tr key={entry.id}>
        <td>{index + 1}<small className="mono">{entry.id}</small></td>
        <td>{entry.clips.map(clip => <p key={clip.id}>#{clip.id} {clip.title || '未记录标题'}{clip.done ? '（已投稿）' : clip.excluded ? '（制作失败，已跳过）' : ''}</p>)}</td>
        <td><span className={`status status-${entry.status}`}>{statusText(entry.status)}</span><p>{entry.reason}</p><small>更新于 {dateText(entry.updatedAt)}</small></td>
        <td>{entry.status === 'running' ? '正在执行' : entry.eligibleAt ? dateText(entry.eligibleAt) : '需要人工核对'}{entry.retryAt && <small>任务重试：{dateText(entry.retryAt)}</small>}</td>
      </tr>)}</tbody></table>{!status.queue.length && <div className="empty">暂无待处理投稿任务</div>}</div>
    </details>
  </section>;
}
