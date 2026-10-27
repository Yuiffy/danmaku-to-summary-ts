import { QQConfig, QQInbound, QQ_PRIVATE_REPLY, qqRequest, validateQQConfig } from './QQPolicy';

const now = Date.parse('2026-10-28T02:00:00Z');
const message = (extra: Partial<QQInbound> = {}): QQInbound => ({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  senderId: 'member-a', groupOpenid: 'group-a', messageId: 'msg-1', timestamp: new Date(now).toISOString(),
  content: '<@!900000001> 你好', ...extra });
const config: QQConfig = { credentialsPath: 'credentials.json', providerConfigPath: 'provider.json', dailyTokenBudget: 409600,
  maxQueue: 20, maxUserQueue: 2, privateReply: QQ_PRIVATE_REPLY };

test('accepts the authenticated mention event even when QQ stripped the marker', () => {
  expect(qqRequest(message(), now)).toMatchObject({ scope: 'group', targetId: 'group-a', msgId: 'msg-1', text: '你好' });
  expect(qqRequest(message({ content: '你好' }), now)).toBeDefined();
});
test('ignores ordinary chatter and typed bot names or fabricated mention markers', () => {
  for (const content of ['岁己真可爱', '@鹿饼 你好', '<@!900000001> 你好']) {
    expect(qqRequest(message({ rawEventType: 'GROUP_MESSAGE_CREATE', content }), now)).toBeUndefined();
  }
  expect(qqRequest(message({ rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: false }] }), now)).toBeUndefined();
  expect(qqRequest(message({ rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: true }] }), now)).toBeDefined();
});
test('rejects stale, future, self, bot, malformed and unsupported events', () => {
  for (const extra of [{ timestamp: new Date(now - 240000).toISOString() }, { timestamp: 'invalid' },
    { timestamp: new Date(now + 61000).toISOString() }, { senderIsBot: true }, { senderId: '' },
    { groupOpenid: undefined }, { kind: 'guild' }, { content: '哈'.repeat(601) }]) {
    expect(qqRequest(message(extra), now)).toBeUndefined();
  }
  expect(qqRequest(message(), now, 'member-a')).toBeUndefined();
});
test('routes private guidance to its real sender, independently of group fields', () => {
  expect(qqRequest(message({ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE' }), now))
    .toMatchObject({ scope: 'c2c', targetId: 'member-a' });
});
test('dedupe keys include conversation and retain no plaintext identity', () => {
  const first = qqRequest(message(), now)!;
  expect(first.key).toMatch(/^[a-f0-9]{64}$/u);
  expect(first.user).toMatch(/^[a-f0-9]{64}$/u);
  expect(qqRequest(message({ groupOpenid: 'group-b' }), now)!.key).not.toBe(first.key);
});

test('optional platform nicknames are bounded display data and never change identity or admission', () => {
  const original = qqRequest(message(), now)!;
  const named = qqRequest(message({ senderName: '  小饼干\n\u200b  ' }), now)!;
  expect(named.senderName).toBe('小饼干'); expect(named.user).toBe(original.user); expect(named.key).toBe(original.key);
  expect(qqRequest(message({ senderName: '🐟'.repeat(100) }), now)!.senderName).toBe('🐟'.repeat(80));
  expect(qqRequest(message({ senderName: '   ' }), now)!.senderName).toBeUndefined();
  expect(qqRequest(message({ rawEventType: 'GROUP_MESSAGE_CREATE', senderName: '带鱼' }), now)).toBeUndefined();
});
test('validates bounded operator configuration', () => {
  expect(() => validateQQConfig(config)).not.toThrow();
  for (const extra of [{ maxQueue: 0 }, { maxUserQueue: 21 }, { dailyTokenBudget: 4095 },
    { privateReply: '' }, { privateReply: 'api key' }, { knowledge: { runtimeConfigPath: 'x', roomId: 'oops', collaborationRooms: [] } }]) {
    expect(() => validateQQConfig({ ...config, ...extra })).toThrow();
  }
});
