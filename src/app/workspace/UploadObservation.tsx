'use client';
import { useState } from 'react';
import { UploadObservation as Observation } from '../../core/admin/uploadStatus';
import { dateText } from './client';

const colors = ['#246653', '#527cbb', '#8765a0'];
const label = (kind: string) => kind === 'http406' ? 'HTTP 406' : '大频控 137022';
const stageText = (stage: string) => ({ preupload: '预上传', chunk: '分片上传', upload: '上传', submit: '投稿接口' } as Record<string, string>)[stage] || '阶段未记录';
const sourceText = (source: string) => ({ ledger: '逐次账本', history: '逐次历史', snapshot: '任务快照（时间近似）' } as Record<string, string>)[source];

export function UploadObservation({ data }: { data: Observation }) {
  const [range, setRange] = useState(48), [selected, setSelected] = useState('');
  const end = Date.parse(data.until), start = end - range * 3600000;
  const rows = data.incidents.filter(row => Date.parse(row.at) >= start);
  const chosen = rows.find(row => row.id === selected);
  const width = 900, top = 28, height = 150, bottom = top + height;
  const x = (at: string) => 45 + (Date.parse(at) - start) / (end - start) * (width - 60);
  const visible = data.windows.map(window => {
    const before = [...window.points].reverse().find(point => Date.parse(point.at) <= start);
    return [{ at: new Date(start).toISOString(), count: before?.count || 0 }, ...window.points.filter(point => Date.parse(point.at) > start)];
  });
  const max = Math.max(10, Math.ceil(Math.max(...visible.flatMap(points => points.map(point => point.count))) / 10) * 10);
  const y = (count: number) => bottom - count / max * height;
  return <section className="upload-observation" aria-label="投稿量与频控观察">
    <div className="section-heading"><h3>投稿量与频控观察</h3><div className="segmented" aria-label="历史显示范围">{[3, 24, 48].map(hours =>
      <button key={hours} aria-pressed={range === hours} onClick={() => setRange(hours)}>近 {hours} 小时</button>)}</div></div>
    <dl className="upload-observation-metrics">{data.windows.map((window, index) => <div key={window.hours} style={{ borderColor: colors[index] }}>
      <dt>当前滚动 {window.hours} 小时</dt><dd><strong>{window.count}</strong> 条成功投稿</dd></div>)}
      <div><dt>近 {range} 小时已记录频控</dt><dd><strong>{rows.filter(row => row.kind === 'http406').length}</strong> 次 406 · <strong>{rows.filter(row => row.kind === 'submission137022').length}</strong> 次大频控</dd></div></dl>
    <div className="upload-observation-legend">{data.windows.map((window, index) => <span key={window.hours}><i style={{ background: colors[index] }} />滚动 {window.hours}h</span>)}<span className="upload-legend-406">● HTTP 406</span><span className="upload-legend-137022">◆ 大频控 137022</span></div>
    <div className="upload-observation-chart"><svg viewBox={`0 0 ${width} 220`} role="group" aria-label={`近${range}小时的滚动3、24、48小时成功投稿数和频控点；可点击频控点，完整数据见下方表格`}>
      {[0, .5, 1].map(ratio => <g key={ratio}><path d={`M 45 ${y(max * ratio)} H 885`} className="upload-grid" /><text x="35" y={y(max * ratio) + 4} textAnchor="end">{max * ratio}</text></g>)}
      {visible.map((points, index) => <path key={data.windows[index].hours} d={points.map((point, i) => i ? `H ${x(point.at)} V ${y(point.count)}` : `M ${x(point.at)} ${y(point.count)}`).join(' ')} fill="none" stroke={colors[index]} strokeWidth="2" />)}
      {rows.map(row => {
        const px = x(row.at), py = row.kind === 'http406' ? 10 : 22;
        const title = `${dateText(row.at)} · ${label(row.kind)} · 滚动3/24/48h：${row.counts.join(' / ')} 条 · ${stageText(row.stage)}`;
        return <g key={row.id} className={`upload-incident upload-incident-${row.kind}`} role="button" tabIndex={0} aria-label={title}
          onClick={() => setSelected(row.id)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(row.id); } }}>
          <title>{title}</title><path d={`M ${px} ${top} V ${bottom}`} strokeDasharray="3 5" opacity={chosen?.id === row.id ? .9 : .22} />
          <rect x={px - 6} y="0" width="12" height={bottom} fill="transparent" stroke="none" />
          {row.kind === 'http406' ? <circle cx={px} cy={py} r="4" /> : <path d={`M ${px} ${py - 5} l 5 5 -5 5 -5 -5 Z`} />}
          <circle cx={px} cy={y(row.counts[1])} r={chosen?.id === row.id ? 5 : 3} />
        </g>;
      })}
      {[0, .5, 1].map(ratio => <text key={ratio} x={45 + ratio * (width - 60)} y="207" textAnchor={ratio === 0 ? 'start' : ratio === 1 ? 'end' : 'middle'}>{dateText(new Date(start + ratio * (end - start)).toISOString())}</text>)}
    </svg></div>
    {chosen && <p className="upload-incident-selection" aria-live="polite">{dateText(chosen.at)} · {label(chosen.kind)} · {stageText(chosen.stage)} · 当时滚动 3／24／48 小时：<strong>{chosen.counts.join(' / ')} 条</strong>{chosen.preupload5m !== undefined ? ` · 同账号前 5 分钟发起 ${chosen.preupload5m} 次分 P 初始化` : ''} · {sourceText(chosen.source)}</p>}
    <p className="muted">曲线按已知成功回执计算 (时间点 − 窗口, 时间点]，3／48 小时为观察统计。频控点叠在滚动 24h 曲线上；点击或键盘选中可看当时数量。时间重合只能用于排查关联，不能直接确认触发原因。</p>
    <p className="muted">406 本机逐次账本：{data.telemetry.available ? data.telemetry.since ? `始于 ${dateText(data.telemetry.since)}` : '暂无事件' : '缺失或暂不可读，使用任务快照补充'}{data.telemetry.truncated ? ' · 账本读取达到上限，数据不完整' : ''}。137022 逐次记录：{data.historySince ? `始于 ${dateText(data.historySince)}` : '尚未开始，旧任务仅有最近快照'}。旧重试可能已被覆盖；创作中心仅同步最近 24h，较早的站外投稿可能缺失。406 账号见明细，投稿数来自当前注册表。</p>
    <details className="upload-release-details"><summary>频控时间与当时投稿量（{rows.length} 条）</summary><div className="table-scroll"><table><thead><tr><th>时间 / 类型</th><th>阶段 / 来源</th><th>当时 3h / 24h / 48h</th><th>前 5 分钟初始化 / 关联</th></tr></thead><tbody>{[...rows].reverse().map(row =>
      <tr key={row.id} className={selected === row.id ? 'selected' : ''}><td><button onClick={() => setSelected(row.id)}>{dateText(row.at)}</button><small>{label(row.kind)}</small></td><td>{stageText(row.stage)}<small>{sourceText(row.source)}</small></td><td>{row.counts.join(' / ')} 条</td><td>{row.preupload5m === undefined ? '—' : `${row.preupload5m} 次`}{row.accountId && <small>账号 {row.accountId}{row.partIndex ? ` · P${row.partIndex}` : ''}</small>}{row.jobId && <small>任务 {row.jobId}</small>}</td></tr>)}</tbody></table>{!rows.length && <p className="empty">此范围暂无已记录频控；不代表历史上从未触发。</p>}</div></details>
  </section>;
}
