import { parseQQArgs } from './run';

test('defaults to read-only validation and requires an explicit live mode', () => {
  expect(parseQQArgs([]).mode).toBe('check');
  expect(parseQQArgs(['--live']).mode).toBe('live');
  expect(() => parseQQArgs(['--live', '--resume'])).toThrow();
  expect(() => parseQQArgs(['--config'])).toThrow();
  expect(() => parseQQArgs(['--model', 'other'])).toThrow();
});
