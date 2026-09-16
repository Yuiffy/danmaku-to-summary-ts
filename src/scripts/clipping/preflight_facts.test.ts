export {};
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { loadVerifiedTopicFacts } = require('./preflight_facts');

test('human confirmations require exact source hash, time scope and explicit user authority', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-facts-'));
  const srt = path.join(dir, 'source.srt');
  const registry = path.join(dir, 'facts.json');
  fs.writeFileSync(srt, 'original source');
  const sourceSha256 = crypto.createHash('sha256').update(fs.readFileSync(srt)).digest('hex');
  const entry = { srtPath: srt, sourceSha256, start: 10, end: 40, authority: 'user', facts: ['Verified activity'],
    edits: [{ start: 12, end: 15, original: 'wrong', replacement: 'right' },
      { start: 200, end: 220, original: 'other', replacement: 'should not leak' }] };
  try {
    fs.writeFileSync(registry, JSON.stringify({ version: 1, entries: [entry] }));
    const matched = loadVerifiedTopicFacts(srt, { start: 0, end: 50 }, registry);
    expect(matched.status).toBe('matched');
    expect(matched.verifiedFacts).toEqual([{ text: 'Verified activity', start: 10, end: 40 }]);
    expect(matched.verifiedEdits).toHaveLength(1);
    expect(loadVerifiedTopicFacts(srt, { start: 60, end: 90 }, registry).status).toBe('missing');
    expect(loadVerifiedTopicFacts(path.join(dir, 'other.srt'), { start: 0, end: 50 }, registry).status).toBe('missing');
    fs.writeFileSync(srt, 'changed source');
    expect(loadVerifiedTopicFacts(srt, { start: 0, end: 50 }, registry).status).toBe('stale');
    fs.writeFileSync(srt, 'original source');
    fs.writeFileSync(registry, JSON.stringify({ version: 1, entries: [{ ...entry, authority: 'model' }] }));
    expect(loadVerifiedTopicFacts(srt, { start: 0, end: 50 }, registry).verifiedEdits).toEqual([]);
    fs.writeFileSync(registry, '{bad');
    expect(loadVerifiedTopicFacts(srt, { start: 0, end: 50 }, registry).status).toBe('invalid');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
