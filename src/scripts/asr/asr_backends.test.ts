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

  test('resolves common and routing hotwords with alias corrections', () => {
    const result = asr.resolveAsrHotwords({
      asr: {
        common_hotwords: [
          { word: '岁己', weight: 20, aliases: ['岁几'], contextual_aliases: ['随机'] },
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
              { word: '岁己SUI', weight: 20, aliases: ['岁己苏伊'] }
            ],
            corrections: [{ from: '岁己sui', to: '岁己SUI' }]
          }
        ]
      }
    }, { streamer_name: '岁己SUI' });

    expect(result.hotwords.map((item: any) => item.word)).toEqual(['岁己', 'VirtuaReal', '岁己SUI']);
    expect(result.hotwordText).toBe('岁己 VirtuaReal 岁己SUI');
    expect(result.hotwordTextWeighted).toBe('岁己 20\nVirtuaReal 18\n岁己SUI 20');
    expect(result.corrections.safe).toEqual(expect.arrayContaining([
      { from: '岁几', to: '岁己' },
      { from: 'V R', to: 'VirtuaReal' },
      { from: '微阿', to: 'VirtuaReal' },
      { from: '岁己苏伊', to: '岁己SUI' },
      { from: '岁己sui', to: '岁己SUI' }
    ]));
    expect(result.corrections.contextual).toEqual(expect.arrayContaining([
      { from: '随机', to: '岁己', require_nearby: expect.arrayContaining(['主播', '直播', '开播']) },
      { from: '随即', to: '岁己', require_nearby: ['主播'] }
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

  test('contextual aliases do not replace unrelated text', () => {
    const corrections = {
      safe: [{ from: '岁几', to: '岁己' }],
      contextual: [
        { from: '随机', to: '岁己', require_nearby: ['主播', '开播', '岁己'] }
      ]
    };

    expect(asr.applyCorrectionsToText('随机匹配一个数字', corrections)).toBe('随机匹配一个数字');
    expect(asr.applyCorrectionsToText('岁几晚上好', corrections)).toBe('岁己晚上好');
    expect(asr.applyCorrectionsToText('主播随机开播了', corrections)).toBe('主播岁己开播了');
    expect(asr.applyCorrectionsToText('岁己今天随机开播了', corrections)).toBe('岁己今天岁己开播了');
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
