import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { currentSpeakerProcessing, decideSpeakerProcessing } from './speaker_load_policy';
import { ConfigValidator } from '../../core/config/ConfigValidator';

const { buildRuntimeSpeakerOverrides } = require('./speaker_runtime');
const asr = require('./asr_backends');

describe('optional speaker admission', () => {
  let directory: string;
  let original: NodeJS.ProcessEnv;
  const now = 2_000_000;
  beforeEach(() => {
    original = { ...process.env };
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speaker-load-'));
    process.env.WHISPER_QUEUE_FILE = path.join(directory, 'queue.json');
    delete process.env.ASR_CPU_FALLBACK;
  });
  afterEach(() => {
    process.env = original;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const auto = { asr: { speaker_processing: { mode: 'auto' } } };
  function queue(tasks: unknown[]) {
    fs.writeFileSync(process.env.WHISPER_QUEUE_FILE!, JSON.stringify({ tasks }));
  }

  test.each([
    [{}, 'capacity_available', true],
    [{ cpuBusy: true }, 'resource_busy', false],
    [{ gpuBusy: true }, 'resource_busy', false],
    [{ pendingJobs: 3 }, 'queue_backlog', false],
    [{ oldestWaitSeconds: 900 }, 'queue_wait', false],
    [{ pendingJobs: 2, oldestWaitSeconds: 899 }, 'capacity_available', true]
  ])('auto decision for %j', (load, reason, enabled) => {
    expect(decideSpeakerProcessing({ mode: 'auto' }, load)).toMatchObject({ reason, enabled });
  });

  test('manual modes and missing policy preserve explicit/legacy behavior', () => {
    expect(decideSpeakerProcessing({}, { cpuBusy: true })).toMatchObject({ enabled: true, reason: 'manual_on' });
    expect(decideSpeakerProcessing({ mode: 'off' })).toMatchObject({ enabled: false, reason: 'manual_off' });
    expect(decideSpeakerProcessing({ mode: 'on' }, { pendingJobs: 10 })).toMatchObject({ enabled: true });
  });

  test.each([{ mode: 'bad' }, { mode: 'auto', max_pending_jobs: 0 },
    { mode: 'auto', max_pending_jobs: 1.5 }, { mode: 'auto', max_wait_s: Infinity }])
  ('rejects invalid policy %j at runtime and config boundary', policy => {
    expect(() => decideSpeakerProcessing(policy)).toThrow();
    expect(ConfigValidator.validate({ asr: { speaker_processing: policy } }).errors)
      .toEqual(expect.arrayContaining([expect.objectContaining({ path: 'asr.speaker_processing' })]));
  });

  test('counts only other pending jobs, computes age, and never changes queue', () => {
    const input = path.join(directory, 'current.wav');
    queue([{ status: 'pending', mediaPath: input.toUpperCase(), addedTime: 1 },
      { status: 'processing', mediaPath: 'active.wav', addedTime: 1 },
      { status: 'failed', mediaPath: 'failed.wav', addedTime: 1 },
      { status: 'pending', mediaPath: 'other.wav', addedTime: now - 900_000 }]);
    const before = fs.readFileSync(process.env.WHISPER_QUEUE_FILE!);
    expect(currentSpeakerProcessing(auto, { input }, now)).toMatchObject({
      enabled: false, reason: 'queue_wait', pendingJobs: 1, oldestWaitSeconds: 900, queueKnown: true
    });
    expect(fs.readFileSync(process.env.WHISPER_QUEUE_FILE!)).toEqual(before);
    queue([]);
    expect(currentSpeakerProcessing(auto, { input }, now)).toMatchObject({ enabled: true });
  });

  test('missing or corrupt queue is unknown; CPU admission still skips', () => {
    expect(currentSpeakerProcessing(auto)).toMatchObject({ enabled: true, queueKnown: false });
    fs.writeFileSync(process.env.WHISPER_QUEUE_FILE!, 'broken');
    process.env.ASR_CPU_FALLBACK = '1';
    expect(currentSpeakerProcessing(auto)).toMatchObject({ enabled: false, reason: 'resource_busy', queueKnown: false });
  });

  test('load gate overrides collaboration forcing before registry/reference work', () => {
    queue(Array.from({ length: 3 }, (_, i) => ({ status: 'pending', mediaPath: `other${i}.wav` })));
    const helpers = { getSpeakerRequest: jest.fn(), resolveStreamerRegistry: jest.fn(), findHostStreamerId: jest.fn() };
    const override = buildRuntimeSpeakerOverrides(auto, { speakerRequest: {
      mode: 'once', participantDiscovery: { mode: 'multi', modeStatus: 'confirmed' }
    } }, helpers);
    expect(override).toMatchObject({ enable_speaker: false, spk_model: null, speaker_references: [],
      speaker_processing_policy: { reason: 'queue_backlog' } });
    expect(helpers.getSpeakerRequest).not.toHaveBeenCalled();
  });

  test('automatic MOSS rollout is suppressed under load and resumes when clear', () => {
    const config = { asr: { ...auto.asr, default_backend: 'paraformer',
      moss_rollout: { enabled: true, ratio: 1 } } };
    const context = { roomId: '1', filename: 'recording.flv' };
    queue(Array.from({ length: 3 }, (_, i) => ({ status: 'pending', mediaPath: `other${i}.wav` })));
    expect(asr.resolveAsrBackend(config, context).backend).toBe('paraformer');
    queue([]);
    expect(asr.resolveAsrBackend(config, context).backend).toBe('moss');
  });

  test('actual child payload disables speaker while preserving text model and settings', async () => {
    const adapter = path.join(directory, 'capture.cjs');
    fs.writeFileSync(adapter, `let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>console.log(input));`);
    queue(Array.from({ length: 3 }, (_, i) => ({ status: 'pending', mediaPath: `other${i}.wav` })));
    const result = await asr.transcribeParaformer('fixture.wav', { asr: { ...auto.asr, paraformer: {
      python_executable: process.execPath, python_args: [adapter], model: 'paraformer-zh',
      enable_speaker: true, spk_model: 'cam++', speaker_references: [{ speaker: 'host', audio: 'host.wav' }]
    } } }, { routingContext: { speakerRequest: {
      participantDiscovery: { mode: 'multi', modeStatus: 'confirmed' }
    } } });
    expect(result).toMatchObject({ model: 'paraformer-zh', enable_speaker: false, spk_model: null,
      speaker_references: [], speaker_processing_policy: { enabled: false, reason: 'queue_backlog' } });
  });
});
