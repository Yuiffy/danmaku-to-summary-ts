import { Headers } from 'node-fetch';
import { qqDiagnostic, qqRequestId } from './QQDiagnostics';
import { validQQDiagnostic } from '../../core/admin/qqDiagnostics';

test('unknown exception metadata is bounded to safe types, fingerprints and owned filenames', () => {
  const error = Object.assign(new Error('private-api-key private-openid C:\\private\\config.json'), {
    name: 'private-api-key', code: 'private-openid', stack: 'Error: private-api-key\n' +
      '    at read (D:\\private-root\\src\\services\\live-vote\\questions\\RecordingFtsIndex.ts:123:45)\n' +
      '    at tool (D:\\private-root\\src\\services\\qqbot\\QQKnowledge.ts:33:12)\n' +
      '    at other (D:\\private-root\\untrusted\\private-secret.js:1:2)'
  });
  const failure = qqDiagnostic(error, 'tool', 'tool_failed');
  expect(failure).toMatchObject({ stage: 'tool', code: 'tool_failed', errorName: 'Error',
    frames: ['RecordingFtsIndex.ts:123:45', 'QQKnowledge.ts:33:12'] });
  expect(failure.fingerprint).toMatch(/^[a-f0-9]{64}$/u); expect(failure.systemCode).toBeUndefined();
  expect(JSON.stringify(failure)).not.toMatch(/private|config\.json/u);
  expect(validQQDiagnostic(failure)).toBe(true);
  expect(validQQDiagnostic({ ...failure, frames: ['D:\\private-root\\secret.ts:1:2'] })).toBe(false);
  expect(validQQDiagnostic({ ...failure, frames: Array(7).fill('QQAgent.ts:1:2') })).toBe(false);
});

test('upstream request IDs omit credentials, arbitrary text and overlong values with a safe fallback', () => {
  for (const value of ['private-api-key', 'https://private.example/request', 'a'.repeat(101), 'private user']) {
    expect(qqRequestId({ headers: new Headers({ 'x-request-id': value }) }, 'private-api-key')).toBeUndefined();
  }
  expect(qqRequestId({ headers: new Headers({ 'x-request-id': 'private-api-key', 'request-id': 'req-456' }) }, 'private-api-key')).toBe('req-456');
});
