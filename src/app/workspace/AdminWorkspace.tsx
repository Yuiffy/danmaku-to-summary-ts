'use client';
import { useState } from 'react';
import { ClipReview } from './ClipReview';
import { ConfigEditor } from './ConfigEditor';
import { Reminders } from './Reminders';
import { Operations } from './Operations';
import { DelayedTasks } from './DelayedTasks';
import { RecordingQuestions } from './RecordingQuestions';
import { useResource } from './client';

type View = 'review' | 'config' | 'reminders' | 'operations' | 'delayed' | 'questions';
const navigation: { id: View; mark: string; name: string; caption: string }[] = [
  { id: 'review', mark: '▷', name: '视频审核', caption: '素材 · 字幕 · 投稿' },
  { id: 'config', mark: '≡', name: '配置', caption: '处理流程与房间规则' },
  { id: 'reminders', mark: '◷', name: '直播提醒', caption: '事项与发送记录' },
  { id: 'questions', mark: '⌕', name: '录播检索', caption: '问答 · 字幕 · 弹幕' },
  { id: 'operations', mark: '↗', name: '任务与队列', caption: '执行进度与结果' },
  { id: 'delayed', mark: '↳', name: '延迟回复', caption: '计划与取消' }
];
export function AdminWorkspace() {
  const [view, setView] = useState<View>('review');
  const health = useResource<{ status: string }>('/health', 15000);
  const current = navigation.find(item => item.id === view)!;
  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <a className="brand" href="/" aria-label="鹿饼管理工作台"><span className="brand-mark">鹿</span><span>鹿饼<small>管理工作台</small></span></a>
      <div className="sidebar-label">工作区</div>
      <nav aria-label="工作区导航">{navigation.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)} aria-current={view === item.id ? 'page' : undefined}>
        <span className="nav-mark" aria-hidden="true">{item.mark}</span><span>{item.name}<small>{item.caption}</small></span>
      </button>)}</nav>
      <div className="sidebar-bottom"><a href="http://127.0.0.1:15126" target="_blank" rel="noreferrer">录播问答与证据检索 <span>↗</span></a>
        <span className="connection"><i className={health.error ? 'offline' : health.loading ? 'waiting' : ''} />{health.error ? '管理服务未连接' : health.loading ? '连接中' : '本机管理服务已连接'}</span></div>
    </aside>
    <main className="admin-main">
      <header className="workspace-heading"><div><div className="eyebrow">SHIKAMOCHI / WORKSPACE</div><h1>{current.name}</h1></div><span className="local-label">本机工作区</span></header>
      {health.error && <div className="notice error" role="alert">{health.error}<button onClick={health.refresh}>重新连接</button></div>}
      <div className="workspace-body" key={view}>
        {view === 'review' && <ClipReview onJobs={() => setView('operations')} />}
        {view === 'config' && <ConfigEditor />}
        {view === 'reminders' && <Reminders onConfig={() => setView('config')} />}
        {view === 'operations' && <Operations />}
        {view === 'delayed' && <DelayedTasks />}
        {view === 'questions' && <RecordingQuestions />}
      </div>
    </main>
  </div>;
}
