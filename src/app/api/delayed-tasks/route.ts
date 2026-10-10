import { NextRequest, NextResponse } from 'next/server';
import { isLocalAdminRequest } from '../../../core/admin/httpAccess';

export const dynamic = 'force-dynamic';

// The webhook process is the sole owner of the durable queue and its scheduler.
async function forward(endpoint: string, method = 'GET', body?: unknown) {
  try {
    const baseUrl = process.env.WEBHOOK_BASE_URL || 'http://127.0.0.1:12523';
    const response = await fetch(new URL(`/api/delayed-reply${endpoint}`, baseUrl), {
      method,
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    });
    return NextResponse.json(await response.json(), { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Webhook service unavailable' }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  if (!isLocalAdminRequest(request)) return NextResponse.json({ error: '仅允许本机管理页面访问' }, { status: 403 });
  return forward('/tasks');
}

export async function POST(request: NextRequest) {
  if (!isLocalAdminRequest(request)) return NextResponse.json({ error: '仅允许本机管理页面访问' }, { status: 403 });
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body?.roomId) {
    return NextResponse.json({ error: 'roomId is required' }, { status: 400 });
  }
  return forward('', 'POST', body);
}

export async function DELETE(request: NextRequest) {
  if (!isLocalAdminRequest(request)) return NextResponse.json({ error: '仅允许本机管理页面访问' }, { status: 403 });
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body?.taskId !== 'string' || !body.taskId.trim()) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }
  return forward(`/tasks/${encodeURIComponent(body.taskId)}`, 'DELETE');
}
