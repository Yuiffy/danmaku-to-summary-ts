const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { collectParticipantVisualEvidence, collectCurrentRoomMetadata, captureParticipantRoomSnapshot,
  loadParticipantRoomSnapshot, sampleFrameOffsets, visualPrompt, parseVisualResponse } = require('./participant_visual');

const observation = { name: '栞栞', relation: 'present', kind: 'live_participant',
  identityBasis: 'visible_name_label', confidence: 0.98, quote: '右下角嘉宾面板标签“栞栞”' };
const asset = { id: 'frame-1', source: 'frame', path: 'bound-frame.jpg', roomId: '25788785',
  sessionId: 'session', observedAt: '2026-09-12T20:01:00+08:00', offsetSeconds: 60, sha256: 'real-image-hash' };
const response = (extra: any = {}) => ({ images: [{ imageId: 'frame-1', sceneContext: 'live', observations: [observation], ...extra }] });

describe('participant visual evidence', () => {
  test('samples across the complete duration within the eight-image client budget', () => {
    expect(sampleFrameOffsets(7200, 50)).toHaveLength(7);
    expect(sampleFrameOffsets(7200)[0]).toBe(216);
    expect(sampleFrameOffsets(7200).at(-1)).toBe(6912);
    expect(sampleFrameOffsets(NaN)).toEqual([]);
    expect(sampleFrameOffsets(0)).toEqual([]);
  });

  test('binds provider observations to captured image provenance and ignores forged source fields', () => {
    const value = response({ roomId: 'wrong', offsetSeconds: 99999 });
    value.images[0].observations = [{ ...observation, streamerId: 'another_person' }];
    const evidence = parseVisualResponse(value, [asset]);
    expect(evidence[0]).toMatchObject(asset);
    expect(evidence[0].observations[0].streamerId).toBeUndefined();
    expect(evidence[0].offsetSeconds).toBe(60);
  });

  test.each([
    { images: [] },
    { images: [response().images[0], response().images[0]] },
    response({ imageId: 'invented-frame' }),
    response({ sceneContext: 'confirmed_solo' }),
    response({ observations: [{ ...observation, confidence: 9 }] }),
    response({ observations: [{ ...observation, confidence: '0.99' }] })
  ])('rejects missing/duplicate/invented image IDs and malformed observations', (value: any) => {
    expect(() => parseVisualResponse(value, [asset])).toThrow();
  });

  test('appearance-only and invented label claims cannot be live presence', () => {
    const evidence = parseVisualResponse(response({ observations: [
      { ...observation, identityBasis: 'appearance_only' }, { ...observation, quote: '一个浅色头发的头像' }
    ] }), [asset]);
    expect(evidence[0].observations.every((value: any) => value.relation === 'candidate')).toBe(true);
  });

  test('bound covers remain poster evidence even if a model calls them live', () => {
    const evidence = parseVisualResponse(response(), [{ ...asset, source: 'cover' }]);
    expect(evidence[0].sceneContext).toBe('poster');
  });

  test('prompt does not tell the model the host must appear and separates scenes from speakers', () => {
    const prompt = visualPrompt([asset], { shiori: { displayName: '栞栞', mentionLabels: ['小栞'] } });
    expect(prompt).toContain('不可根据房间归属补出房主');
    expect(prompt).toContain('出现一个人的立绘不能判断单播');
    expect(prompt).toContain('不是声纹识别概率');
  });
});

