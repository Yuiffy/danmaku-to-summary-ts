export {};
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { buildParticipantContext, participantPromptLines, identityDanmaku, loadRecordingParticipants, attributionEnabled } = require('./participant_context');
const { buildRerankEvidence } = require('./rerank_evidence');
const { buildChunkSources } = require('./own_selection');
const registry = { ai: { streamerRegistry: {
  host: { displayName: 'Host', roomIds: ['1'], aiClipName: 'HostClip' },
  guest: { displayName: 'Guest', aiClipName: 'GuestClip' },
  other: { displayName: 'MentionedOnly' }
} } };

describe('participant context', () => {
  const parsed = { segments: [{ start: 0, end: 60, text: 'Guest called.' }] };
  const comments = Array.from({ length: 60 }, (_, i) => ({ time: i, text: i === 25 ? 'Guest called Host' : 'ha' }));
  test('does not upgrade name mentions into participants or speaker truth', () => {
    const context = buildParticipantContext(registry, { roomId: '1' }, parsed, comments);
    expect(context.people.find((p: any) => p.id === 'guest').presence).toBe('mentioned_only');
    const planned = buildParticipantContext(registry, { roomId: '1' }, parsed, comments, { plannedParticipantIds: ['guest'] });
    expect(planned.people.find((p: any) => p.id === 'guest').presence).toBe('planned');
    expect(participantPromptLines(planned).join('\n')).toContain('名单或房主身份不是逐句说话人证据');
    expect(participantPromptLines(planned).join('\n')).toContain('GuestClip');
  });
  test('keeps sparse identity comments with exact IDs in both selection stages', () => {
    const context = buildParticipantContext(registry, { roomId: '1' }, parsed, comments);
    const source = { ...parsed, participantContext: context };
    const settings = { chunkSeconds: 600, maxSubtitleCharsPerChunk: 14000, reactionKeywords: ['ha'],
      minClipSeconds: 1, maxClipSeconds: 120, ai: { maxCandidateDanmakuLines: 2 } };
    expect(identityDanmaku(comments, { start: 0, end: 60 }, context)).toContain(comments[25]);
    const packed = buildRerankEvidence([{ index: 1, start: 0, end: 60 }], source, comments, settings);
    expect(packed.danmakuIds.has('D26')).toBe(true);
    expect(packed.danmakuLines).toContain('D26 25 "Guest called Host"');
    const chunks = buildChunkSources(source, comments, 60, settings);
    expect(chunks[0].allowedDanmakuIds.has('D26')).toBe(true);
    expect(chunks[0].sourceText).toContain('D26 25 "Guest called Host"');
    expect(identityDanmaku(comments, { start: 30, end: 60 }, context).some((row: any) => row.time === 25)).toBe(false);
  });
  test('requires a room allowlist for activation', () => {
    expect(attributionEnabled({ attribution: { enabled: true } }, '1')).toBe(false);
    expect(attributionEnabled({ attribution: { enabled: true, roomIds: ['1'] } }, '1')).toBe(true);
    expect(attributionEnabled({ attribution: { enabled: true, roomIds: ['1'] } }, '2')).toBe(false);
  });
  test('writes an idempotent explicit recording roster and refuses changed sources', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-people-writer-'));
    try {
      const mediaPath = path.join(dir, 'source.flv'), srtPath = path.join(dir, 'source.srt');
      fs.writeFileSync(mediaPath, 'media'); fs.writeFileSync(srtPath, 'speech');
      const args = { mediaPath, srtPath, roomId: '1', participantIds: ['guest'] };
      const { writeRecordingParticipants } = require('../asr/recording_roster');
      const first = writeRecordingParticipants(args);
      expect(writeRecordingParticipants(args)).toEqual(first);
      expect(() => writeRecordingParticipants({ ...args, participantIds: ['other'] })).toThrow();
      fs.writeFileSync(srtPath, 'changed speech');
      expect(() => writeRecordingParticipants(args)).toThrow();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('rosters are bound to the source SRT and room, not merely the neighboring filename', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-people-'));
    try {
      const srt = path.join(dir, 'source.srt');
      fs.writeFileSync(srt, 'source');
      const file = srt.replace('.srt', '.participants.json');
      fs.writeFileSync(file, JSON.stringify({ version: 1, roomId: '1', source: 'user_confirmation',
        sourceMediaPath: path.join(dir, 'source.flv'),
        subtitleSha256: crypto.createHash('sha256').update('source').digest('hex'), plannedParticipantIds: ['guest'] }));
      expect(loadRecordingParticipants(srt, path.join(dir, 'source.flv'), '1').plannedParticipantIds).toEqual(['guest']);
      expect(loadRecordingParticipants(srt, path.join(dir, 'source.flv'), '2').issues).toEqual(['participant_source_mismatch']);
      fs.writeFileSync(srt, 'changed');
      expect(loadRecordingParticipants(srt, path.join(dir, 'source.flv'), '1').plannedParticipantIds).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
