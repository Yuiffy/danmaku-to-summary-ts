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

  test('preserves speaker labels through normalize and srt output', () => {
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
    expect(content).toContain('[SPEAKER_00] 大家晚上好');
    expect(content).toContain('[SPEAKER_01] 我这边网络很卡');
    require('fs').unlinkSync(tmp);
  });

  test('strips subtitle punctuation for direct video subtitles', () => {
    expect(asr.stripSubtitlePunctuation('大家晚上好！今晚，网络：很卡。')).toBe('大家晚上好今晚网络很卡');
  });

  test('resolves common and routing hotwords with alias corrections', () => {
    const result = asr.resolveAsrHotwords({
      asr: {
        common_hotwords: [
          { word: '岁己', weight: 20, aliases: ['岁几', '随机'] },
          { word: 'VirtuaReal', weight: 18, aliases: ['V R'] }
        ],
        corrections: { 微阿: 'VirtuaReal' },
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
    expect(result.corrections).toEqual(expect.arrayContaining([
      { from: '岁几', to: '岁己' },
      { from: '随机', to: '岁己' },
      { from: 'V R', to: 'VirtuaReal' },
      { from: '微阿', to: 'VirtuaReal' },
      { from: '岁己苏伊', to: '岁己SUI' },
      { from: '岁己sui', to: '岁己SUI' }
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
});
