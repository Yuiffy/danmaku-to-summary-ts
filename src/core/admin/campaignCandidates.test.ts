import { shortlistCampaignCandidates } from './campaignCandidates';
import type { CampaignCandidate } from './contracts';

const row = (id: string, start = 0, end = 100, score: number | undefined = 80, session = 'session'): CampaignCandidate => ({
  id, label: `R${id}`, session, start, end, score, streamerName: '主播', roomId: '1', recordedAt: '',
  streamTitle: '', title: id, reason: '', previewAvailable: true
});

it('keeps at most twenty candidates per source session in score order', () => {
  const candidates = Array.from({ length: 100 }, (_, i) => row(String(i + 1), i * 100, i * 100 + 80, 100 - i));
  const result = shortlistCampaignCandidates([...candidates, row('other', 0, 80, 70, 'other')]);
  expect(result.map(item => item.id)).toEqual([...Array.from({ length: 20 }, (_, i) => String(i + 1)), 'other']);
  expect(shortlistCampaignCandidates([{ ...row('unscored'), score: undefined }])).toEqual([]);
});

it('suppresses overlapping R/P windows by score, preserves adjacent events and keeps different sessions independent', () => {
  const candidates = [row('1', 0, 100, 80), { ...row('2', 50, 110, 90), label: 'P2' },
    row('3', 100, 200, 85), row('4', 52, 55, 75), row('5', 50, 110, 95, 'other')];
  const before = JSON.stringify(candidates);
  expect(shortlistCampaignCandidates(candidates).map(item => item.id)).toEqual(['5', '2', '3']);
  expect(JSON.stringify(candidates)).toBe(before);
});

it('deduplicates before the cap so overlapping high scores cannot crowd out independent events', () => {
  const duplicates = Array.from({ length: 20 }, (_, i) => row(String(i + 1), 0, 100, 90));
  const separate = Array.from({ length: 22 }, (_, i) => row(String(i + 21), 100 + i * 100, 180 + i * 100, 80));
  const result = shortlistCampaignCandidates([...duplicates, ...separate].reverse());
  expect(result.map(item => item.id)).toEqual(['1', ...Array.from({ length: 19 }, (_, i) => String(i + 21))]);
});

it('requires finite scores and positive source windows while preserving a real zero score', () => {
  const valid = row('1', 0, 10, 0);
  expect(shortlistCampaignCandidates([valid, row('2', -1, 10), row('3', 10, 10), row('4', 10, Infinity),
    row('5', NaN, 20), row('6', 0, 10, NaN), row('7', 0, 10, Infinity), { ...row('8'), start: undefined }])).toEqual([valid]);
});
