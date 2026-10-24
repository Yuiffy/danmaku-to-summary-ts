import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NextRequest } from 'next/server';
import { GET as forwardAdmin } from './route';

const fetchOriginal = global.fetch, fetchMock = jest.fn();
let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-proxy-'));
  fs.writeFileSync(path.join(directory, 'token'), 'test-token');
  process.env.ADMIN_TOKEN_FILE = path.join(directory, 'token'); global.fetch = fetchMock; fetchMock.mockReset();
});
afterEach(() => { global.fetch = fetchOriginal; delete process.env.ADMIN_TOKEN_FILE; fs.rmSync(directory, { recursive: true, force: true }); });
function request(endpoint: string, options: RequestInit = {}) {
  return new NextRequest(`http://127.0.0.1:3000/api/admin${endpoint}`, { ...options, headers: { Host: '127.0.0.1:3000', ...options.headers } });
}
it('proxies global upload status as read-only without enabling arbitrary queue endpoints', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ queuedJobs: 3 }));
  expect((await forwardAdmin(request('/queues/status'))).status).toBe(200);
  expect(fetchMock.mock.calls[0][0].pathname).toBe('/queues/status');
  expect((await forwardAdmin(request('/queues/status', { method: 'POST', body: '{}' }))).status).toBe(405);
  expect((await forwardAdmin(request('/queues/resume'))).status).toBe(404);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('proxies campaign previews and only permits writes through the selected-candidate action', async () => {
  const id = 'a'.repeat(64);
  for (const endpoint of ['/campaign-candidates?room=100', `/campaign-candidates/${id}`, `/campaign-candidates/${id}/source-playback`]) {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    expect((await forwardAdmin(request(endpoint))).status).toBe(200);
  }
  fetchMock.mockResolvedValueOnce(new Response('part', { status: 206, headers: { 'Content-Range': 'bytes 0-3/10' } }));
  const media = await forwardAdmin(request(`/campaign-candidates/${id}/assets/source-preview`, { headers: { Range: 'bytes=0-3' } }));
  expect(media.status).toBe(206); expect(media.headers.get('content-range')).toBe('bytes 0-3/10');
  expect(fetchMock.mock.calls.at(-1)[1].headers.Range).toBe('bytes=0-3');
  expect((await forwardAdmin(request('/campaign-candidates', { method: 'POST', body: '{}' }))).status).toBe(405);
  expect((await forwardAdmin(request('/campaign-candidates/R1'))).status).toBe(404);
  expect((await forwardAdmin(request(`/campaign-candidates/${id}/actions`))).status).toBe(405);
  expect((await forwardAdmin(request(`/campaign-candidates/${id}/feedback`, { method: 'POST', body: '{}' }))).status).toBe(405);
  const body = JSON.stringify({ title: '手填标题', note: '保留铺垫', publishApproved: true, revision: 'rev' });
  fetchMock.mockResolvedValueOnce(Response.json({ status: 'queued' }, { status: 202 }));
  expect((await forwardAdmin(request(`/campaign-candidates/${id}/actions`, { method: 'POST', body }))).status).toBe(202);
  expect(fetchMock.mock.calls.at(-1)[1].body).toBe(body);
  fetchMock.mockResolvedValueOnce(Response.json({ job: null }));
  expect((await forwardAdmin(request(`/campaign-candidates/${id}/feedback`))).status).toBe(200);
  expect((await forwardAdmin(request(`/campaign-candidates/${id}/actions`, { method: 'POST', headers: { Origin: 'https://evil.test' }, body }))).status).toBe(403);
  expect(fetchMock).toHaveBeenCalledTimes(6);
});
it('exposes comment history as read-only and rejects writes and arbitrary subpaths', async () => {
  fetchMock.mockResolvedValue(Response.json({ rows: [] }));
  expect((await forwardAdmin(request('/comment-replies?status=active'))).status).toBe(200);
  expect(fetchMock.mock.calls[0][0].pathname).toBe('/comment-replies');
  expect((await forwardAdmin(request('/comment-replies', { method: 'POST', body: '{}' }))).status).toBe(405);
  expect((await forwardAdmin(request('/comment-replies/resume'))).status).toBe(404);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it('blocks cross-site and arbitrary endpoints before reading credentials or contacting services', async () => {
  expect((await forwardAdmin(request('/configs', { headers: { Origin: 'https://evil.test' } }))).status).toBe(403);
  expect((await forwardAdmin(request('/configs', { headers: { 'Sec-Fetch-Site': 'cross-site' } }))).status).toBe(403);
  expect((await forwardAdmin(request('/arbitrary-command'))).status).toBe(404);
  expect(fetchMock).not.toHaveBeenCalled();
});
it('proxies title choices and statistics only through fixed registered-ID routes', async () => {
  for (const endpoint of ['/title-stats', '/clips/1/titles', '/clips/1/titles/generate', '/clips/1/titles/selection', '/clips/1/titles/exposure']) {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    expect((await forwardAdmin(request(endpoint))).status).toBe(200);
    expect(fetchMock.mock.calls.at(-1)[0].pathname).toBe(endpoint);
  }
  expect((await forwardAdmin(request('/clips/path/titles'))).status).toBe(404);
  expect((await forwardAdmin(request('/clips/1/titles/set-default'))).status).toBe(404);
});
it('proxies login recovery through the fixed local route with a bounded body', async () => {
  fetchMock.mockResolvedValue(Response.json({ login: 'valid' }));
  expect((await forwardAdmin(request('/bilibili/login'))).status).toBe(200);
  expect(fetchMock.mock.calls[0][0].pathname).toBe('/bilibili/login');
  expect((await forwardAdmin(request('/bilibili/login/arbitrary'))).status).toBe(404);
  expect((await forwardAdmin(request('/bilibili/login', { method: 'POST', body: JSON.stringify({ cookie: 'x'.repeat(66000) }) }))).status).toBe(413);
  expect((await forwardAdmin(request('/bilibili/login', { method: 'POST', headers: { Origin: 'https://evil.test' }, body: '{}' }))).status).toBe(403);
});
it('preserves ranges and translates SRT display to VTT without leaking the server credential', async () => {
  fetchMock.mockResolvedValue(new Response('part', { status: 206, headers: { 'Content-Range': 'bytes 0-3/100', 'Accept-Ranges': 'bytes' } }));
  const response = await forwardAdmin(request('/clips/1/assets/media', { headers: { Range: 'bytes=0-3' } }));
  expect(response.status).toBe(206); expect(response.headers.get('content-range')).toBe('bytes 0-3/100');
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
  expect(response.headers.get('authorization')).toBeNull();
  fetchMock.mockResolvedValue(new Response('1\n00:00:01,020 --> 00:00:02,500\n字幕\n'));
  const subtitles = await forwardAdmin(request('/clips/1/assets/subtitles'));
  expect(subtitles.headers.get('content-type')).toContain('text/vtt');
  expect(await subtitles.text()).toContain('WEBVTT\n\n1\n00:00:01.020 --> 00:00:02.500');
});
it('forwards delayed tasks exclusively to the webhook owner and reports disconnected services', async () => {
  fetchMock.mockResolvedValue(Response.json({ tasks: [] }));
  await forwardAdmin(request('/delayed-tasks'));
  expect(fetchMock.mock.calls[0][0].pathname).toBe('/api/delayed-reply/tasks');
  expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  fetchMock.mockRejectedValue(new Error('offline'));
  expect((await forwardAdmin(request('/jobs'))).status).toBe(502);
});
it('proxies only ID-bound source playback descriptors and preserves original video range streaming', async () => {
  fetchMock.mockResolvedValue(Response.json({ start: 2742.139, end: 2959.065, origin: 2733.5 }));
  expect((await forwardAdmin(request('/clips/3359/source-playback'))).status).toBe(200);
  expect(fetchMock.mock.calls[0][0].pathname).toBe('/clips/3359/source-playback');
  fetchMock.mockResolvedValue(new Response('mp4', { status: 206, headers: { 'Content-Range': 'bytes 0-2/100' } }));
  const media = await forwardAdmin(request('/clips/3359/assets/source-preview', { headers: { Range: 'bytes=0-2' } }));
  expect(media.status).toBe(206); expect(fetchMock.mock.calls[1][1].headers.Range).toBe('bytes=0-2');
  expect((await forwardAdmin(request('/clips/3359/assets/source'))).status).toBe(404);
});
it('forwards saved feedback and one-click intents to the operator owner', async () => {
  fetchMock.mockResolvedValue(Response.json({ job: { note: '确认改词', status: 'failed' } }));
  const status = await forwardAdmin(request('/clips/3354/feedback'));
  expect(status.status).toBe(200); expect((await status.json()).job.note).toBe('确认改词');
  expect(fetchMock.mock.calls[0][0].pathname).toBe('/clips/3354/feedback');
  const body = JSON.stringify({ action: 'feedback-publish', note: '确认改词', publishApproved: true, revision: 'bound' });
  await forwardAdmin(request('/clips/3354/actions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
  expect(fetchMock.mock.calls[1][1].body).toBe(body);
  expect((await forwardAdmin(request('/clips/invalid/feedback'))).status).toBe(404);
});
it('forwards ID-bound cover preview bodies and binary images', async () => {
  fetchMock.mockResolvedValue(new Response('jpeg', { headers: { 'Content-Type': 'image/jpeg' } }));
  const body = JSON.stringify({ revision: 'current', selection: { time: 3, part: 1, text: '新封面' } });
  const result = await forwardAdmin(request('/clips/1/cover-preview', { method: 'POST', body, headers: { Origin: 'http://127.0.0.1:3000' } }));
  expect(result.status).toBe(200); expect(result.headers.get('content-type')).toBe('image/jpeg');
  expect(await result.text()).toBe('jpeg'); expect(fetchMock.mock.calls[0][1].body).toBe(body);
  expect((await forwardAdmin(request('/clips/arbitrary/cover-preview', { method: 'POST', body }))).status).toBe(404);
});
