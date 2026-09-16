const fs = require('fs');
const os = require('os');
const path = require('path');
const collection = require('./participant_collection');
const asr = require('./asr_backends');
const live = require('../live_generation_context');

describe('participant discovery reaches ASR and reply context', () => {
  const config = { ai: { streamerRegistry: {
    host: { displayName: '房主', roomIds: ['1'], uid: '11', speakerLabels: ['房主'] },
    guest: { displayName: '嘉宾', roomIds: ['2'], speakerLabels: ['嘉宾'] },
    other: { displayName: '路过', roomIds: ['3'], speakerLabels: ['路过'] }
  } } };
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'participant-collection-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const filename = '录制-1-20260912-200000-001-和嘉宾联动';
  const fetcher = async () => ({ success: true, data: { dynamics: [
    { id: 'current', publishTime: '2026-09-12T18:00:00+08:00', content: '今晚和嘉宾联动' },
    { id: 'tomorrow', publishTime: '2026-09-12T19:00:00+08:00', content: '明天和路过联动' }
  ] } });

  it('binds title and dynamic candidates to this recording without claiming they spoke', async () => {
    const media = path.join(dir, filename + '.flv'); fs.writeFileSync(media, 'media');
    const discovery = await collection.prepareParticipantDiscovery(media, config, { durationSeconds: 3600, fetcher });
    expect(discovery).toMatchObject({ mode: 'multi', modeStatus: 'planned', plannedParticipantIds: ['guest'],
      confirmedParticipantIds: [], constrainToRoster: false });
    expect(discovery.rejectedEvidence).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'event_day_mismatch' })]));
    const request = collection.mergeDiscoveryRequest(null, discovery);
    const summary = asr.summarizeAsrSpeakers({ backend: 'paraformer', segments: [
      { start: 0, end: 20, speaker: '路过', speaker_score: 0.9 },
      { start: 20, end: 45, speaker: '嘉宾', speaker_score: 0.99,
        speakerEvidence: { version: 1, status: 'mixed', label: null, observations: [] } }
    ] }, config, { roomId: '1', mediaPath: media, speakerRequest: request });
    expect(summary.appearedStreamerIds).toEqual(['other']);
    expect(summary.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ streamerId: 'guest', appeared: false, discoveryStatus: 'planned' }),
      expect.objectContaining({ streamerId: 'other', appeared: true, planned: false })
    ]));
    expect(summary.participantDiscovery.modeStatus).toBe('planned');
    const srt = path.join(dir, filename + '.srt'); fs.writeFileSync(srt, '');
    const highlight = path.join(dir, filename + '_AI_HIGHLIGHT.txt');
    const prepared = await live.prepareLiveGenerationContext(highlight, '1', config, { srtPath: srt, fetcher });
    expect(prepared.context.participantDiscovery.plannedParticipantIds).toEqual(['guest']);
    expect(live.formatLiveGenerationContext(prepared.context)).toContain('不能据此给某句字幕署名');
    fs.appendFileSync(media, 'replaced');
    expect(collection.loadParticipantDiscovery(srt, '1', config)).toBeNull();
  });

  it('uses a recording title when dynamics fail, and rejects copied or cross-room evidence', async () => {
    const media = path.join(dir, filename + '.flv'); fs.writeFileSync(media, 'media');
    const discovery = await collection.prepareParticipantDiscovery(media, config, { durationSeconds: 3600,
      fetcher: async () => { throw new Error('unavailable'); } });
    expect(discovery.mode).toBe('multi');
    expect(discovery.sources.dynamics).toBe('unavailable');
    expect(collection.loadParticipantDiscovery(media, '2', config)).toBeNull();
    const other = path.join(dir, 'other.flv'); fs.writeFileSync(other, 'media');
    fs.copyFileSync(collection.discoveryPath(media), collection.discoveryPath(other));
    expect(collection.loadParticipantDiscovery(other, '1', config)).toBeNull();
  });

  it('collects title/dynamic candidates for existing SRT-only reply workflows', async () => {
    const highlight = path.join(dir, filename + '_AI_HIGHLIGHT.txt');
    const prepared = await live.prepareLiveGenerationContext(highlight, '1', config, { fetcher });
    expect(prepared.context.participantDiscovery.plannedParticipantIds).toEqual(['guest']);
    expect(prepared.context.participantDiscovery.confirmedParticipantIds).toEqual([]);
  });

  it('preserves an explicit speaker request if automatic discovery is disabled or the media disappeared', async () => {
    const manual = { mode: 'planned_roster', hostStreamerId: 'host', plannedParticipantIds: ['guest'],
      participants: [{ streamerId: 'host' }, { streamerId: 'guest' }] };
    const media = path.join(dir, filename + '.flv');
    expect(await collection.prepareAsrSpeakerRequest(media,
      { ...config, asr: { participantDiscovery: { enabled: false } } }, { room_id: '1' }, 3600, manual)).toBe(manual);
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await collection.prepareAsrSpeakerRequest(media, config, { room_id: '1' }, 3600, manual)).toBe(manual);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('保留开放集识别'));
    } finally { warning.mockRestore(); }
  });

  it('uses original video for vision while keeping the ASR media binding and manual request', async () => {
    const media = path.join(dir, filename + '.wav'); fs.writeFileSync(media, 'audio');
    const originalVideo = path.join(dir, 'original-video.flv'); fs.writeFileSync(originalVideo, 'video');
    const dynamicFetch = jest.spyOn(live, 'fetchRecentDynamics').mockResolvedValue({ status: 'ok', dynamics: [] });
    const vision = jest.spyOn(require('./participant_visual'), 'collectParticipantVisualEvidence')
      .mockResolvedValue({ status: 'ready', evidence: [] });
    try {
      const request = await collection.prepareAsrSpeakerRequest(media,
        { ...config, asr: { participantDiscovery: { enabled: true, visual: { enabled: true } } } },
        { room_id: '1', sourceMediaPath: originalVideo }, 3600, { mode: 'speaker_once', hostStreamerId: 'host' });
      expect(vision).toHaveBeenCalledWith(originalVideo, expect.anything(), expect.objectContaining({
        roomId: '1', durationSeconds: 3600, sessionId: path.resolve(media)
      }));
      expect(request.mode).toBe('speaker_once');
      expect(request.plannedParticipantIds).toEqual(['guest']);
      expect(request.participantDiscovery.binding.sourceMediaPath).toBe(path.resolve(media));
    } finally { dynamicFetch.mockRestore(); vision.mockRestore(); }
  });
});
