const asr = require('./asr_backends');
const productionConfig = require('../../../config/production.json');
const net = require('net');

describe('asr_backends', () => {
  test('uses the persistent paraformer worker when configured', async () => {
    const server = net.createServer((socket: any) => {
      let buffer = '';
      socket.on('data', (data: Buffer) => {
        buffer += data.toString();
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.split('\n', 1)[0]);
        expect(request.type).toBe('transcribe');
        expect(request.token).toBe('test-token');
        expect(request.payload.backend).toBe('paraformer');
        socket.end(JSON.stringify({
          ok: true,
          result: {
            backend: 'paraformer',
            segments: [],
            timings: { model_cache_hit: 1 }
          }
        }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const previousPort = process.env.ASR_PERSISTENT_WORKER_PORT;
    const previousToken = process.env.ASR_PERSISTENT_WORKER_TOKEN;
    process.env.ASR_PERSISTENT_WORKER_PORT = String(address.port);
    process.env.ASR_PERSISTENT_WORKER_TOKEN = 'test-token';

    try {
      const result = await asr.transcribeParaformer('smoke.wav', {
        asr: { paraformer: { model: 'paraformer-zh', process_timeout_s: 30 } }
      });
      expect(result.timings.model_cache_hit).toBe(1);
    } finally {
      if (previousPort === undefined) delete process.env.ASR_PERSISTENT_WORKER_PORT;
      else process.env.ASR_PERSISTENT_WORKER_PORT = previousPort;
      if (previousToken === undefined) delete process.env.ASR_PERSISTENT_WORKER_TOKEN;
      else process.env.ASR_PERSISTENT_WORKER_TOKEN = previousToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('keeps the global speaker reference library for an unconstrained room task', async () => {
    const server = net.createServer((socket: any) => {
      let buffer = '';
      socket.on('data', (data: Buffer) => {
        buffer += data.toString();
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.split('\n', 1)[0]);
        expect(request.payload.backend).toBe('paraformer');
        expect(request.payload.model_profile).toBe('finetuned');
        expect(request.payload.model).toBe('D:/files/videos/asr_eval/models/paraformer_timestamp_avg10');
        expect(request.payload.finetuned_model).toBe('D:/files/videos/asr_eval/models/paraformer_timestamp_avg10');
        expect(request.payload.emotion_analysis.enabled).toBe(false);
        expect(request.payload.speaker_host_label).toBe('栞栞');
        expect(request.payload.speaker_single_host_fallback).toBe(false);
        expect(request.payload.speaker_constrain_to_references).not.toBe(true);
        expect(request.payload.speaker_references.map((reference: any) => reference.speaker))
          .toEqual(expect.arrayContaining(['栞栞', '米汀']));
        socket.end(JSON.stringify({
          ok: true,
          result: {
            backend: 'paraformer',
            segments: []
          }
        }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const previousPort = process.env.ASR_PERSISTENT_WORKER_PORT;
    const previousToken = process.env.ASR_PERSISTENT_WORKER_TOKEN;
    process.env.ASR_PERSISTENT_WORKER_PORT = String((address as any).port);
    process.env.ASR_PERSISTENT_WORKER_TOKEN = 'test-token';

    const context = {
      room_id: '26966466',
      filename: '录制-26966466-20260715-000007-测试.m4a'
    };
    const resolved = asr.resolveAsrBackend(productionConfig, context);

    try {
      await asr.transcribeParaformer('smoke.wav', productionConfig, {
        routingContext: context,
        resolvedBackend: resolved
      });
    } finally {
      if (previousPort === undefined) delete process.env.ASR_PERSISTENT_WORKER_PORT;
      else process.env.ASR_PERSISTENT_WORKER_PORT = previousPort;
      if (previousToken === undefined) delete process.env.ASR_PERSISTENT_WORKER_TOKEN;
      else process.env.ASR_PERSISTENT_WORKER_TOKEN = previousToken;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  test('keeps the global speaker reference library for planned roster tasks', async () => {
    const server = net.createServer((socket: any) => {
      let buffer = '';
      socket.on('data', (data: Buffer) => {
        buffer += data.toString();
        if (!buffer.includes('\n')) return;
        const request = JSON.parse(buffer.split('\n', 1)[0]);
        expect(request.payload.backend).toBe('paraformer');
        expect(request.payload.speaker_constrain_to_references).toBe(false);
        expect(request.payload.speaker_references).toEqual([
          { speaker: '岁己SUI', audio_path: 'data/asr_speaker_refs/sui.wav' },
          { speaker: '栞栞', audio_path: 'data/asr_speaker_refs/shiori.wav' },
          { speaker: '米汀', audio_path: 'data/asr_speaker_refs/mintin.wav' }
        ]);
        expect(request.payload.speaker_host_label).toBe('岁己SUI');
        expect(request.payload.speaker_single_host_fallback).toBe(false);
        expect(request.payload.room_id).toBe('25788785');
        expect(request.payload.emotion_analysis.enabled).toBe(true);
        socket.end(JSON.stringify({ ok: true, result: { backend: 'paraformer', segments: [] } }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as any;
    const previousPort = process.env.ASR_PERSISTENT_WORKER_PORT;
    const previousToken = process.env.ASR_PERSISTENT_WORKER_TOKEN;
    process.env.ASR_PERSISTENT_WORKER_PORT = String(address.port);
    process.env.ASR_PERSISTENT_WORKER_TOKEN = 'test-token';

    try {
      await asr.transcribeParaformer('smoke.wav', {
        asr: {
          paraformer: {
            model: 'paraformer-zh',
            process_timeout_s: 30,
            emotion_analysis: {
              enabled: true,
              room_ids: ['25788785']
            },
            speaker_references: [
              { speaker: '岁己SUI', audio_path: 'data/asr_speaker_refs/sui.wav' },
              { speaker: '栞栞', audio_path: 'data/asr_speaker_refs/shiori.wav' },
              { speaker: '米汀', audio_path: 'data/asr_speaker_refs/mintin.wav' }
            ]
          }
        }
      }, {
        routingContext: {
          room_id: '25788785',
          speakerRequest: {
            mode: 'planned_roster',
            hostStreamerId: 'sui',
            plannedParticipantIds: ['shiori'],
            rosterStreamerIds: ['sui', 'shiori'],
            participants: [
              { streamerId: 'sui', displayName: '岁己SUI', speakerLabels: ['岁己SUI'] },
              { streamerId: 'shiori', displayName: '栞栞', speakerLabels: ['栞栞'] }
            ],
            constrainToRoster: true,
            constrainedSpeakerReferences: [
              { speaker: '岁己SUI', audio_path: 'data/asr_speaker_refs/sui.wav' },
              { speaker: '栞栞', audio_path: 'data/asr_speaker_refs/shiori.wav' }
            ]
          }
        }
      });
    } finally {
      if (previousPort === undefined) delete process.env.ASR_PERSISTENT_WORKER_PORT;
      else process.env.ASR_PERSISTENT_WORKER_PORT = previousPort;
      if (previousToken === undefined) delete process.env.ASR_PERSISTENT_WORKER_TOKEN;
      else process.env.ASR_PERSISTENT_WORKER_TOKEN = previousToken;
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });

  test('treats anonymous acoustic clusters as speakers for downstream summaries', () => {
    expect(asr.hasMultipleSpeakerLabels({
      segments: [
        { speaker: '栞栞' },
        { speaker: 'SPEAKER_04' },
        { speaker: 'UNKNOWN' }
      ]
    })).toBe(true);
    expect(asr.hasMultipleSpeakerLabels({
      segments: [
        { speaker: '栞栞' },
        { speaker: '栞栞' },
        { speaker: 'UNKNOWN' }
      ]
    })).toBe(false);
  });

  test('writes planned participant info into ASR speaker summary sidecar', () => {
    const tmpDir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'asr-sidecar-'));
    const srtPath = require('path').join(tmpDir, 'sample.srt');
    const result = {
      backend: 'sensevoice',
      segments: [
        { start: 0, end: 15, text: '你好', speaker: '岁己SUI', speaker_score: 0.9 },
        { start: 16, end: 32, text: '晚上好', speaker: '栞栞', speaker_score: 0.82 }
      ]
    };

    const sidecarPath = asr.writeAsrSpeakersSidecar(result, srtPath, {
      ai: {
        streamerRegistry: {
          sui: { displayName: '岁己SUI', roomIds: ['25788785'], speakerLabels: ['岁己SUI'] },
          shiori: { displayName: '栞栞', roomIds: ['26966466'], speakerLabels: ['栞栞'] }
        }
      }
    }, {
      room_id: '25788785',
      speakerRequest: {
        hostStreamerId: 'sui',
        plannedParticipantIds: ['shiori'],
        rosterStreamerIds: ['sui', 'shiori'],
        participants: [
          { streamerId: 'sui', displayName: '岁己SUI', role: 'host', planned: true },
          { streamerId: 'shiori', displayName: '栞栞', role: 'participant', planned: true }
        ],
        constrainToRoster: true
      }
    });

    const sidecar = require('fs').readFileSync(sidecarPath, 'utf8');
    const parsed = JSON.parse(sidecar);
    expect(parsed).toMatchObject({
      version: 2,
      hostStreamerId: 'sui',
      plannedParticipantIds: ['shiori'],
      rosterStreamerIds: ['sui', 'shiori'],
      constrainedToRoster: true
    });
    expect(parsed.participants).toEqual(expect.arrayContaining([
      expect.objectContaining({ streamerId: 'sui', appeared: true, role: 'host' }),
      expect.objectContaining({ streamerId: 'shiori', appeared: true, role: 'participant' })
    ]));
    require('fs').rmSync(tmpDir, { recursive: true, force: true });
  });

  test('uses default backend when no route matches', () => {
    const result = asr.resolveAsrBackend({
      asr: {
        default_backend: 'whisper',
        routing: [
          { match: { room_id: '23222837' }, backend: 'sensevoice' }
        ]
      }
    }, { room_id: '1' });

    expect(result.backend).toBe('whisper');
    expect(result.reason).toContain('default_backend');
  });

  test('matches routing by room id', () => {
    const result = asr.resolveAsrBackend({
      asr: {
        default_backend: 'whisper',
        routing: [
          { match: { room_id: '23222837' }, backend: 'sensevoice' }
        ]
      }
    }, { room_id: '23222837' });

    expect(result.backend).toBe('sensevoice');
    expect(result.reason).toContain('routing[0]');
  });

  test('cli backend override wins over routing', () => {
    const result = asr.resolveAsrBackend({
      asr: {
        default_backend: 'whisper',
        routing: [
          { match: { streamer_name: '岁己SUI' }, backend: 'sensevoice' }
        ]
      }
    }, { streamer_name: '岁己SUI' }, 'whisper');

    expect(result.backend).toBe('whisper');
    expect(result.reason).toContain('--asr-backend');
  });

  test('normalizes and splits long asr segments', () => {
    const result = asr.normalizeAsrResult({
      backend: 'sensevoice',
      segments: [
        { start: 0, end: 4, text: '大家晚上好今天我们来测试一下新的字幕后端。' }
      ]
    }, { max_chars_per_segment: 10 });

    expect(result.backend).toBe('sensevoice');
    expect(result.segments.length).toBeGreaterThan(1);
    expect(result.segments[0].start).toBe(0);
    expect(result.segments.every((segment: any) => segment.end > segment.start)).toBe(true);
  });

  test('preserves emotion metadata and room-scoped emotion analysis through normalization', () => {
    const result = asr.normalizeAsrResult({
      backend: 'paraformer',
      segments: [
        {
          start: 0,
          end: 4,
          text: '大家晚上好今天我们测试情感信息',
          emotion: 'HAPPY',
          events: ['Laughter']
        }
      ],
      emotion_analysis: {
        status: 'completed',
        emotionCounts: { HAPPY: 1 },
        timeline: [{ start: 0, end: 4, emotion: 'HAPPY', events: ['Laughter'] }]
      }
    }, { max_chars_per_segment: 8 });

    expect(result.segments.length).toBeGreaterThan(1);
    expect(result.segments.every((segment: any) => segment.emotion === 'HAPPY')).toBe(true);
    expect(result.segments.every((segment: any) => (
      JSON.stringify(segment.events) === JSON.stringify(['Laughter'])
    ))).toBe(true);
    expect(result.emotion_analysis.status).toBe('completed');

    expect(asr.resolveEmotionAnalysisOptions({
      enabled: true,
      room_ids: ['25788785']
    }, { room_id: '25788785' }).enabled).toBe(true);
    expect(asr.resolveEmotionAnalysisOptions({
      enabled: true,
      room_ids: ['25788785']
    }, { room_id: '26966466' }).enabled).toBe(false);
  });

  test('preserves speaker metadata through normalize and plain srt output stays unlabelled', () => {
    const result = asr.normalizeAsrResult({
      backend: 'sensevoice',
      segments: [
        { start: 0, end: 1.5, text: '大家晚上好', speaker: 'SPEAKER_00' },
        { start: 2, end: 3.5, text: '我这边网络很卡', speaker: 'SPEAKER_01' }
      ]
    });

    expect(result.segments.map((segment: any) => segment.speaker)).toEqual(['SPEAKER_00', 'SPEAKER_01']);

    const tmp = require('path').join(require('os').tmpdir(), `asr-speaker-${Date.now()}.srt`);
    asr.writeSrt(result, tmp, { max_chars_per_line: 30 });
    const content = require('fs').readFileSync(tmp, 'utf8');
    expect(content).toContain('大家晚上好');
    expect(content).toContain('我这边网络很卡');
    expect(content).not.toContain('[SPEAKER_00]');
    expect(content).not.toContain('[SPEAKER_01]');
    require('fs').unlinkSync(tmp);
  });

  test('writes speaker review srt with unbroken speaker prefix', () => {
    const path = require('path');
    const fs = require('fs');
    const tmp = path.join(require('os').tmpdir(), `asr-review-${Date.now()}.srt`);
    const singleTmp = path.join(require('os').tmpdir(), `asr-review-single-${Date.now()}.srt`);
    const result = {
      backend: 'sensevoice',
      segments: [
        { start: 0, end: 1, text: '大家晚上好', speaker: '岁己SUI', speaker_score: 0.72 },
        { start: 2, end: 3, text: '晚上好', speaker: '栞栞', speaker_score: 0.65 }
      ]
    };

    const reviewPath = asr.writeSpeakerReviewSrt(result, tmp, { max_chars_per_line: 12 });
    expect(reviewPath).toBe(tmp.replace(/\.srt$/, '.speaker.srt'));
    const content = fs.readFileSync(reviewPath, 'utf8');
    expect(content).toContain('[岁己SUI 0.72] 大家晚上');
    expect(content).toContain('[栞栞 0.65] 晚上好');
    expect(content).not.toContain('[岁己SUI 0.\n72]');

    const singlePath = asr.writeSpeakerReviewSrt({
      backend: 'sensevoice',
      segments: [{ start: 0, end: 1, text: '大家晚上好', speaker: '岁己SUI' }]
    }, singleTmp, { max_chars_per_line: 30 });
    expect(singlePath).toBe(singleTmp.replace(/\.srt$/, '.speaker.srt'));
    fs.unlinkSync(singlePath);

    fs.unlinkSync(reviewPath);
  });

  test('speaker review wrapping keeps Chinese content from being over-split by the prefix', () => {
    const path = require('path');
    const fs = require('fs');
    const tmp = path.join(require('os').tmpdir(), `asr-review-wrap-${Date.now()}.srt`);
    const reviewPath = asr.writeSpeakerReviewSrt({
      backend: 'sensevoice',
      segments: [
        { start: 0, end: 2, text: '好鱼 OK好的小花仙', speaker: 'SPEAKER_00' }
      ]
    }, tmp, { max_chars_per_line: 18 });

    const content = fs.readFileSync(reviewPath, 'utf8');
    expect(content).toContain('[SPEAKER_00] 好鱼 OK好的小花仙');
    expect(content).not.toContain('好鱼 OK\n好的小花\n仙');
    fs.unlinkSync(reviewPath);
  });

  test('keeps low-confidence known labels in review SRT while filtering them from image qualification', () => {
    const path = require('path');
    const fs = require('fs');
    const tmp = path.join(require('os').tmpdir(), `asr-review-low-score-${Date.now()}.srt`);
    const config = {
      ai: {
        comic: {
          multiReferenceImages: {
            enabled: true,
            minSpeakerScore: 0.64,
            minSpeechSeconds: 8
          }
        },
        streamerRegistry: {
          shiori: {
            displayName: '栞栞',
            roomIds: ['26966466'],
            speakerLabels: ['栞栞']
          }
        }
      }
    };
    const result = {
      backend: 'paraformer',
      segments: [{ start: 0, end: 12, text: '这段话属于栞栞', speaker: '栞栞', speaker_score: 0.58 }]
    };

    const reviewPath = asr.writeSpeakerReviewSrt(result, tmp, { max_chars_per_line: 30 }, config, {
      room_id: '26966466'
    });
    const content = fs.readFileSync(reviewPath, 'utf8');
    expect(content).toContain('[UNKNOWN 0.58] 这段话属于栞栞');
    expect(content).not.toContain('[栞栞 0.58]');
    expect(asr.summarizeAsrSpeakers(result, config, { room_id: '26966466' }).appearedStreamerIds)
      .toEqual([]);
    fs.unlinkSync(reviewPath);
  });

  test('merges weak anonymous clusters into a confirmed host-only room', () => {
    const config = {
      ai: {
        comic: { multiReferenceImages: { enabled: true, minSpeakerScore: 0.64 } },
        streamerRegistry: {
          shiori: {
            displayName: '栞栞',
            roomIds: ['26966466'],
            speakerLabels: ['栞栞']
          },
          mizuki: {
            displayName: '弥月Mizuki',
            speakerLabels: ['弥月Mizuki']
          }
        }
      }
    };
    const result = {
      backend: 'paraformer',
      speaker_processing: {
        referenceMatches: {
          SPEAKER_01: { label: '栞栞', accepted: true, score: 0.79 }
        }
      },
      segments: [
        { start: 0, end: 120, text: '房主', speaker: '栞栞', speaker_score: 0.79 },
        { start: 120, end: 135, text: '匿名簇', speaker: 'SPEAKER_00', speaker_score: 0.49 },
        { start: 135, end: 145, text: '未标记', speaker: 'UNKNOWN' }
      ]
    };

    const context = { room_id: '26966466', speakerSingleHostFallback: true };
    const summary = asr.summarizeAsrSpeakers(result, config, context);
    expect(summary.appearedStreamerIds).toEqual(['shiori']);
    expect(summary.speakerFallback).toMatchObject({
      applied: true,
      hostStreamerId: 'shiori',
      hostLabel: '栞栞'
    });
    expect(summary.speakerLabelOverrides).toEqual({
      SPEAKER_00: '栞栞',
      UNKNOWN: '栞栞'
    });

    const path = require('path');
    const fs = require('fs');
    const tmp = path.join(require('os').tmpdir(), `asr-review-host-fallback-${Date.now()}.srt`);
    const reviewPath = asr.writeSpeakerReviewSrt(result, tmp, { max_chars_per_line: 30 }, config, context);
    const content = fs.readFileSync(reviewPath, 'utf8');
    expect(content).not.toContain('[SPEAKER_00');
    expect(content).not.toContain('[UNKNOWN');
    expect(content).toContain('[栞栞 0.49] 匿名簇');
    fs.unlinkSync(reviewPath);
  });

  test('strips subtitle punctuation for direct video subtitles', () => {
    expect(asr.stripSubtitlePunctuation('大家晚上好！今晚，网络：很卡。')).toBe('大家晚上好今晚网络很卡');
  });

  test('resolves common and routing hotwords with alias corrections and extra hotword terms', () => {
    const result = asr.resolveAsrHotwords({
      asr: {
        common_hotwords: [
          { word: '岁己', weight: 20, aliases: ['岁几', '岁己SUI', '碎机', '碎即', '穗即', '岁机'], hotword_terms: ['小岁'] },
          { word: 'VirtuaReal', weight: 18, aliases: ['V R'] }
        ],
        corrections: {
          safe: { 微阿: 'VirtuaReal' },
          contextual: [
            { from: '随即', to: '岁己', require_nearby: ['主播'] }
          ]
        },
        routing: [
          {
            match: { streamer_name: '岁己SUI' },
            backend: 'sensevoice',
            hotwords: [
              { word: '岁己', weight: 24, aliases: ['岁己苏伊'], hotword_terms: ['饼干岁'] }
            ],
            corrections: [{ from: '岁己sui', to: '岁己' }]
          }
        ]
      }
    }, { streamer_name: '岁己SUI' });

    expect(result.hotwords.map((item: any) => item.word)).toEqual(['岁己', 'VirtuaReal']);
    expect(result.hotwordTokens.map((item: any) => item.word)).toEqual(['岁己', '岁几', '岁己SUI', '碎机', '碎即', '穗即', '岁机', '岁己苏伊', '小岁', '饼干岁', 'VirtuaReal', 'V R']);
    expect(result.hotwordWords).toEqual(['岁己', '岁几', '岁己SUI', '碎机', '碎即', '穗即', '岁机', '岁己苏伊', '小岁', '饼干岁', 'VirtuaReal', 'V R']);
    expect(result.hotwordText).toBe('岁己 岁几 岁己SUI 碎机 碎即 穗即 岁机 岁己苏伊 小岁 饼干岁 VirtuaReal V R');
    expect(result.hotwordTextWeighted).toBe('岁己 24\n岁几 24\n岁己SUI 24\n碎机 24\n碎即 24\n穗即 24\n岁机 24\n岁己苏伊 24\n小岁 24\n饼干岁 24\nVirtuaReal 18\nV R 18');
    expect(result.corrections.safe).toEqual(expect.arrayContaining([
      { from: '岁几', to: '岁己' },
      { from: '岁己SUI', to: '岁己' },
      { from: '碎机', to: '岁己' },
      { from: '碎即', to: '岁己' },
      { from: '穗即', to: '岁己' },
      { from: '岁机', to: '岁己' },
      { from: 'V R', to: 'VirtuaReal' },
      { from: '微阿', to: 'VirtuaReal' },
      { from: '岁己苏伊', to: '岁己' },
      { from: '岁己sui', to: '岁己' }
    ]));
    expect(result.corrections.safe).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '碎机', to: '岁己' }),
      expect.objectContaining({ from: 'V R', to: 'VirtuaReal' })
    ]));
    expect(result.corrections.contextual).toEqual(expect.arrayContaining([
      { from: '随即', to: '岁己', require_nearby: ['主播'] }
    ]));
    expect(result.corrections.ambiguous).toEqual([]);
  });

  test('resolves ambiguous aliases into dedicated ambiguous corrections', () => {
    const result = asr.resolveAsrHotwords({
      asr: {
        common_hotwords: [
          {
            word: '岁己',
            ambiguous_aliases: ['岁吉'],
            require_nearby: ['小岁', '前辈'],
            context_window_tokens: 2,
            match_mode: 'token',
            boundary_sensitive: true
          }
        ]
      }
    });

    expect(result.corrections.ambiguous).toEqual(expect.arrayContaining([
      {
        from: '岁吉',
        to: '岁己',
        require_nearby: ['小岁', '前辈'],
        context_window_tokens: 2,
        match_mode: 'token',
        boundary_sensitive: true
      }
    ]));
  });

  test('can keep correction aliases out of model prompt hotwords', () => {
    const result = asr.resolveAsrHotwords({
      asr: {
        common_hotwords: [
          {
            word: '岁己',
            weight: 20,
            aliases_as_hotwords: false,
            aliases: ['碎即', '岁几'],
            hotword_terms: ['岁己SUI', '小岁']
          }
        ]
      }
    });

    expect(result.hotwordTokens.map((item: any) => item.word)).toEqual(['岁己', '碎即', '岁几', '岁己SUI', '小岁']);
    expect(result.hotwordWords).toEqual(['岁己', '岁己SUI', '小岁']);
    expect(result.corrections.safe).toEqual(expect.arrayContaining([
      { from: '碎即', to: '岁己' },
      { from: '岁几', to: '岁己' }
    ]));
  });

  test('keeps sleep-related sui homophones out of safe corrections', () => {
    const result = asr.resolveAsrHotwords({
      asr: {
        common_hotwords: [
          {
            word: '岁己',
            weight: 20,
            aliases: ['碎机', '碎即'],
            contextual_aliases: ['岁几'],
            require_nearby: ['SUI', '小岁', '饼干岁', '主播', '直播', '前辈', '姐', '晚上好'],
            hotword_terms: ['岁己SUI', '小岁']
          }
        ]
      }
    });

    expect(result.hotwordWords).toEqual(['岁己', '碎机', '碎即', '岁己SUI', '小岁']);
    expect(result.corrections.safe).toEqual(expect.not.arrayContaining([
      { from: '岁几', to: '岁己' }
    ]));
    expect(result.corrections.contextual).toEqual(expect.arrayContaining([
      {
        from: '岁几',
        to: '岁己',
        require_nearby: ['SUI', '小岁', '饼干岁', '主播', '直播', '前辈', '姐', '晚上好']
      }
    ]));
    expect(asr.applyCorrectionsToText('这个可能就是多一起岁几天', result.corrections))
      .toBe('这个可能就是多一起岁几天');
    expect(asr.applyCorrectionsToText('早点岁几点睡', result.corrections)).toBe('早点岁几点睡');
    expect(asr.applyCorrectionsToText('岁几晚上好', result.corrections)).toBe('岁己晚上好');
    expect(asr.applyCorrectionsToText('岁几前辈今天来了', result.corrections)).toBe('岁己前辈今天来了');
  });

  test('applies corrections during srt output', () => {
    const result = {
      backend: 'test',
      segments: [{ start: 0, end: 1, text: '随机和V R晚上好' }]
    };
    const tmp = require('path').join(require('os').tmpdir(), `asr-corrections-${Date.now()}.srt`);
    asr.writeSrt(result, tmp, {
      max_chars_per_line: 30,
      corrections: [
        { from: '随机', to: '岁己' },
        { from: 'V R', to: 'VirtuaReal' }
      ]
    });
    const content = require('fs').readFileSync(tmp, 'utf8');
    expect(content).toContain('岁己和VirtuaReal晚上好');
    expect(content).not.toContain('随机');
    require('fs').unlinkSync(tmp);
  });

  test('routing corrections normalize 277 nickname ASR variants', () => {
    const resolved = asr.resolveAsrHotwords({
      asr: {
        default_backend: 'paraformer',
        routing: [
          {
            match: { room_id: '1713548468' },
            backend: 'paraformer',
            corrections: {
              safe: {
                '石榴': '十六',
                '十六姨': '十六',
                '克罗亚': '克罗雅'
              }
            }
          }
        ]
      }
    }, { room_id: '1713548468' });

    expect(asr.applyCorrectionsToText('石榴和克罗亚都在，十六姨也来了', resolved.corrections))
      .toBe('十六和克罗雅都在，十六也来了');
  });

  test('routing corrections normalize 1741667419 kloa and liko nickname variants', () => {
    const resolved = asr.resolveAsrHotwords({
      asr: {
        default_backend: 'paraformer',
        routing: [
          {
            match: { room_id: '1741667419' },
            backend: 'paraformer',
            corrections: {
              safe: {
                '牙小妹': '雅小妹',
                '牙小妹儿': '雅小妹',
                '兔小妹': '莉蔻',
                '兔小妹儿': '莉蔻',
                '牙牙': '雅雅',
                '雅牙': '雅雅'
              }
            }
          }
        ]
      }
    }, { room_id: '1741667419' });

    expect(asr.applyCorrectionsToText('今天牙小妹儿就是坐她今天晚上第一次坐在后排。左手摸我右手摸这个兔小妹儿。大家不是这个兔兔三。我跟我跟牙小妹是一个五五开的趋势。牙牙也没有吃那么贵的呀。', resolved.corrections))
      .toBe('今天雅小妹就是坐她今天晚上第一次坐在后排。左手摸我右手摸这个莉蔻。大家不是这个兔兔三。我跟我跟雅小妹是一个五五开的趋势。雅雅也没有吃那么贵的呀。');
  });

  test('routing corrections normalize 1986461465 kloa and liko nickname variants', () => {
    const resolved = asr.resolveAsrHotwords({
      asr: {
        default_backend: 'paraformer',
        routing: [
          {
            match: { room_id: '1986461465' },
            backend: 'paraformer',
            corrections: {
              safe: {
                '克罗亚': '克罗雅',
                '克罗娅': '克罗雅',
                '克洛雅': '克罗雅',
                '克莱雅': '克罗雅',
                '柯莱雅': '克罗雅',
                '妮蔻': '莉蔻',
                '妮口': '莉蔻',
                '妮狗': '莉蔻',
                '石榴': '十六',
                '十六营': '十六',
                '十六姨': '十六'
              }
            }
          }
        ]
      }
    }, { room_id: '1986461465' });

    expect(asr.applyCorrectionsToText('今天妮蔻妮口妮狗都在，克罗亚和石榴也来了，十六姨还在麦克风前。', resolved.corrections))
      .toBe('今天莉蔻莉蔻莉蔻都在，克罗雅和十六也来了，十六还在麦克风前。');
  });

  test('logs correction details with original matched text', () => {
    const result = {
      backend: 'test',
      segments: [{ start: 0, end: 1, text: '早点睡几点睡' }]
    };
    const tmp = require('path').join(require('os').tmpdir(), `asr-correction-log-${Date.now()}.srt`);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      asr.writeSrt(result, tmp, {
        max_chars_per_line: 30,
        corrections: [{ from: '睡几', to: '岁己' }]
      });
      const logText = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
      expect(logText).toContain('[ASR corrections] safe 睡几 -> 岁己 x1');
      expect(logText).toContain('sample="早点睡几点睡" => "早点岁己点睡"');
    } finally {
      logSpy.mockRestore();
      require('fs').unlinkSync(tmp);
    }
  });

  test('applies configured sui name and fan-name ASR correction variants', () => {
    const corrections = {
      safe: {
        c级: '岁己',
        C级: '岁己',
        'c 级': '岁己',
        'C 级': '岁己',
        'c 大叔': '岁大叔',
        'C 大叔': '岁大叔',
        饼干脆: '饼干岁',
        饼干碎: '饼干岁',
        碎戟: '岁己',
        碎几: '岁己',
        碎姐: '岁己'
      }
    };
    const resolved = asr.resolveAsrHotwords({ asr: { corrections } });

    expect(asr.applyCorrectionsToText('原来这个 c 级的天赋搁这呢', resolved.corrections))
      .toBe('原来这个 岁己的天赋搁这呢');
    expect(asr.applyCorrectionsToText('这个 c 大叔嗯嗯嗯儿娃娃哪儿啊啊炸', resolved.corrections))
      .toBe('这个 岁大叔嗯嗯嗯儿娃娃哪儿啊啊炸');
    expect(asr.applyCorrectionsToText('饼干碎和饼干脆都来了', resolved.corrections))
      .toBe('饼干岁和饼干岁都来了');
    expect(asr.applyCorrectionsToText('碎戟碎几碎姐今天都被识别错了', resolved.corrections))
      .toBe('岁己岁己岁己今天都被识别错了');
  });

  test('normalizes screenshot global replacement corrections', () => {
    const configuredCorrections = {
      safe: {
        小随: '小岁',
        吓头: '下头',
        c级: '岁己',
        拜血: '败犬',
        婚姿板: '灰泽满',
        灰色本: '灰泽满',
        饼干脆: '饼干岁',
        小碎: '小岁',
        小c: '小岁',
        小四: '小岁',
        会在卖: '灰泽满',
        会在买: '灰泽满',
        灰色板: '灰泽满',
        瑞评: '锐评',
        贵子: '柜子',
        黑家: '回家',
        会这么: '灰泽满',
        小睡: '小岁',
        小咖: '小果',
        叶子鸡: '椰子鸡',
        小凯: '小琴',
        灰精版: '灰泽满',
        芈月: '弥月'
      }
    };
    const resolved = asr.resolveAsrHotwords({ asr: { corrections: configuredCorrections } });

    expect(resolved.corrections.safe).toEqual(expect.arrayContaining([
      { from: '婚姿板', to: '灰泽满' },
      { from: '灰色本', to: '灰泽满' },
      { from: '灰精版', to: '灰泽满' },
      { from: '小咖', to: '小果' },
      { from: '叶子鸡', to: '椰子鸡' },
      { from: '芈月', to: '弥月' }
    ]));
    expect(asr.applyCorrectionsToText('婚姿板和灰色本在瑞评叶子鸡，小咖也来了，芈月启动', resolved.corrections))
      .toBe('灰泽满和灰泽满在锐评椰子鸡，小果也来了，弥月启动');
  });

  test('contextual aliases do not replace unrelated text and random stays random', () => {
    const corrections = {
      safe: [{ from: '岁几', to: '岁己' }],
      contextual: [
        { from: '随即', to: '岁己', require_nearby: ['主播', '开播', '岁己'] }
      ]
    };

    expect(asr.applyCorrectionsToText('随机匹配一个数字', corrections)).toBe('随机匹配一个数字');
    expect(asr.applyCorrectionsToText('岁几晚上好', corrections)).toBe('岁己晚上好');
    expect(asr.applyCorrectionsToText('主播随机开播了', corrections)).toBe('主播随机开播了');
    expect(asr.applyCorrectionsToText('岁己今天随机开播了', corrections)).toBe('岁己今天随机开播了');
    expect(asr.applyCorrectionsToText('主播随即开播了', corrections)).toBe('主播岁己开播了');
  });

  test('contextual corrections can fix clustered sui homophones without changing isolated grain words', () => {
    const corrections = {
      contextual: [
        { from: '穗姐', to: '岁己', require_nearby: ['小穗', '穗穗', '小岁'] },
        { from: '穗穗', to: '岁岁', require_nearby: ['穗姐', '小穗'] },
        { from: '小穗', to: '小岁', require_nearby: ['穗姐', '穗穗'] },
        { from: '岁吉', to: '岁己', require_nearby: ['小岁', '岁岁', '岁己'] },
        { from: '小碎', to: '小岁', require_nearby: ['岁己', '岁岁'] }
      ]
    };

    expect(asr.applyCorrectionsToText('穗姐跟我说能不能叫他穗穗呀还是叫他小穗', corrections))
      .toBe('岁己跟我说能不能叫他岁岁呀还是叫他小岁');
    expect(asr.applyCorrectionsToText('岁吉跟我说能不能叫他岁岁呀还是叫他小碎', corrections))
      .toBe('岁己跟我说能不能叫他岁岁呀还是叫他小岁');
    expect(asr.applyCorrectionsToText('这株小穗长得很好', corrections)).toBe('这株小穗长得很好');
    expect(asr.applyCorrectionsToText('这个小碎片很亮', corrections)).toBe('这个小碎片很亮');
  });

  test('safe corrections protect embedded terms by default and allow per-rule opt-out', () => {
    const protectedCorrections = {
      safe: [{ from: '碎机', to: '岁己' }]
    };
    const unprotectedCorrections = {
      safe: [{ from: '碎机', to: '岁己', protect: false }]
    };

    expect(asr.applyCorrectionsToText('碎机前辈今天来了', protectedCorrections)).toBe('岁己前辈今天来了');
    expect(asr.applyCorrectionsToText('这个粉碎机打得挺细的', protectedCorrections)).toBe('这个粉碎机打得挺细的');
    expect(asr.applyCorrectionsToText('这个粉碎机打得挺细的', unprotectedCorrections)).toBe('这个粉岁己打得挺细的');
  });

  test('safe alias-derived corrections inherit default protection', () => {
    const resolved = asr.resolveAsrHotwords({
      asr: {
        common_hotwords: [
          { word: '岁己', aliases: ['碎机'] }
        ]
      }
    });

    expect(resolved.corrections.safe).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '碎机', to: '岁己' })
    ]));
    expect(asr.applyCorrectionsToText('碎机前辈今天来了', resolved.corrections)).toBe('岁己前辈今天来了');
    expect(asr.applyCorrectionsToText('这个粉碎机打得挺细的', resolved.corrections)).toBe('这个粉碎机打得挺细的');
  });

  test('safe correction exclusions survive ASR segment boundaries', () => {
    const resolved = asr.resolveAsrHotwords(productionConfig, { room_id: '24872476' });
    const result = asr.applyCorrectionsToAsrResult({
      backend: 'paraformer',
      segments: [
        { start: 0, end: 1, text: '这粉' },
        { start: 1, end: 2, text: '碎机采石场点一下' }
      ]
    }, resolved.corrections);

    expect(result.segments.map((segment: any) => segment.text).join(''))
      .toBe('这粉碎机采石场点一下');
    expect(asr.applyCorrectionsToAsrResult({
      backend: 'paraformer',
      segments: [
        { start: 0, end: 1, text: '找个' },
        { start: 1, end: 2, text: '碎机' }
      ]
    }, resolved.corrections).segments.map((segment: any) => segment.text).join(''))
      .toBe('找个岁己');
  });

  test('safe ascii corrections protect embedded latin terms by default', () => {
    const corrections = {
      safe: [{ from: 'VR', to: 'VirtuaReal' }]
    };

    expect(asr.applyCorrectionsToText('VR晚上好', corrections)).toBe('VirtuaReal晚上好');
    expect(asr.applyCorrectionsToText('AVR设备今晚开机', corrections)).toBe('AVR设备今晚开机');
  });

  test('correction exclusions preserve protected words containing an alias', () => {
    const corrections = {
      safe: [
        { from: '小碎', to: '小岁' },
        { from: '小四', to: '小岁' }
      ],
      exclude_when: {
        '小碎': ['小碎步', '小碎片', '小碎石', '小碎花', '小碎块', '小碎屑', '小碎发', '小碎钻'],
        '小四': ['小四历']
      }
    };

    expect(asr.applyCorrectionsToText('小碎步、小碎片、小碎石、小碎花、小碎块、小碎屑、小碎发和小碎钻，叫小碎过来', corrections))
      .toBe('小碎步、小碎片、小碎石、小碎花、小碎块、小碎屑、小碎发和小碎钻，叫小岁过来');
    expect(asr.applyCorrectionsToText('他这个小四历确实更老一点，先别叫小四过来', corrections))
      .toBe('他这个小四历确实更老一点，先别叫小岁过来');
  });

  test('exclude_when protects any overlap with a normal word fragment', () => {
    const corrections = {
      safe: [{ from: '碎即', to: '岁己' }],
      exclude_when: {
        '碎即': ['击碎', '即将']
      }
    };

    expect(asr.applyCorrectionsToText('它会击碎目标', corrections)).toBe('它会击碎目标');
    expect(asr.applyCorrectionsToText('它会碎即将撞上这个星球', corrections)).toBe('它会碎即将撞上这个星球');
    expect(asr.applyCorrectionsToText('碎即前辈今天来了', corrections)).toBe('岁己前辈今天来了');
  });

  test('exclude_pattern applies through direct correction objects', () => {
    const corrections = {
      safe: [{ from: '碎即', to: '岁己' }],
      exclude_pattern: {
        '碎即': ['即将']
      }
    };

    expect(asr.applyCorrectionsToText('碎即将撞上这个星球，碎即前辈快看', corrections))
      .toBe('碎即将撞上这个星球，岁己前辈快看');
  });

  test('exclude_pattern only protects the overlapping occurrence', () => {
    const corrections = {
      safe: [
        {
          from: '碎几',
          to: '岁己',
          exclude_pattern: ['击碎几']
        }
      ]
    };

    expect(asr.applyCorrectionsToText('击碎几碎几前辈今天来了', corrections))
      .toBe('击碎几岁己前辈今天来了');
  });

  test('production config moves risky sui homophones into ambiguous rules', () => {
    const resolved = asr.resolveAsrHotwords(productionConfig, { room_id: '25788785' });

    expect(asr.applyCorrectionsToText('它会投掷闪耀光芒的回旋镖莱击碎即将撞上这个星球', resolved.corrections))
      .toBe('它会投掷闪耀光芒的回旋镖莱击碎即将撞上这个星球');
    expect(asr.applyCorrectionsToText('这个粉碎机打得挺细的', resolved.corrections))
      .toBe('这个粉碎机打得挺细的');
    expect(asr.applyCorrectionsToText('碎即前辈今天来了', resolved.corrections))
      .toBe('岁己前辈今天来了');
    expect(resolved.corrections.safe).toEqual(expect.not.arrayContaining([
      expect.objectContaining({ from: '粉岁己', to: '粉碎机' }),
      expect.objectContaining({ from: '粉粉岁己', to: '粉碎机' })
    ]));
    expect(resolved.corrections.safe).toEqual(expect.not.arrayContaining([
      { from: '岁吉', to: '岁己' },
      { from: '岁几', to: '岁己' },
      { from: '小碎', to: '小岁' },
      { from: '碎几', to: '岁己' }
    ]));
    expect(resolved.corrections.ambiguous).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: '岁吉', to: '岁己' }),
      expect.objectContaining({ from: '岁几', to: '岁己' }),
      expect.objectContaining({ from: '小碎', to: '小岁' }),
      expect.objectContaining({ from: '碎几', to: '岁己' })
    ]));
  });

  test('production config does not rewrite 小资 as 小岁', () => {
    const resolved = asr.resolveAsrHotwords(productionConfig, { room_id: '1967216004' });

    expect(resolved.hotwordTokens.map((item: any) => item.word)).not.toContain('小资');
    expect(resolved.corrections.safe).not.toEqual(expect.arrayContaining([
      { from: '小资', to: '小岁' }
    ]));
    expect(asr.applyCorrectionsToText('然后多听小资说话啊', resolved.corrections))
      .toBe('然后多听小资说话啊');
  });

  test('phoneme correction payload inherits exclude_when and exclude_pattern protections', () => {
    const resolved = asr.resolveAsrHotwords(productionConfig, { room_id: '24872476' });
    const payload = asr.buildPhonemeCorrectionPayload(
      productionConfig.asr.phoneme_correction,
      resolved.corrections,
      productionConfig.asr.corrections
    );

    expect(payload.boundary_protect).not.toBe(false);
    expect(payload.protect_terms).toEqual(expect.arrayContaining([
      '粉碎机',
      '小碎步',
      '小碎片',
      '击碎',
      '即将'
    ]));
    expect(payload.exclude_patterns.length).toBeGreaterThan(0);
    expect(payload.exclude_patterns.some((pattern: string) => pattern.includes('碎即'))).toBe(true);
  });

  test('ambiguous sui homophones need nearby sui context before correction', () => {
    const corrections = {
      ambiguous: [
        { from: '碎几', to: '岁己', require_nearby: ['小岁', '岁岁', 'SUI', '饼干岁', '前辈', '姐'] }
      ]
    };

    expect(asr.applyCorrectionsToText('感觉就是碎几根看看', corrections)).toBe('感觉就是碎几根看看');
    expect(asr.applyCorrectionsToText('碎几前辈今天来了', corrections)).toBe('岁己前辈今天来了');
  });

  test('ambiguous corrections only apply to nearby occurrences within the token window', () => {
    const corrections = {
      ambiguous: [
        { from: '岁吉', to: '岁己', require_nearby: ['前辈'], context_window_tokens: 2 }
      ]
    };

    expect(asr.applyCorrectionsToText('岁吉前辈来了，岁吉在远处也来了', corrections))
      .toBe('岁己前辈来了，岁吉在远处也来了');
  });

  test('ambiguous corrections can relax boundary sensitivity when explicitly disabled', () => {
    const strictCorrections = {
      ambiguous: [
        { from: '碎几', to: '岁己', require_nearby: ['前辈'], context_window_tokens: 1, boundary_sensitive: true }
      ]
    };
    const looseCorrections = {
      ambiguous: [
        { from: '碎几', to: '岁己', require_nearby: ['前辈'], context_window_tokens: 1, boundary_sensitive: false }
      ]
    };

    expect(asr.applyCorrectionsToText('阿碎几前辈今天来了', strictCorrections)).toBe('阿碎几前辈今天来了');
    expect(asr.applyCorrectionsToText('阿碎几前辈今天来了', looseCorrections)).toBe('阿岁己前辈今天来了');
  });

  test('contextual corrections can use transcript-wide context across asr segments', () => {
    const result = {
      backend: 'paraformer',
      segments: [
        { start: 0, end: 1, text: '岁吉跟我说能不能叫他岁岁呀，' },
        { start: 1, end: 2, text: '还是叫他小碎？' }
      ]
    };
    const corrected = asr.applyCorrectionsToAsrResult(result, {
      ambiguous: [
        { from: '岁吉', to: '岁己', require_nearby: ['岁岁', '小岁', '小碎'], match_mode: 'transcript', context_window_tokens: 8 },
        { from: '小碎', to: '小岁', require_nearby: ['岁吉', '岁己', '岁岁'], context_window_tokens: 8 }
      ]
    });

    expect(corrected.segments.map((segment: any) => segment.text).join(''))
      .toBe('岁己跟我说能不能叫他岁岁呀，还是叫他小岁？');
  });

  test('ambiguous corrections apply during srt output with local context checks', () => {
    const result = {
      backend: 'test',
      segments: [{ start: 0, end: 1, text: '岁吉前辈今天来了，岁吉在远处。' }]
    };
    const tmp = require('path').join(require('os').tmpdir(), `asr-ambiguous-${Date.now()}.srt`);
    asr.writeSrt(result, tmp, {
      max_chars_per_line: 30,
      corrections: {
        ambiguous: [
          { from: '岁吉', to: '岁己', require_nearby: ['前辈'], context_window_tokens: 2 }
        ]
      }
    });
    const content = require('fs').readFileSync(tmp, 'utf8');
    expect(content).toContain('岁己前辈今天来了，岁吉在远处。');
    require('fs').unlinkSync(tmp);
  });

  test('psp room routing can select sensevoice', () => {
    const result = asr.resolveAsrBackend({
      asr: {
        default_backend: 'whisper',
        routing: [
          {
            match: { room_id: '1603600' },
            backend: 'sensevoice',
            hotwords: [{ word: '星汐Seki', weight: 20 }]
          }
        ]
      }
    }, { room_id: '1603600' });

    expect(result.backend).toBe('sensevoice');
  });

  test('compare cli keeps backend list for backend-specific srt naming', () => {
    const parsed = asr.parseCliArgs(['--asr-compare', 'whisper,sensevoice', 'D:/video.flv']);

    expect(parsed.options.asrCompare).toEqual(['whisper', 'sensevoice']);
    expect(parsed.inputPaths).toEqual(['D:/video.flv']);
  });

  test('parses fun-asr-nano backend alias from cli', () => {
    const parsed = asr.parseCliArgs(['--asr-backend', 'fun-asr-nano', 'D:/video.flv']);

    expect(parsed.options.asrBackend).toBe('fun_asr_nano');
    expect(parsed.inputPaths).toEqual(['D:/video.flv']);
  });

  test('parses fun-asr-nano-vllm backend alias and merges config', () => {
    const parsed = asr.parseCliArgs(['--asr-backend', 'fun-asr-nano-vllm', 'D:/video.flv']);
    const config = asr.getAsrConfig({
      asr: {
        fun_asr_nano_vllm: {
          tensor_parallel_size: 2,
          gpu_memory_utilization: 0.72
        }
      }
    });

    expect(parsed.options.asrBackend).toBe('fun_asr_nano_vllm');
    expect(parsed.inputPaths).toEqual(['D:/video.flv']);
    expect(config.fun_asr_nano_vllm.model).toBe('FunAudioLLM/Fun-ASR-Nano-2512');
    expect(config.fun_asr_nano_vllm.spk_model).toBe('cam++');
    expect(config.fun_asr_nano_vllm.enable_speaker).toBe(true);
    expect(config.fun_asr_nano_vllm.tensor_parallel_size).toBe(2);
    expect(config.fun_asr_nano_vllm.gpu_memory_utilization).toBe(0.72);
  });

  test('parses paraformer backend alias and defaults to native vad punc speaker pipeline', () => {
    const parsed = asr.parseCliArgs(['--asr-backend', 'paraformer-zh', 'D:/video.flv']);
    const config = asr.getAsrConfig({
      asr: {
        paraformer: {
          batch_size_threshold_s: 45
        }
      }
    });

    expect(parsed.options.asrBackend).toBe('paraformer');
    expect(config.paraformer.model).toBe('paraformer-zh');
    expect(config.paraformer.vad_model).toBe('fsmn-vad');
    expect(config.paraformer.punc_model).toBe('ct-punc');
    expect(config.paraformer.spk_model).toBe('cam++');
    expect(config.paraformer.enable_speaker).toBe(true);
    expect(config.paraformer.vad_max_single_segment_time_ms).toBe(60000);
    expect(config.paraformer.batch_size_threshold_s).toBe(45);
  });

  test('resolves backend-specific python command', () => {
    const command = asr.resolvePythonCommand({
      python_executable: 'D:/venvs/asr/Scripts/python.exe',
      python_args: ['-X', 'utf8', '']
    });

    expect(command).toEqual({
      executable: 'D:/venvs/asr/Scripts/python.exe',
      args: ['-X', 'utf8']
    });
  });

  test('translates python paths for external runtimes like WSL', () => {
    const runtime = {
      python_path_map: [
        { from: 'D:/', to: '/mnt/d/' },
        { from: 'C:/Users/yuiffy', to: '/mnt/c/Users/yuiffy' }
      ]
    };

    expect(asr.translatePythonPath('D:\\workspace\\repo\\audio.wav', runtime))
      .toBe('/mnt/d/workspace/repo/audio.wav');
    expect(asr.translatePythonPayloadPaths({
      audio_path: 'D:/files/video.wav',
      speaker_references: [
        { audio_path: 'C:/Users/yuiffy/ref.wav' }
      ],
      model: 'FunAudioLLM/Fun-ASR-Nano-2512'
    }, runtime)).toEqual({
      audio_path: '/mnt/d/files/video.wav',
      speaker_references: [
        { audio_path: '/mnt/c/Users/yuiffy/ref.wav' }
      ],
      model: 'FunAudioLLM/Fun-ASR-Nano-2512'
    });
  });

  test('does not split ascii words when wrapping subtitles', () => {
    const result = {
      backend: 'test',
      segments: [{ start: 0, end: 1, text: '你要你把手机带过了我帮你连帮你连wifi' }]
    };
    const tmp = require('path').join(require('os').tmpdir(), `asr-wrap-${Date.now()}.srt`);
    asr.writeSrt(result, tmp, { max_chars_per_line: 18, strip_punctuation: true });
    const content = require('fs').readFileSync(tmp, 'utf8');
    expect(content).toContain('wifi');
    expect(content).not.toContain('wi\nfi');
    require('fs').unlinkSync(tmp);
  });

  test('streamerRegistry speakerLabels map speaker label to streamer id', () => {
    const registry = asr.resolveStreamerRegistry({
      ai: {
        streamerRegistry: {
          shiori: {
            displayName: '栞栞',
            speakerLabels: ['栞栞', 'Shiori']
          }
        }
      }
    });

    expect(asr.mapSpeakerLabelToStreamerId('Shiori', registry)).toBe('shiori');
    expect(asr.mapSpeakerLabelToStreamerId('SPEAKER_00', registry)).toBeNull();
    expect(asr.mapSpeakerLabelToStreamerId('UNKNOWN', registry)).toBeNull();
  });

  test('summarizes speakers with score, duration, host, unknown, and max extra filtering', () => {
    const config = {
      ai: {
        comic: {
          multiReferenceImages: {
            enabled: true,
            minSpeakerScore: 0.5,
            minSpeechSeconds: 8,
            maxExtraCharacters: 1
          }
        },
        streamerRegistry: {
          sui: {
            displayName: '岁己SUI',
            roomIds: ['25788785'],
            speakerLabels: ['岁己SUI']
          },
          shiori: {
            displayName: '栞栞',
            speakerLabels: ['栞栞', 'Shiori']
          },
          rhea: {
            displayName: '瑞娅',
            speakerLabels: ['瑞娅']
          }
        }
      }
    };
    const result = asr.summarizeAsrSpeakers({
      backend: 'sensevoice',
      segments: [
        { start: 0, end: 10, text: 'host', speaker: '岁己SUI', speaker_score: 0.85 },
        { start: 10, end: 20, text: 'extra', speaker: 'Shiori', speaker_score: 0.8 },
        { start: 20, end: 30, text: 'limited', speaker: '瑞娅', speaker_score: 0.9 },
        { start: 50, end: 70, text: 'unknown', speaker: 'UNKNOWN' },
        { start: 70, end: 90, text: 'cluster', speaker: 'SPEAKER_00', speaker_score: 0.9 },
        { start: 90, end: 95, text: 'noise', speaker: '-1', speaker_score: 0.9 }
      ]
    }, config, { room_id: '25788785', mediaPath: 'x.m4a' });

    expect(result.appearedStreamerIds).toEqual(['sui', 'shiori', 'rhea']);
    expect(result.extraAppearedStreamerIds).toEqual(['shiori']);
    expect(result.speakers.find((speaker: any) => speaker.label === 'UNKNOWN').isUnknown).toBe(true);
    expect(result.speakers.find((speaker: any) => speaker.label === '-1').isUnknown).toBe(true);
  });

  test('filters low max-score short extra speakers from appeared streamer ids', () => {
    const config = {
      ai: {
        comic: {
          multiReferenceImages: {
            enabled: true,
            minSpeakerScore: 0.5,
            minSpeechSeconds: 8,
            minSpeakerMaxScore: 0.7,
            minSpeakerSecondsWhenLowScore: 180
          }
        },
        streamerRegistry: {
          shiori: {
            displayName: '栞栞',
            roomIds: ['26966466'],
            speakerLabels: ['栞栞']
          },
          mizuki: {
            displayName: '弥月Mizuki',
            speakerLabels: ['弥月Mizuki']
          }
        }
      }
    };
    const result = asr.summarizeAsrSpeakers({
      backend: 'sensevoice',
      segments: [
        { start: 0, end: 120, text: 'host', speaker: '栞栞', speaker_score: 0.82 },
        { start: 120, end: 198.46, text: 'low confidence extra', speaker: '弥月Mizuki', speaker_score: 0.6439 }
      ]
    }, config, { room_id: '26966466', mediaPath: 'x.m4a' });

    expect(result.appearedStreamerIds).toEqual(['shiori']);
    expect(result.extraAppearedStreamerIds).toEqual([]);
  });

  test('summarizes speakers allowing missing score when duration passes', () => {
    const config = {
      ai: {
        comic: {
          multiReferenceImages: {
            enabled: true,
            minSpeakerScore: 0.9,
            minSpeechSeconds: 8
          }
        },
        streamerRegistry: {
          shiori: { displayName: '栞栞', speakerLabels: ['栞栞'] }
        }
      }
    };
    const result = asr.summarizeAsrSpeakers({
      backend: 'sensevoice',
      segments: [{ start: 0, end: 12, text: 'hello', speaker: '栞栞' }]
    }, config, {});

    expect(result.appearedStreamerIds).toEqual(['shiori']);
    expect(result.speakers[0].avgScore).toBeNull();
  });
});
