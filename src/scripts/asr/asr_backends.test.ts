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
});
