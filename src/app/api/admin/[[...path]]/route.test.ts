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
it('blocks cross-site and arbitrary endpoints before reading credentials or contacting services', async () => {
  expect((await forwardAdmin(request('/configs', { headers: { Origin: 'https://evil.test' } }))).status).toBe(403);
  expect((await forwardAdmin(request('/configs', { headers: { 'Sec-Fetch-Site': 'cross-site' } }))).status).toBe(403);
  expect((await forwardAdmin(request('/arbitrary-command'))).status).toBe(404);
  expect(fetchMock).not.toHaveBeenCalled();
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
