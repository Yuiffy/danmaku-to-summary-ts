/** Shared loopback/origin boundary for both the workspace and legacy task adapter. */
export function isLocalAdminRequest(request: { url: string; headers: Pick<Headers, 'get'> }): boolean {
  const url = new URL(request.url), host = request.headers.get('host') || '', origin = request.headers.get('origin');
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/u.test(host) &&
    new URL(`${url.protocol}//${host}`).port === url.port && (!origin || origin === `${url.protocol}//${host}`) &&
    request.headers.get('sec-fetch-site') !== 'cross-site';
}
