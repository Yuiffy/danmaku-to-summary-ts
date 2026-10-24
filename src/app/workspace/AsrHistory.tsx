'use client';
import { useState } from 'react';
import { AsrHistory as History } from '../../core/admin/asrHistory';
import { dateText, statusText, useResource } from './client';

const time = (seconds?: number) => seconds === undefined ? '未记录' : seconds < 60 ? `${seconds.toFixed(1)} 秒`
  : `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
const speed = (value?: number) => value === undefined ? '未记录' : `${value.toFixed(1)}×`;
const names = { cpu_background: 'CPU 后台', gpu_low_impact: 'GPU 低占用', gpu_throughput: 'GPU 高吞吐', gpu_unknown: 'GPU（未细分）' };

export function AsrHistory() {
  const [page, setPage] = useState(1);
  const [streamer, setStreamer] = useState(''), [date, setDate] = useState('');
  const resource = useResource<History>(`/queues/asr/history?page=${page}&pageSize=20&streamer=${encodeURIComponent(streamer)}&date=${date}`, 30000, true), data = resource.data;
  return <div className="asr-history">
    <p className="muted">SQLite 保存已收录的历史，后台导入旧统计文件。每场展示最近一次 ASR 执行；复用的断点音频单列，不计入本次速度。旧场次缺少的数据标为未记录。</p>
    <div className="upload-heading"><label>主播 <input value={streamer} maxLength={100} placeholder="筛选主播" onChange={event => { setStreamer(event.target.value); setPage(1); }} /></label><label>处理完成日期 <input type="date" value={date} onChange={event => { setDate(event.target.value); setPage(1); }} /></label></div>
    {resource.error && <p role="alert" className="upload-stale">历史读取失败：{resource.error}</p>}
    <button onClick={resource.refresh}>刷新历史</button>
    {!data ? <p>{resource.loading ? '正在读取处理历史…' : '暂无可用数据'}</p> : <>
      <div className="table-scroll asr-queue-table"><table><thead><tr><th>主播 / 场次</th><th>档位组合</th><th>转写速度 / 耗时</th><th>ASR 总耗时 / 其他阶段</th></tr></thead>
        <tbody>{data.items.map(row => <tr key={row.id}>
          <td><b>{row.streamerName}</b><p>{row.title}</p><small>{row.status === 'asr_completed' ? '字幕已生成' : statusText(row.status)} · {dateText(row.generatedAt)}</small></td>
          <td>{row.tiers.length ? row.tiers.map(tier => <p key={tier.tier}><b>{names[tier.tier]}</b>{tier.batchSeconds !== undefined && <small>批量上限 {tier.batchSeconds} 秒</small>}<small>音频 {time(tier.audioSeconds)} · 窗口用时 {time(tier.windowSeconds)} · {speed(tier.speedX)}</small></p>) : '档位未记录'}
            <small>设备切换 {row.switches ?? '未记录'} 次 · 中断 {row.interruptions ?? '未记录'} 次</small></td>
          <td><b>{speed(row.speedX)}</b><p>文字转写 {time(row.transcriptionSeconds)}</p><small>录播时长 {time(row.mediaSeconds)}</small><small>断点复用 {time(row.reusedSeconds)}</small></td>
          <td><b>{time(row.elapsedSeconds)}</b><small>模型加载 {time(row.modelLoadSeconds)}</small><small>说话人：{row.speakerState === 'skipped' ? '已跳过' : row.speakerState === 'processed' ? time(row.speakerSeconds) : '未记录'}</small>
            {row.metadata !== 'available' && <small>{row.metadata === 'missing' ? '未找到该场 ASR 统计文件' : '该场 ASR 统计暂不可读'}</small>}</td>
        </tr>)}</tbody></table>{!data.items.length && <p className="empty">暂无历史处理记录</p>}</div>
      <p className="muted">转写速度包含本次加载、等待和切换耗时，不含后处理；各档速度为新增音频 / 已返回窗口用时（包含窗口内加载）。ASR 总耗时含说话人等后处理，不含后续总结。断点之前的档位和耗时不作推算。</p>
      <div className="upload-heading"><button disabled={page <= 1 || resource.loading} onClick={() => setPage(page - 1)}>上一页</button><span>第 {page} 页 · 共 {data.total} 场</span><button disabled={page * data.pageSize >= data.total || resource.loading} onClick={() => setPage(page + 1)}>下一页</button></div>
    </>}
  </div>;
}
