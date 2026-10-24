'use client';
import { useEffect, useState } from 'react';
import { ClipReview } from './ClipReview';
import { ConfigEditor } from './ConfigEditor';
import { Reminders } from './Reminders';
import { Operations } from './Operations';
import { DelayedTasks } from './DelayedTasks';
import { RecordingQuestions } from './RecordingQuestions';
import { BilibiliLogin } from './BilibiliLogin';
import { CommentReplies } from './CommentReplies';
import { CampaignCandidates } from './CampaignCandidates';
import { UploadQueue } from './UploadQueue';
import { AsrQueue } from './AsrQueue';
import { useResource } from './client';

type View = 'review' | 'fuya' | 'config' | 'reminders' | 'operations' | 'delayed' | 'questions' | 'login' | 'comments';
const navigation: { id: View; mark: string; name: string; caption: string }[] = [
  { id: 'review', mark: '▷', name: '视频审核', caption: '素材 · 字幕 · 投稿' },
  { id: 'fuya', mark: '◇', name: '芙娅之魂', caption: '逐场备选 · 原片预览' },
  { id: 'config', mark: '≡', name: '配置', caption: '处理流程与房间规则' },
  { id: 'login', mark: '◎', name: 'B 站登录', caption: '状态检查 · 恢复登录' },
  { id: 'comments', mark: '↔', name: '评论回复', caption: '处理进度 · 回复记录' },
  { id: 'reminders', mark: '◷', name: '直播提醒', caption: '事项与发送记录' },
  { id: 'questions', mark: '⌕', name: '问鹿饼', caption: '直播记忆 · 证据检索' },
  { id: 'operations', mark: '↗', name: '任务与队列', caption: '执行进度与结果' },
  { id: 'delayed', mark: '↳', name: '延迟回复', caption: '计划与取消' }
];
export function AdminWorkspace() {
  const [view, setView] = useState<View>('review');
  useEffect(() => {
    const syncView = () => setView(navigation.find(item => `#${item.id}` === window.location.hash)?.id || 'review');
    syncView();
    window.addEventListener('hashchange', syncView);
    return () => window.removeEventListener('hashchange', syncView);
  }, []);
  function navigate(next: View) { window.location.hash = next; setView(next); }
  const health = useResource<{ status: string }>('/health', 15000);
  const current = navigation.find(item => item.id === view)!;
  return <div className="admin-shell">
    <aside className="admin-sidebar">
      <a className="brand" href="/" aria-label="鹿饼管理工作台"><span className="brand-mark">鹿</span><span>鹿饼<small>管理工作台</small></span></a>
      <div className="sidebar-label">工作区</div>
      <nav aria-label="工作区导航">{navigation.map(item => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)} aria-current={view === item.id ? 'page' : undefined}>
        <span className="nav-mark" aria-hidden="true">{item.mark}</span><span>{item.name}<small>{item.caption}</small></span>
      </button>)}</nav>
      <div className="sidebar-bottom"><a href="#questions">问鹿饼与证据检索 <span>→</span></a>
        <span className="connection"><i className={health.error ? 'offline' : health.loading ? 'waiting' : ''} />{health.error ? '管理服务未连接' : health.loading ? '连接中' : '本机管理服务已连接'}</span></div>
    </aside>
    <main className="admin-main">
      <header className="workspace-heading"><div><div className="eyebrow">SHIKAMOCHI / WORKSPACE</div><h1>{current.name}</h1></div><span className="local-label">本机工作区</span></header>
      {health.error && <div className="notice error" role="alert">{health.error}<button onClick={health.refresh}>重新连接</button></div>}
      <div className="upload-global-wrap"><UploadQueue /><AsrQueue /></div>
      <div className="workspace-body" key={view}>
        {view === 'review' && <ClipReview onJobs={() => navigate('operations')} />}
        {view === 'fuya' && <CampaignCandidates />}
        {view === 'config' && <ConfigEditor />}
        {view === 'login' && <BilibiliLogin />}
        {view === 'comments' && <CommentReplies />}
        {view === 'reminders' && <Reminders onConfig={() => navigate('config')} />}
        {view === 'operations' && <Operations />}
        {view === 'delayed' && <DelayedTasks />}
        {view === 'questions' && <RecordingQuestions />}
      </div>
    </main>
  </div>;
}
