'use client';
import { useEffect, useRef, useState } from 'react';
import { TitleStats, TitleView, titleStrategyLabels } from '../../core/admin/titles';
import { api, useResource } from './client';

export interface TitleChoiceRef { setId: string; revision: string }
export function TitlePicker({ id, clipRevision, baseTitle, disabled, onTitle, onChoice, onBusy }: {
  id: number; clipRevision: string; baseTitle: string; disabled: boolean;
  onTitle: (title: string) => void; onChoice: (choice: TitleChoiceRef) => void; onBusy: (busy: boolean) => void;
}) {
  const resource = useResource<TitleView>(`/clips/${id}/titles`, 3000, true);
  const [view, setView] = useState<TitleView>(), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(''), [error, setError] = useState('');
  const applied = useRef(''), exposed = useRef('');
  const refresh = resource.refresh;
  const selectedTitle = view?.selection?.title ?? baseTitle;
  const unsaved = !!view && custom !== selectedTitle;
  useEffect(() => { refresh(); }, [clipRevision, refresh]);
  useEffect(() => { if (resource.data) setView(resource.data); }, [resource.data]);
  useEffect(() => { onBusy(busy || resource.loading || unsaved); }, [busy, resource.loading, unsaved, onBusy]);
  useEffect(() => {
    if (!view) return;
    onChoice({ setId: view.id, revision: view.revision });
    const identity = `${view.id}:${JSON.stringify(view.selection)}`;
    if (applied.current === identity) return;
    applied.current = identity;
    const title = view.selection?.title ?? view.options[0].title;
    setCustom(title); onTitle(title);
  }, [view, onTitle, onChoice]);
  const exposureKey = view ? `${view.id}:${view.options.map(option => option.id).join(',')}` : '';
  useEffect(() => {
    if (!open || !view || exposed.current === exposureKey || document.visibilityState !== 'visible') return;
    exposed.current = exposureKey;
    void api(`/clips/${id}/titles/exposure`, { setId: view.id, optionIds: view.options.map(option => option.id) }).catch(reason => {
      exposed.current = ''; setError(`展示记录未保存：${reason.message}`);
    });
  }, [id, open, view, exposureKey]);
  async function save(selection: { optionId: string } | { title: string } | { reset: true }) {
    if (!view) return;
    setBusy(true); onBusy(true); setError('');
    try {
      const saved = await api<TitleView>(`/clips/${id}/titles/selection`, { setId: view.id, revision: view.revision, ...selection });
      setView(saved); refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : '选择保存失败'); refresh(); }
    finally { setBusy(false); }
  }
  async function generate() {
    if (!view) return;
    setBusy(true); onBusy(true); setError('');
    try { await api(`/clips/${id}/titles/generate`, { setId: view.id, revision: view.revision }); refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '生成失败'); }
    finally { setBusy(false); }
  }
  const generating = view?.job && ['queued', 'running'].includes(view.job.status);
  return <details className="title-picker" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>标题方案 · {view?.selection ? `已选${titleStrategyLabels[view.selection.strategy]}` : '不选沿用默认'}</summary>
    <p className="muted">选择会保存为审核草稿，提交制作或修改投稿时应用。候选仍需核对事实，默认策略不会自动切换。</p>
    {view?.selection && <p role="status">已保存：{view.selection.title}</p>}
    {(error || resource.error) && <div className="notice error" role="alert">{error || resource.error}<button onClick={refresh}>重新读取</button></div>}
    {!view ? <p>正在读取标题…</p> : <>
      <fieldset disabled={disabled || busy}><legend>选择标题</legend>
        {view.options.map(option => <label className="title-option" key={option.id}>
          <input type="radio" name={`title-${id}`} checked={view.selection?.optionId === option.id} disabled={!option.title}
            onChange={() => void save({ optionId: option.id })} />
          <span><strong>{titleStrategyLabels[option.strategy]}</strong><span>{option.title || '制作时按现有流程生成'}</span>
            {option.evidence && <small>依据：{option.evidence}</small>}{option.reference && <small>{option.reference}</small>}</span>
        </label>)}
        <label>手写标题<input maxLength={80} value={custom} onChange={event => setCustom(event.target.value)} /></label>
        <div className="button-row"><button disabled={!custom.trim() || custom === selectedTitle} onClick={() => void save({ title: custom })}>保存手写标题</button>
          {unsaved && <button onClick={() => setCustom(selectedTitle)}>放弃手写修改</button>}
          {view.selection && <button onClick={() => void save({ reset: true })}>取消选择，沿用默认</button>}</div>
        {unsaved && <p className="muted">手写修改尚未保存，请先保存或放弃修改，再提交制作或投稿。</p>}
      </fieldset>
      <div className="button-row"><button disabled={disabled || busy || !!generating || view.generated} onClick={() => void generate()}>
        {generating ? '正在生成候选…' : view.generated ? '本版候选已生成' : '生成其他标题方案'}</button></div>
      {view.job && ['failed', 'interrupted'].includes(view.job.status) && <p role="alert">{view.job.output || '生成中断，可重新生成。'}</p>}
      {view.generated && view.options.length === 1 && <p className="muted">本片暂时没有通过证据校验的其他方案，可保留默认或手写标题。</p>}
      <p className="muted">提供自然口语、原话看点；社区用梗仅在片内证据适合时提供。目前不接入未经核实的近期热梗。</p>
    </>}
  </details>;
}

export function TitleStatistics() {
  const [open, setOpen] = useState(false);
  return <details className="title-statistics" onToggle={event => setOpen(event.currentTarget.open)}><summary>取名策略统计</summary>{open && <StatisticsTable />}</details>;
}
function StatisticsTable() {
  const { data, error, refresh } = useResource<TitleStats>('/title-stats', 5000, true);
  return <>
    <p className="muted">按片段证据版本去重，刷新不重复计数。“已选”是该版最后保存的选择；未选择或取消选择后沿用默认单列。选择率不是播放量或点击率。</p>
    {error && <p role="alert">{error}</p>}
    {data && <><p>{data.sets} 组已展示 · {data.passiveDefault} 组未选择，沿用默认</p>
      <div className="title-stats-scroll"><table><thead><tr><th>策略</th><th>展示</th><th>已选</th><th>选择率</th><th>选择变更</th><th>已提交操作</th><th>操作成功</th><th>失败 / 中断</th></tr></thead>
        <tbody>{data.rows.map(row => <tr key={row.strategy}><th>{titleStrategyLabels[row.strategy]}</th><td>{row.strategy === 'custom' ? '—' : row.shown}</td><td>{row.selected}</td>
          <td>{row.shown ? `${(100 * row.selected / row.shown).toFixed(1)}%` : '—'}</td><td>{row.changes}</td><td>{row.submitted}</td><td>{row.succeeded}</td><td>{row.failed}</td></tr>)}</tbody></table></div>
      <p className="muted">操作按该版最后一次提交统计；成功仅指管理任务成功，不代表 B 站已发布。统计版本：{data.version}。以后结合实际表现再决定默认策略。</p></>}
    <button onClick={refresh}>刷新统计</button>
  </>;
}
