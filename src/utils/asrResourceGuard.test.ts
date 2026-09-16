import {
  getAsrGamePollIntervalMs,
  normalizeAsrProcessNames,
  parseTasklistImageNames
} from './asrResourceGuard';

describe('asrResourceGuard', () => {
  test('normalizes configured Windows image names', () => {
    expect(normalizeAsrProcessNames([
      'DeltaForceClient-Win64-Shipping',
      'C:\\Games\\DeltaForceClient-Win64-Shipping.exe',
      ''
    ])).toEqual(['deltaforceclient-win64-shipping.exe']);
  });

  test('parses tasklist CSV image names', () => {
    const output = [
      '"DeltaForceClient-Win64-Shipping.exe","1234","Console","1","1,234 K"',
      '"node.exe","4567","Console","1","20,000 K"'
    ].join('\r\n');

    expect(parseTasklistImageNames(output)).toEqual(new Set([
      'deltaforceclient-win64-shipping.exe',
      'node.exe'
    ]));
  });

  test('clamps the polling interval to a practical minimum', () => {
    expect(getAsrGamePollIntervalMs({
      resource_guard: { poll_interval_s: 0.01 }
    })).toBe(250);
    expect(getAsrGamePollIntervalMs({
      resource_guard: { poll_interval_s: 4 }
    })).toBe(4000);
  });
});
