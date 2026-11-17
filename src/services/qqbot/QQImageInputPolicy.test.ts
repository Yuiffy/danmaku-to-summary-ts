import { qqImageAttachmentUrl, qqImageInput, qqImageInputDiagnostic } from './QQImageInputPolicy';

test('all original URLs survive up to 24 inputs and larger requests remain invalid rather than silently dropping pages', () => {
  const attachments = Array.from({ length: 24 }, (_, index) => ({ content_type: 'image/png', url: `https://gchat.qpic.cn/page-${index}` }));
  const input = qqImageInput({ attachments });
  expect(input?.urls).toEqual(attachments.map(item => item.url));
  expect(input?.invalid).toBeUndefined();
  expect(qqImageInput({ attachments: [...attachments, attachments[0]] })?.invalid).toBe(true);
});

test.each(['https://', 'http://', '//'])('accepts the authenticated QQ multimedia .com.cn attachment with prefix %s', prefix => {
  const url = `${prefix}multimedia.nt.qq.com.cn/download?appid=1406&fileid=fixture&rkey=private-token`;
  const expected = 'https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=fixture&rkey=private-token';
  expect(qqImageAttachmentUrl(url)).toBe(expected);
  for (const message of [ { attachments: [{ content_type: 'image/jpeg', url }] },
    { msgType: 103, refMsgIdx: 'quote', msgElements: [{ attachments: [{ content_type: 'image/jpeg', url }] }] } ]) {
    const input = qqImageInput(message);
    expect(input?.urls).toEqual([expected]); expect(input?.invalid).toBeUndefined();
    expect(qqImageInputDiagnostic(message, input)).toMatchObject({ sourceCount: 1, invalid: false });
  }
});

test.each(['https://multimedia.nt.qq.com.cn.evil.invalid/download', 'https://evil.multimedia.nt.qq.com.cn/download',
  'https://user:pass@multimedia.nt.qq.com.cn/download', 'https://multimedia.nt.qq.com.cn:8443/download'])
('the additional exact QQ hostname does not admit %s', url => {
  expect(qqImageAttachmentUrl(url)).toBeUndefined();
});

test.each([
  ['https://new-cdn.qq.com.cn/private-path?token=private-token', 'hostname', 'absolute', 'new-cdn.qq.com.cn'],
  ['https://name:private-password@gchat.qpic.cn/private-path?token=private-token', 'credentials', 'absolute', 'gchat.qpic.cn'],
  ['https://gchat.qpic.cn:8443/private-path#private-fragment', 'port', 'absolute', 'gchat.qpic.cn'],
  ['https://gchat.qpic.cn/private-path#private-fragment', 'fragment', 'absolute', 'gchat.qpic.cn'],
  ['gchat.qpic.cn/private-path?token=private-token', 'malformed_url', 'no_scheme', undefined],
  ['', 'malformed_url', 'empty', undefined],
  ['file:///private-path', 'protocol', 'absolute', undefined]
])('rejected attachment diagnostics explain %s without admitting it or retaining sensitive fields', (url, reason, shape, hostname) => {
  const message = { msgType: 103, refMsgIdx: 'private-reference', msgElements: [
    { attachments: [{ content_type: 'image/png', url }] }
  ] };
  const input = qqImageInput(message);
  expect(qqImageAttachmentUrl(url)).toBeUndefined();
  expect(input).toEqual({ urls: [], reply: 'private-reference', invalid: true });
  const diagnostic = qqImageInputDiagnostic(message, input);
  expect(diagnostic).toMatchObject({ urlDiagnosticsVersion: 1, sourceCount: 0, invalid: true,
    rejectedImageUrls: [{ source: 'element', reason, shape, ...(hostname ? { hostname } : {}) }] });
  expect(JSON.stringify(diagnostic)).not.toMatch(/private-|token=|https?:\/\/|file:\/\/|name:/u);
});

test('diagnostics bound rejected sources and omit oversized raw hostnames and non-image attachments', () => {
  const attachments = Array.from({ length: 40 }, () => ({ content_type: 'image/jpeg', url: `https://${'x'.repeat(129)}.invalid/private-path?token=private-token` }));
  const message = { attachments, msgElements: [{ attachments: [{ content_type: 'text/plain', url: 'https://bad.invalid/private-path' }] }] };
  const diagnostic = qqImageInputDiagnostic(message, qqImageInput(message));
  expect(diagnostic.rejectedImageUrls).toHaveLength(8);
  expect(diagnostic.rejectedImageUrls!.every(item => item.hostname === undefined)).toBe(true);
  expect(JSON.stringify(diagnostic)).not.toMatch(/private-|token=|bad\.invalid|xxxxx/u);
});

test('accepted attachment URLs keep the existing count-only diagnostics', () => {
  const message = { attachments: [{ content_type: 'image/png', url: '//gchat.qpic.cn/private-path?token=private-token' }] };
  const diagnostic = qqImageInputDiagnostic(message, qqImageInput(message));
  expect(diagnostic).toMatchObject({ sourceCount: 1, invalid: false });
  expect(diagnostic.rejectedImageUrls).toBeUndefined();
  expect(JSON.stringify(diagnostic)).not.toMatch(/private-|token=|gchat/u);
});

test('unclassified quote attachment diagnostics explain missing sources using bounded categories without changing admission', () => {
  const message = { msgType: 103, refMsgIdx: 'private-reference', msgElements: [{ attachments: [
    { content_type: '', url: 'https://gchat.qpic.cn/private-path?token=private-token' },
    { content_type: 'image', url: '' },
    { content_type: ' Image/PNG ', url: 'https://bad.invalid/private-path' },
    { content_type: 'application/octet-stream', url: '' },
    ...Array.from({ length: 35 }, () => ({ content_type: 'private-value', url: 'private-url' }))
  ] }] };
  const input = qqImageInput(message);
  expect(input).toEqual({ reply: 'private-reference', urls: [] });
  const diagnostic = qqImageInputDiagnostic(message, input);
  expect(diagnostic.unclassifiedAttachments).toHaveLength(8);
  expect(diagnostic).toMatchObject({ attachmentDiagnosticsVersion: 1, sourceCount: 0, invalid: false,
    unclassifiedAttachments: [
      { source: 'element', contentType: 'missing', url: 'allowed' },
      { source: 'element', contentType: 'image_noncanonical', url: 'missing' },
      { source: 'element', contentType: 'image_noncanonical', url: 'rejected' },
      { source: 'element', contentType: 'octet_stream', url: 'missing' },
      ...Array.from({ length: 4 }, () => ({ source: 'element', contentType: 'other', url: 'rejected' }))
    ] });
  expect(JSON.stringify(diagnostic)).not.toMatch(/private-|token=|https?:|gchat|bad\.invalid/u);
});