describe('participant visual collection', () => {
  let directory: string;
  let mediaPath: string;
  let jpeg: Buffer;
  const config = { asr: { participantDiscovery: { visual: { enabled: true, maxFrames: 3, currentRoom: { enabled: false } } } } };
  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'participant-visual-test-'));
    mediaPath = path.join(directory, 'video with spaces.flv');
    fs.writeFileSync(mediaPath, 'test-media');
    jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#5d6881' } }).jpeg().toBuffer();
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  const makeReply = (prompt: string) => {
    const assets = JSON.parse(prompt.split('\n').find((line: string) => line.startsWith('[{"imageId"'))!);
    return { text: JSON.stringify({ images: assets.map((item: any) => ({ imageId: item.imageId,
      sceneContext: 'live', observations: [observation] })) }), model: 'test-model' };
  };

  test('captures separated frames with argument-safe hidden FFmpeg and calls the shared client once', async () => {
    const commands: any[] = [];
    const execFile = async (command: string, args: string[], options: any) => {
      commands.push({ command, args, options });
      fs.writeFileSync(args.at(-1), jpeg);
      return { stdout: '' };
    };
    const requestVisual = jest.fn(async (prompt: string, images: string[]) => {
      expect(images).toHaveLength(3);
      expect(images[0]).toMatch(/^data:image\/jpeg;base64,/);
      return makeReply(prompt);
    });
    const result = await collectParticipantVisualEvidence(mediaPath, config, { ...asset, startedAt: '2026-09-12T20:00:00+08:00',
      durationSeconds: 3600, outputDirectory: path.join(directory, 'evidence'), execFile, requestVisual });
    expect(result.status).toBe('ready');
    expect(result.sampledFrameCount).toBe(3);
    expect(result.evidence.map((item: any) => item.offsetSeconds)).toEqual([108, 1782, 3456]);
    expect(requestVisual).toHaveBeenCalledTimes(1);
    expect(commands[0].options).toMatchObject({ shell: false, windowsHide: true });
    expect(commands[0].args).toContain(mediaPath);
    expect(result.coverage).toBe('sparse_frames_not_full_session');
    expect(fs.existsSync(path.join(result.directory, 'evidence.json'))).toBe(true);
  });

  test('skips a stale or unbound cover while keeping valid recording frames', async () => {
    const coverPath = path.join(directory, 'cover.jpg');
    fs.writeFileSync(coverPath, jpeg);
    const result = await collectParticipantVisualEvidence(mediaPath, config, { ...asset, startedAt: '2026-09-12T20:00:00+08:00',
      durationSeconds: 3600, outputDirectory: path.join(directory, 'evidence'), coverPath,
      execFile: async (_: string, args: string[]) => { fs.writeFileSync(args.at(-1), jpeg); return { stdout: '' }; },
      requestVisual: async (prompt: string) => makeReply(prompt) });
    expect(result.status).toBe('partial');
    expect(result.issues).toContain('cover_unbound');
    expect(result.evidence.every((item: any) => item.source === 'frame')).toBe(true);
  });

  test('vision errors fail open with no invented participation', async () => {
    const result = await collectParticipantVisualEvidence(mediaPath, config, { ...asset, startedAt: '2026-09-12T20:00:00+08:00',
      durationSeconds: 3600, outputDirectory: path.join(directory, 'evidence'),
      execFile: async (_: string, args: string[]) => { fs.writeFileSync(args.at(-1), jpeg); return { stdout: '' }; },
      requestVisual: async () => { throw new Error('vision unavailable'); } });
    expect(result.status).toBe('unavailable');
    expect(result.evidence).toEqual([]);
    expect(result.issues).toContain('vision unavailable');
  });

  test('a completed request is reused with its image and model fingerprint', async () => {
    const requestVisual = jest.fn(async (prompt: string) => makeReply(prompt));
    const options = { ...asset, startedAt: '2026-09-12T20:00:00+08:00', durationSeconds: 3600,
      outputDirectory: path.join(directory, 'evidence'),
      execFile: async (_: string, args: string[]) => { fs.writeFileSync(args.at(-1), jpeg); return { stdout: '' }; }, requestVisual };
    const first = await collectParticipantVisualEvidence(mediaPath, config, options);
    const second = await collectParticipantVisualEvidence(mediaPath, config, options);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(first.requestKey).toBe(second.requestKey);
    expect(requestVisual).toHaveBeenCalledTimes(1);
  });

  test('an unknown request outcome does not resubmit during automatic ASR retries', async () => {
    const requestVisual = jest.fn(async () => { throw new Error('connection interrupted'); });
    const options = { ...asset, startedAt: '2026-09-12T20:00:00+08:00', durationSeconds: 3600,
      outputDirectory: path.join(directory, 'evidence'),
      execFile: async (_: string, args: string[]) => { fs.writeFileSync(args.at(-1), jpeg); return { stdout: '' }; }, requestVisual };
    await collectParticipantVisualEvidence(mediaPath, config, options);
    const second = await collectParticipantVisualEvidence(mediaPath, config, options);
    expect(second.status).toBe('outcome_unknown');
    expect(second.issues).toContain('visual_request_requires_reconciliation');
    expect(requestVisual).toHaveBeenCalledTimes(1);
  });

  test('disabled or sessionless runs do not call FFmpeg or paid inference', async () => {
    const execFile = jest.fn();
    const requestVisual = jest.fn();
    expect((await collectParticipantVisualEvidence(mediaPath, {}, { execFile, requestVisual })).status).toBe('disabled');
    expect((await collectParticipantVisualEvidence(mediaPath, config, { execFile, requestVisual })).status).toBe('unavailable');
    expect(execFile).not.toHaveBeenCalled();
    expect(requestVisual).not.toHaveBeenCalled();
  });

  test('downloads the public room cover only when the exact current session matches', async () => {
    const fetcher = jest.fn(async (url: string) => url.includes('get_info')
      ? { ok: true, json: async () => ({ code: 0, data: { room_id: 25788785, live_status: 1,
        live_time: '2026-09-12 20:00:00', title: '和栞栞联动', user_cover: 'https://i0.hdslb.com/cover.jpg' } }) }
      : { ok: true, buffer: async () => jpeg });
    const result = await collectCurrentRoomMetadata({}, { roomId: '25788785', startedAt: '2026-09-12T20:00:00+08:00',
      now: Date.parse('2026-09-12T21:00:00+08:00'), durationSeconds: 7200, outputDirectory: directory, fetcher });
    expect(result.status).toBe('ready');
    expect(result.evidence[0]).toMatchObject({ source: 'room_title', text: '和栞栞联动' });
    expect(result.coverEvidence.observedAt).toBe('2026-09-12T13:00:00.000Z');
    expect(fs.existsSync(result.coverEvidence.path)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test.each([
    { room_id: 25788785, live_status: 1, live_time: '2026-09-11 20:00:00' },
    { room_id: 25788785, live_status: 0, live_time: '2026-09-12 20:00:00' },
    { room_id: 26966466, live_status: 1, live_time: '2026-09-12 20:00:00' }
  ])('rejects a cover from a different room, previous broadcast or inactive room', async (data: any) => {
    const fetcher = jest.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: {
      ...data, user_cover: 'https://i0.hdslb.com/cover.jpg' } }) }));
    const result = await collectCurrentRoomMetadata({}, { roomId: '25788785', startedAt: '2026-09-12T20:00:00+08:00',
      now: Date.parse('2026-09-12T21:00:00+08:00'), durationSeconds: 7200, outputDirectory: directory, fetcher });
    expect(result.status).toBe('live_session_mismatch');
    expect(result.evidence).toEqual([]);
    expect(result.coverEvidence).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('does not request the current room for a completed historical recording', async () => {
    const fetcher = jest.fn();
    const result = await collectCurrentRoomMetadata({}, { roomId: '25788785', startedAt: '2026-09-11T20:00:00+08:00',
      now: Date.parse('2026-09-12T21:00:00+08:00'), durationSeconds: 7200, outputDirectory: directory, fetcher });
    expect(result.status).toBe('recording_not_current');
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('rejects an API-supplied cover URL outside public Bilibili image domains', async () => {
    const fetcher = jest.fn(async () => ({ ok: true, json: async () => ({ code: 0, data: { room_id: 25788785,
      live_status: 1, live_time: '2026-09-12 20:00:00', user_cover: 'http://127.0.0.1/private', title: '单播' } }) }));
    const result = await collectCurrentRoomMetadata({}, { roomId: '25788785', startedAt: '2026-09-12T20:00:00+08:00',
      now: Date.parse('2026-09-12T21:00:00+08:00'), durationSeconds: 7200, outputDirectory: directory, fetcher });
    expect(result.status).toBe('cover_url_untrusted');
    expect(result.coverEvidence).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('accepts an ended room only during the bounded grace period with matching live_time', async () => {
    const fetcher = jest.fn(async (url: string) => url.includes('get_info')
      ? { ok: true, json: async () => ({ code: 0, data: { room_id: 25788785, live_status: 0,
        live_time: '2026-09-12 20:00:00', title: '和栞栞联动', user_cover: 'https://i0.hdslb.com/cover.jpg' } }) }
      : { ok: true, buffer: async () => jpeg });
    const result = await collectCurrentRoomMetadata({}, { roomId: '25788785', startedAt: '2026-09-12T20:00:00+08:00',
      endedAt: '2026-09-12T22:00:00+08:00', now: Date.parse('2026-09-12T22:05:00+08:00'), outputDirectory: directory, fetcher });
    expect(result.status).toBe('ready');
    expect(result.bindingKind).toBe('same_live_time_within_10_minutes_after_recording');
  });

  test('captures and reuses a validated historical start snapshot after current metadata has changed', async () => {
    const snapshotConfig = { asr: { participantDiscovery: { enabled: true, visual: { enabled: true,
      snapshotDirectory: path.join(directory, 'snapshots') } } } };
    const fetcher = jest.fn(async (url: string) => url.includes('get_info')
      ? { ok: true, json: async () => ({ code: 0, data: { room_id: 25788785, live_status: 1,
        live_time: '2026-09-12 20:00:00', title: '今晚和栞栞联动', user_cover: 'https://i0.hdslb.com/cover.jpg' } }) }
      : { ok: true, buffer: async () => jpeg });
    const options = { roomId: '25788785', startedAt: '2026-09-12T20:00:00+08:00',
      now: Date.parse('2026-09-12T20:00:10+08:00'), fetcher };
    const captured = await captureParticipantRoomSnapshot(snapshotConfig, options);
    expect(captured.status).toBe('ready');
    const loaded = loadParticipantRoomSnapshot(snapshotConfig, { ...options, sessionId: 'recorded-file-session' });
    expect(loaded.status).toBe('snapshot');
    expect(loaded.coverEvidence.sessionId).toBe('recorded-file-session');
    expect(loaded.evidence[0].text).toBe('今晚和栞栞联动');
    await captureParticipantRoomSnapshot(snapshotConfig, options);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(loadParticipantRoomSnapshot(snapshotConfig, { ...options, startedAt: '2026-09-13T20:00:00+08:00' })).toBeNull();
    fs.writeFileSync(loaded.coverEvidence.path, 'corrupt cover');
    expect(loadParticipantRoomSnapshot(snapshotConfig, options)).toBeNull();
  });
});
