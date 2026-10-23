'use client';
import { useEffect, useRef, useState } from 'react';
import { useResource } from './client';

export function RecordingQuestions() {
  const rooms = useResource<{ rooms: { roomId: string; name: string }[] }>('/questions/rooms');
  const [room, setRoom] = useState(''), [question, setQuestion] = useState(''), [terms, setTerms] = useState(''), [date, setDate] = useState(''), [kind, setKind] = useState('all');
  const [result, setResult] = useState<any>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [mode, setMode] = useState('ask');
  const controller = useRef<AbortController>();
  useEffect(() => { if (!room && rooms.data?.rooms.length) setRoom(rooms.data.rooms.find(next => next.roomId === '25788785')?.roomId || rooms.data.rooms[0].roomId); }, [room, rooms.data]);
  useEffect(() => () => controller.current?.abort(), []);
  async function query(nextMode: 'ask' | 'search') {
    if (controller.current || !room || !question.trim()) return;
    const active = new AbortController();
    controller.current = active;
    setBusy(true); setError(''); setResult(undefined); setMode(nextMode);
    try {
      const response = await fetch(`/api/admin/questions/${nextMode}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: active.signal,
        body: JSON.stringify(nextMode === 'ask' ? { roomId: room, question: question.trim() } : { roomId: room, question: question.trim(), ...(terms.trim() ? { terms: terms.split(/[,，]/u).map(text => text.trim()).filter(Boolean) } : {}), date: date || null, kind, expandTop: 3 }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || '查询失败'); setResult(data);
    } catch (reason) { setError(active.signal.aborted ? '查询已取消' : reason instanceof Error ? reason.message : '查询失败'); }
    finally { controller.current = undefined; setBusy(false); }
  }
  return <div className="questions-workspace"><p className="muted">从直播记忆里找答案和原文证据。直接在这里提问，结果只显示在本机。</p>
    {(error || rooms.error) && <div className="notice error" role="alert">{error || rooms.error}{rooms.error && <button onClick={rooms.refresh}>重新加载直播间</button>}</div>}
    <form className="question-form" onSubmit={event => { event.preventDefault(); void query('ask'); }}>
      <div className="form-stack">
        <label>默认资料房间<select disabled={busy || rooms.loading} value={room} onChange={event => setRoom(event.target.value)}>
          {!rooms.data?.rooms.length && <option value="">{rooms.loading ? '加载直播间…' : '暂无可用直播间'}</option>}
          {rooms.data?.rooms.map(next => <option key={next.roomId} value={next.roomId}>{next.name} · {next.roomId}</option>)}
        </select></label>
        <p className="muted">问题点名其他主播时查对应房间；比较时写明双方，最多 3 个房间。每次独立检索，请写出完整问题。</p>
        <label>问题<textarea required maxLength={120} disabled={busy} value={question} onChange={event => setQuestion(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          placeholder="例如：这个月的舰礼是什么？" rows={3} /></label>
      </div>
      <details><summary>证据检索条件（用于“只查证据”）</summary><div className="form-grid">
        <label>关键词（逗号分隔，最多 5 个）<input disabled={busy} value={terms} onChange={event => setTerms(event.target.value)} /></label>
        <label>日期（年 / 月 / 日）<input disabled={busy} value={date} onChange={event => setDate(event.target.value)} placeholder="2026-10" /></label>
        <label>资料类型<select disabled={busy} value={kind} onChange={event => setKind(event.target.value)}><option value="all">全部资料</option><option value="subtitle">字幕与舰礼档案</option><option value="danmaku">观众弹幕</option></select></label>
      </div></details>
      <div className="button-row"><button className="primary" type="submit" disabled={busy || !room || !question.trim()}>问鹿饼</button>
        <button type="button" disabled={busy || !room || !question.trim()} onClick={() => void query('search')}>只查证据</button>
        {busy && <button type="button" onClick={() => controller.current?.abort()}>取消查询</button>}
      </div>
      <p className="muted">Enter 提问 · Shift + Enter 换行 · 最长等待 90 秒</p>
    </form>
    {busy && <div className="empty" role="status">正在查询{mode === 'ask' ? '回答与引用' : '原始证据'}…</div>}
    {result && <section className="question-results"><div className="section-heading"><h2>{mode === 'ask' ? '回答与引用' : '检索证据'}</h2><span>{(result.elapsedMs / 1000).toFixed(1)} 秒</span></div>
      {mode === 'ask' ? <><p className="question-answer">{result.result.answer}</p>{(result.result.clues || []).map((clue: any, index: number) => <blockquote key={index}><strong>{clue.roomName || clue.roomId} · {clue.date || '日期不详'} · {clue.time}</strong><p>{clue.excerpt}</p></blockquote>)}</> : <><p className="muted">{result.result.hits.length} 条命中 · {result.result.indexedFiles} 个字幕索引文件 · {result.result.indexComplete ? '索引完整' : '索引覆盖不完整'}{result.result.limited ? ' · 有范围限制' : ''}</p>{result.result.hits.map((hit: any, index: number) => <article key={index}><div className="eyebrow">{hit.roomName || hit.roomId} · {hit.date || '日期不详'} · {hit.time || hit.start || ''} · {hit.kind === 'danmaku' ? '观众弹幕' : hit.kind === 'gift-catalog' ? '舰礼档案' : '录像字幕'}</div><p>{hit.text || hit.excerpt}</p><details><summary>展开原文上下文</summary><pre>{JSON.stringify(hit.expanded?.context || hit.context, null, 2)}</pre></details></article>)}{!result.result.hits.length && <div className="empty">在当前资料范围内没有找到可靠证据</div>}</>}
    </section>}
  </div>;
}
