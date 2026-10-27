import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QQ_LIMITS } from '../qqbot/QQPolicy';
import { newQQState } from '../qqbot/QQState';
import { qqAccountUsage, qqUserQuota, readQQUsage } from './AdminQQUsage';

const now = Date.parse('2026-10-28T00:30:00+08:00'), userId = 'a'.repeat(64);
function fixture() {
  const state = newQQState('900000001'); state.day = '2026-10-28';
  state.users[userId] = { count: 200, starts: [] };
  return { state, policy: { dailyTokenBudget: 40960000, images: { enabled: true, dailyLimit: 20, userDailyLimit: 3 } } };
}

test('shows personal five-hour capacity across midnight and expiry, without treating notice suppression as a limit', () => {
  const snapshot = fixture(); snapshot.state.day = '2026-10-27';
  snapshot.state.users[userId] = { count: 200, starts: Array(100).fill(now - 2 * 3600000), noticeUntil: now + 3600000 };
  snapshot.state.tokens = snapshot.policy.dailyTokenBudget;
  const limited = qqUserQuota(snapshot, userId, 'group', now).text;
  expect(limited).toMatchObject({ status: 'limited', used: 100, remaining: 0,
    reasons: [{ code: 'user_window', until: now + 3 * 3600000 }] });
  expect(qqUserQuota(snapshot, userId, 'group', now + 3 * 3600000).text).toMatchObject({ status: 'available', used: 0, remaining: 100 });
  snapshot.state.users[userId].starts = [];
  expect(qqUserQuota(snapshot, userId, 'group', now).text.status).toBe('available');
});

test('distinguishes global minute/token gates from personal use and leaves independent images usable', () => {
  const snapshot = fixture(); snapshot.state.starts = Array(5).fill(now - 1000);
  snapshot.state.tokens = snapshot.policy.dailyTokenBudget - QQ_LIMITS.reservation + 1;
  const quota = qqUserQuota(snapshot, userId, 'group', now);
  expect(quota.text).toMatchObject({ status: 'limited', used: 0, remaining: 100 });
  expect(quota.text.reasons.map(reason => reason.code)).toEqual(['global_minute', 'global_tokens']);
  expect(quota.text.reasons[0].until).toBe(now + 59000);
  expect(quota.text.reasons[1].until).toBe(Date.parse('2026-10-29T00:00:00+08:00'));
  expect(quota.image?.status).toBe('available');
  expect(qqAccountUsage('900000001', snapshot, now)).toMatchObject({ starts: 5, startsLimit: 5, tokensUsed: snapshot.state.tokens });
});

test('image daily counts reset independently of the rolling one-minute image cooldown', () => {
  const snapshot = fixture(); snapshot.state.day = '2026-10-27';
  snapshot.state.images = 20; snapshot.state.users[userId].images = 3; snapshot.state.lastImageAt = now - 1000;
  expect(qqUserQuota(snapshot, userId, 'group', now).image).toMatchObject({ status: 'limited', used: 0,
    reasons: [{ code: 'image_cooldown', until: now + 59000 }] });
  snapshot.state.day = '2026-10-28';
  expect(qqUserQuota(snapshot, userId, 'group', now).image?.reasons.map(reason => reason.code)).toEqual(['user_images', 'global_images', 'image_cooldown']);
});

test('private guidance cooldown, pause and missing data are never shown as unrestricted text chat', () => {
  const snapshot = fixture(); snapshot.state.users[userId].privateAt = now - 1000;
  expect(qqUserQuota(snapshot, userId, 'c2c', now).text).toMatchObject({ status: 'limited', reasons: [{ code: 'private_cooldown', until: now + 599000 }] });
  snapshot.state.paused = true;
  expect(qqUserQuota(snapshot, userId, 'group', now).text.status).toBe('paused');
  expect(qqUserQuota(snapshot, userId, 'group', now).image?.status).toBe('paused');
  expect(qqUserQuota({}, userId, 'group', now).text.status).toBe('unavailable');
  expect(qqUserQuota({ state: fixture().state }, userId, 'group', now).text.status).toBe('unavailable');
});

test('fixed bounded readers reject corrupt/wrong-account ledgers and select only public policy fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-usage-'));
  try {
    fs.mkdirSync(path.join(root, 'config')); fs.mkdirSync(path.join(root, 'data/runtime/qqbot'), { recursive: true });
    const snapshot = fixture();
    fs.writeFileSync(path.join(root, 'config/qqbot.example.json'), JSON.stringify({ ...snapshot.policy, apiKey: 'never-expose-this' }));
    const file = path.join(root, 'data/runtime/qqbot/900000001.json');
    fs.writeFileSync(file, JSON.stringify(snapshot.state));
    expect(readQQUsage(root, '900000001').policy).toEqual(snapshot.policy);
    expect(JSON.stringify(readQQUsage(root, '900000001').policy)).not.toContain('never-expose-this');
    expect(readQQUsage(root, '900000001', { remaining: 1 }).state).toBeUndefined();
    expect(readQQUsage(root, '../secret')).toEqual({});
    fs.writeFileSync(file, JSON.stringify({ ...snapshot.state, appId: '900000002' }));
    expect(readQQUsage(root, '900000001').state).toBeUndefined();
    fs.writeFileSync(file, '{broken'); expect(readQQUsage(root, '900000001').state).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
