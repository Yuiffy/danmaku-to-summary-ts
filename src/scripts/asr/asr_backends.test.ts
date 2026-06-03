const asr = require('./asr_backends');

describe('asr_backends', () => {
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
    expect(result.corrections.contextual).toEqual(expect.arrayContaining([
      { from: '随即', to: '岁己', require_nearby: ['主播'] }
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

  test('ambiguous sui homophones need nearby sui context before correction', () => {
    const corrections = {
      contextual: [
        { from: '碎几', to: '岁己', require_nearby: ['小岁', '岁岁', 'SUI', '饼干岁', '前辈', '姐'] }
      ]
    };

    expect(asr.applyCorrectionsToText('感觉就是碎几根看看', corrections)).toBe('感觉就是碎几根看看');
    expect(asr.applyCorrectionsToText('碎几前辈今天来了', corrections)).toBe('岁己前辈今天来了');
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
      contextual: [
        { from: '岁吉', to: '岁己', require_nearby: ['岁岁', '小岁', '岁己'] },
        { from: '小碎', to: '小岁', require_nearby: ['岁己', '岁岁'] }
      ]
    });

    expect(corrected.segments.map((segment: any) => segment.text).join(''))
      .toBe('岁己跟我说能不能叫他岁岁呀，还是叫他小岁？');
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
        { start: 0, end: 10, text: 'host', speaker: '岁己SUI', speaker_score: 0.7 },
        { start: 10, end: 20, text: 'extra', speaker: 'Shiori', speaker_score: 0.8 },
        { start: 20, end: 30, text: 'limited', speaker: '瑞娅', speaker_score: 0.9 },
        { start: 50, end: 70, text: 'unknown', speaker: 'UNKNOWN' },
        { start: 70, end: 90, text: 'cluster', speaker: 'SPEAKER_00', speaker_score: 0.9 }
      ]
    }, config, { room_id: '25788785', mediaPath: 'x.m4a' });

    expect(result.appearedStreamerIds).toEqual(['sui', 'shiori', 'rhea']);
    expect(result.extraAppearedStreamerIds).toEqual(['shiori']);
    expect(result.speakers.find((speaker: any) => speaker.label === 'UNKNOWN').isUnknown).toBe(true);
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
