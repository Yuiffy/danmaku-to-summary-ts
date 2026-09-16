const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('xml2js', () => ({
  Parser: jest.fn().mockImplementation(() => ({
    parseStringPromise: jest.fn().mockResolvedValue({ I: { D: [] } })
  }))
}));

const fusion = require('./do_fusion_summary');

describe('do_fusion_summary speaker sidecar support', () => {
  test('keeps different voices in separate blocks and respects a local rejected identity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-speaker-evidence-'));
    try {
      const srt = path.join(dir, 'sample.srt'); const xml = path.join(dir, 'sample.xml');
      const text = '1\n00:00:00,000 --> 00:00:04,000\n[Host 0.99] 我打算明天继续\n\n2\n00:00:04,000 --> 00:00:08,000\n我明天要去医院\n';
      fs.writeFileSync(srt, text); fs.writeFileSync(xml, '<i></i>');
      const parsed = require('./asr/asr_backends').parseSrt(srt);
      require('./asr/evidence_sidecar').writeAsrEvidence(srt, text, parsed.segments.map((row: any, index: number) => ({
        ...row, asr: { recognizedText: row.text }, speaker: { version: 1, observations: [],
          status: index ? 'row_supported' : 'mixed', label: index ? 'Guest' : null }
      })), 'paraformer');
      await fusion.processLiveData([srt, xml]);
      const highlight = fs.readFileSync(path.join(dir, 'sample_AI_HIGHLIGHT.txt'), 'utf8');
      expect(highlight).toContain('[UNKNOWN] 我打算明天继续');
      expect(highlight).toContain('[Guest] 我明天要去医院');
      expect(highlight).not.toContain('[Host');
      const speechLines = highlight.split('\n').filter((line: string) => /\[(?:UNKNOWN|Guest)\]/u.test(line));
      expect(speechLines).toHaveLength(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('includes participant summary when speaker sidecar exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-summary-'));
    const srtPath = path.join(dir, 'sample.speaker.srt');
    const xmlPath = path.join(dir, 'sample.xml');
    const highlightPath = path.join(dir, 'sample.speaker_AI_HIGHLIGHT.txt');
    const sidecarPath = path.join(dir, 'sample.asr_speakers.json');

    fs.writeFileSync(srtPath, [
      '1',
      '00:00:00,000 --> 00:00:03,000',
      '[SPEAKER_04 0.57] 大家好我是露露，明天继续',
      ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(xmlPath, '<i></i>', 'utf8');
    fs.writeFileSync(sidecarPath, JSON.stringify({
      participants: [
        { streamerId: 'sui', displayName: '岁己SUI', planned: true, appeared: true },
        { streamerId: 'shiori', displayName: '栞栞', planned: true, appeared: false }
      ]
    }, null, 2), 'utf8');

    await fusion.processLiveData([srtPath, xmlPath]);

    const content = fs.readFileSync(highlightPath, 'utf8');
    expect(content).toContain('【参与者】计划参与: 岁己SUI、栞栞');
    expect(content).toContain('【参与者】实际出声: 岁己SUI');
    expect(content).toContain('[SPEAKER_04 0.57] 大家好我是露露');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('do_fusion_summary emotion metadata', () => {
  const analysis = {
    status: 'completed',
    emotionCounts: { HAPPY: 3, SURPRISE: 1 },
    eventCounts: { Speech: 4, Laughter: 2 },
    timeline: [
      { start: 10, end: 20, emotion: 'HAPPY', events: ['Speech'], text: '普通聊天' },
      { start: 45, end: 55, emotion: 'SURPRISE', events: ['Laughter'], text: '怎么突然这样' }
    ]
  };

  test('builds compact overall summary and notable moments for shared goodnight input', () => {
    const summary = fusion.buildEmotionSummaryLines(analysis).join('\n');
    const moments = fusion.buildStrongEmotionMomentLines(analysis).join('\n');

    expect(summary).toContain('情感概览');
    expect(summary).toContain('开心3段');
    expect(summary).toContain('笑声2次');
    expect(summary).not.toContain('说话4次');
    expect(moments).toContain('显著情感时刻');
    expect(moments).toContain('怎么突然这样');
  });

  test('maps timeline overlap to an annotation while hiding noisy Speech/BGM events', () => {
    const evidence = fusion.getEmotionEvidenceForInterval(analysis, 44, 58);
    expect(evidence).toMatchObject({ emotion: 'SURPRISE', events: ['Laughter'] });
    expect(fusion.formatEmotionEvidence(evidence)).toContain('情感: 惊讶');
    expect(fusion.formatEmotionEvidence({
      emotion: 'HAPPY',
      events: ['Speech', 'BGM']
    })).toBe('  [情感: 开心]');
  });
});
