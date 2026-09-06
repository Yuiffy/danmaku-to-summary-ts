import { NextRequest } from 'next/server';
import { GET, POST, DELETE } from './route';

describe('delayed task web adapter', () => {
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;
  const originalBaseUrl = process.env.WEBHOOK_BASE_URL;

  beforeEach(() => {
    global.fetch = fetchMock;
    fetchMock.mockReset();
    process.env.WEBHOOK_BASE_URL = 'http://127.0.0.1:19999';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.WEBHOOK_BASE_URL;
    else process.env.WEBHOOK_BASE_URL = originalBaseUrl;
  });

  function reply(body: unknown, status = 200) {
    fetchMock.mockResolvedValue({ status, json: async () => body });
  }
  function request(body: unknown) {
    return { json: async () => body } as NextRequest;
  }

  test('reads the running service queue without caching', async () => {
    reply({ tasks: [{ taskId: 'existing' }] });
    expect(await (await GET()).json()).toEqual({ tasks: [{ taskId: 'existing' }] });
    expect(fetchMock.mock.calls[0][0].toString()).toBe('http://127.0.0.1:19999/api/delayed-reply/tasks');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store' });
  });

  test('forwards zero-second delay and paths without mutating room configuration', async () => {
    const body = { roomId: '123', delaySeconds: 0, goodnightTextPath: 'reply.md' };
    reply({ success: true, taskId: 'new' });
    expect((await POST(request(body))).status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body);
  });

  test('encodes task IDs and preserves upstream cancellation errors', async () => {
    reply({ error: 'Task is currently publishing' }, 409);
    expect((await DELETE(request({ taskId: 'a/b ?' }))).status).toBe(409);
    expect(fetchMock.mock.calls[0][0].pathname).toBe('/api/delayed-reply/tasks/a%2Fb%20%3F');
  });

  test('reports unavailable and non-JSON upstreams', async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'));
    expect((await GET()).status).toBe(502);
    fetchMock.mockResolvedValue({ status: 404, json: async () => { throw new Error('HTML'); } });
    expect((await GET()).status).toBe(502);
  });

  test('rejects invalid local input before forwarding', async () => {
    expect((await POST(request(null))).status).toBe(400);
    expect((await DELETE(request({ taskId: [] }))).status).toBe(400);
    const invalid = { json: async () => { throw new Error('invalid'); } } as unknown as NextRequest;
    expect((await POST(invalid)).status).toBe(400);
    expect((await DELETE(invalid)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
