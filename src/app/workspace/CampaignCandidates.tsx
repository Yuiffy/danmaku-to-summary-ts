'use client';
import { useEffect, useRef, useState } from 'react';
import { CampaignCandidate, CampaignCandidateDetail, CampaignCandidateSort, campaignCandidateSorts } from '../../core/admin/contracts';
import { formatSubtitleTime, subtitleRows } from '../../core/admin/subtitles';
import { useResource } from './client';
import { SourcePlayer } from './SourcePlayer';
import { CampaignFeedback } from './CampaignFeedback';
import { campaignShortlistPolicy } from '../../core/admin/campaignCandidates';

interface CandidateList {
  candidates: CampaignCandidate[]; total: number; unfilteredTotal: number; page: number;
  rooms: { id: string; name: string }[]; sessions: { id: string; title: string }[];
}
const clock = (value?: number) => value === undefined ? '时间待确认' : formatSubtitleTime(value).split(',')[0];
const sortLabels: Record<CampaignCandidateSort, string> = { session: '默认：场次最新', 'score-desc': '评分：从高到低',
  'score-asc': '评分：从低到高', 'number-asc': '序号：从小到大', 'number-desc': '序号：从大到小' };
export function CampaignCandidates() {
  const [room, setRoom] = useState(''), [session, setSession] = useState(''), [search, setSearch] = useState('');
  const [query, setQuery] = useState(''), [page, setPage] = useState(1), [selected, setSelected] = useState('');
  const [sort, setSort] = useState<CampaignCandidateSort>('session');
  const [view, setView] = useState('curated');
  const list = useResource<CandidateList>(`/campaign-candidates?${new URLSearchParams({ room, session, search: query, page: String(page), sort, view })}`, 15000, true);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('campaign-candidate-sort-v1') as CampaignCandidateSort;
      if (campaignCandidateSorts.includes(saved)) setSort(saved);
    } catch { /* Sorting still works when local draft storage is unavailable. */ }
  }, []);
  useEffect(() => { const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250); return () => clearTimeout(timer); }, [search]);
  function changeFilter(change: () => void) { change(); setPage(1); setSelected(''); }
  function changeSort(value: CampaignCandidateSort) {
    setSort(value); setPage(1);
    try { localStorage.setItem('campaign-candidate-sort-v1', value); } catch { /* Remembering the preference is optional. */ }
  }
  return <>
    <div className="toolbar"><div className="summary-line"><strong>{list.data?.total ?? '—'}</strong> 个{view === 'curated' ? '精选' : ''}备选 <span>·</span> 原始备选 {list.data?.unfilteredTotal ?? '—'} 条</div><button onClick={list.refresh}>刷新备选</button></div>
    <p className="muted">默认按评分精选，每场最多 {campaignShortlistPolicy.maxPerSession} 条备选；重叠达到较短片段一半时保留高分项，不凑数。可切换全部备选查漏。R 为重排备选，P 为发布备选；原编号保留，正式裁切边界仍需核对。</p>
    <div className="review-layout"><section className="clip-browser">
      <div className="clip-filters"><input aria-label="搜索候补切片" placeholder="搜索 R/P 编号、话题、主播或日期" value={search} onChange={event => setSearch(event.target.value)} />
        <label>备选范围<select aria-label="候补切片范围" value={view} onChange={event => changeFilter(() => setView(event.target.value))}><option value="curated">精选备选（去重）</option><option value="all">全部备选（含低分及重叠）</option></select></label>
        <div className="filter-row"><select aria-label="备选主播" value={room} onChange={event => changeFilter(() => { setRoom(event.target.value); setSession(''); })}><option value="">全部主播</option>{list.data?.rooms.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
          <select aria-label="直播场次" value={session} onChange={event => changeFilter(() => setSession(event.target.value))}><option value="">全部场次</option>{list.data?.sessions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>
        <label>排序方式<select aria-label="候补切片排序" value={sort} onChange={event => changeSort(event.target.value as CampaignCandidateSort)}>{campaignCandidateSorts.map(value => <option key={value} value={value}>{sortLabels[value]}</option>)}</select></label>
      </div>
      {list.error && <div className="notice error" role="alert">{list.error}</div>}
      {list.loading && !list.data ? <div className="empty">读取候补切片…</div> : !list.data?.candidates.length ? <div className="empty">没有匹配的{view === 'curated' ? '精选' : ''}备选。{view === 'curated' ? '可切换“全部备选”查看低分、未评分或重叠项。' : '已保存审核记录的岁己及芙娅之魂场次会在这里出现。'}</div> : <div className="clip-list">{list.data.candidates.map(row => <button key={row.id} className={selected === row.id ? 'selected' : ''} onClick={() => setSelected(row.id)}>
        <div className="clip-row-meta"><span className="mono">{row.label}</span><span>{row.streamerName || row.roomId}</span></div>
        <strong>{row.title}</strong><small>{row.recordedAt} · {row.streamTitle}</small><small>{clock(row.start)} — {clock(row.end)}{row.score !== undefined && ` · 评分 ${row.score}`}</small>
        {row.reason && <span className="issue-preview">备选原因：{row.reason}</span>}
      </button>)}</div>}
      <div className="pagination"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>{page} / {Math.max(1, Math.ceil((list.data?.total || 0) / 40))}</span><button disabled={page * 40 >= (list.data?.total || 0)} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </section><section className="review-inspector">{selected ? <CandidatePreview key={selected} id={selected} /> : <div className="review-empty"><span>▷</span><h2>选择一条候补切片</h2><p>按主播和直播场次查找岁己及芙娅之魂候补，播放原片并逐句定位。</p></div>}</section></div>
  </>;
}

function CandidatePreview({ id }: { id: string }) {
  const resource = useResource<CampaignCandidateDetail>(`/campaign-candidates/${id}`), detail = resource.data;
  const video = useRef<HTMLVideoElement>(null), [origin, setOrigin] = useState<number>();
  return <>
    {resource.error && <div className="notice error" role="alert">{resource.error}<button onClick={resource.refresh}>重试读取</button></div>}
    {resource.loading && !detail && <div className="empty">读取候选字幕…</div>}
    {detail && <><div className="inspector-heading"><span className="mono">{detail.candidate.label} · {detail.candidate.streamerName}</span><button onClick={resource.refresh}>刷新候选</button></div>
      <h2 className="clip-title">{detail.candidate.title}</h2><p className="muted">{detail.candidate.recordedAt} · {detail.candidate.streamTitle}</p>
      <p className="muted">原片 {clock(detail.candidate.start)} — {clock(detail.candidate.end)} · 备选范围，边界待核</p>
      {detail.candidate.previewAvailable ? <SourcePlayer basePath={`/campaign-candidates/${id}`} revision={detail.revision} subtitles={detail.subtitles} video={video} onOrigin={setOrigin} /> : <div className="media-empty">原片已离线或候选时间不完整，暂时无法播放。</div>}
      {detail.candidate.reason && <p>备选原因：{detail.candidate.reason}</p>}
      <CampaignFeedback id={id} detail={detail} onRefresh={resource.refresh} />
      <section className="inspector-section"><h3>此时间段的原片字幕</h3><div className="subtitle-list">{subtitleRows(detail.subtitles).map((row, index) => <button key={index} disabled={origin === undefined} onClick={() => { if (video.current && origin !== undefined) video.current.currentTime = Math.max(0, row.at - origin); }}><span className="mono">{row.time}</span><span>{row.text}</span></button>)}</div>
        {!detail.subtitles && <p className="muted">此时间段没有可读取的字幕，可直接播放原音。</p>}
      </section></>}
  </>;
}
