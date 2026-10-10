'use client';
import { useCallback, useEffect, useState } from 'react';

export async function api<T = any>(endpoint: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/admin${endpoint}`, body === undefined ? { cache: 'no-store' } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data as T;
}
export function useResource<T>(endpoint: string, interval = 0) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [loading, setLoading] = useState(true), [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion(value => value + 1), []);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    const read = async () => {
      try {
        const response = await fetch(`/api/admin${endpoint}`, { cache: 'no-store', signal: controller.signal });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || '读取失败');
        if (current) { setData(value); setError(''); }
      } catch (reason) { if (current) setError(reason instanceof Error ? reason.message : '读取失败'); }
      finally { if (current) setLoading(false); }
    };
    setLoading(true); setData(undefined); setError(''); void read();
    const timer = interval ? setInterval(() => void read(), interval) : undefined;
    return () => { current = false; controller.abort(); if (timer) clearInterval(timer); };
  }, [endpoint, interval, version]);
  return { data, error, loading, refresh };
}
export function statusText(status: string): string {
  return ({ review: '待审核', needs_review: '待核对', pending_preflight: '待预审', pending_cut: '待制作', pending_review: '待审核',
    pending_upload: '待投稿', queued: '已排队', running: '执行中', processing: '执行中', uploaded: '已投稿', upload_queued: '投稿队列中',
    succeeded: '已完成', completed: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', excluded: '已排除',
    needs_retry: '待重试', pending_rebuild: '待重制', uploading: '投稿中', sent: '已发送', attempted: '发送未确认' } as Record<string, string>)[status] || status;
}
export function dateText(value?: string | number): string { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'; }
