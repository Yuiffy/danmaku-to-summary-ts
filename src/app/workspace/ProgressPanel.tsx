'use client';
import { ReactNode, useId, useState } from 'react';

export function ProgressPanel({ title, state, summary, onRefresh, notice, children, className = '' }: {
  title: string; state: ReactNode; summary: ReactNode; onRefresh: () => void; notice?: ReactNode; children: ReactNode; className?: string;
}) {
  const [open, setOpen] = useState(false), id = useId();
  return <section className={`upload-global progress-panel ${className}`} aria-label={title}>
    <div className="progress-heading"><h2>{title}</h2><span className="upload-state">{state}</span>
      <span className="progress-summary">{summary}</span>
      <div className="progress-actions"><button className="progress-toggle" aria-label={`${open ? '收起' : '展开'}${title}`} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{open ? '收起' : '展开'}</button><button className="progress-refresh" onClick={onRefresh} aria-label={`刷新${title}`}>刷新</button></div>
    </div>
    {notice}
    <div id={id} hidden={!open} className="progress-body">{children}</div>
  </section>;
}
