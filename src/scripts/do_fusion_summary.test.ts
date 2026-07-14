const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('xml2js', () => ({
  Parser: jest.fn().mockImplementation(() => ({
    parseStringPromise: jest.fn().mockResolvedValue({ I: { D: [] } })
  }))
}));

const { processLiveData } = require('./do_fusion_summary');

describe('do_fusion_summary speaker sidecar support', () => {
  test('includes participant summary when speaker sidecar exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-summary-'));
    const srtPath = path.join(dir, 'sample.speaker.srt');
    const xmlPath = path.join(dir, 'sample.xml');
    const highlightPath = path.join(dir, 'sample.speaker_AI_HIGHLIGHT.txt');
    const sidecarPath = path.join(dir, 'sample.asr_speakers.json');

    fs.writeFileSync(srtPath, [
      '1',
      '00:00:00,000 --> 00:00:03,000',
      '[岁己SUI 0.90] 今天晚上好',
      ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(xmlPath, '<i></i>', 'utf8');
    fs.writeFileSync(sidecarPath, JSON.stringify({
      participants: [
        { streamerId: 'sui', displayName: '岁己SUI', planned: true, appeared: true },
        { streamerId: 'shiori', displayName: '栞栞', planned: true, appeared: false }
      ]
    }, null, 2), 'utf8');

    await processLiveData([srtPath, xmlPath]);

    const content = fs.readFileSync(highlightPath, 'utf8');
    expect(content).toContain('【参与者】计划参与: 岁己SUI、栞栞');
    expect(content).toContain('【参与者】实际出声: 岁己SUI');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
