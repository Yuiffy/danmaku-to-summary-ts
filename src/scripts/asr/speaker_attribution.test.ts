const { buildFullContextSource } = require('../full_live_context');
const { buildSubtitleEvidence } = require('../clipping/subtitle_evidence');

describe('speaker evidence survives downstream input preparation', () => {
  const parsed = { segments: [
    { start: 0, end: 4, text: '[Host 0.99] This came from another voice.',
      speakerEvidence: { version: 1, status: 'mixed', label: 'Host', observations: [] } },
    { start: 4, end: 9, text: 'I have a different story.',
      speakerEvidence: { version: 1, status: 'row_supported', label: 'Guest', observations: [] } },
    { start: 9, end: 12, text: '[SPEAKER_02 0.72] Who said that?' }
  ] };
  it.each([false, true])('retains unknown, named guest and anonymous cluster with compact=%s', compactEvidence => {
    const source = buildFullContextSource(parsed, [], { compactEvidence });
    expect(source.sourceText).toContain('[UNKNOWN] This came from another voice.');
    expect(source.sourceText).toContain('[Guest] I have a different story.');
    expect(source.sourceText).toContain('[SPEAKER_02] Who said that?');
    expect(source.sourceText).not.toContain('[Host');
    if (compactEvidence) expect(source.evidence.speech[0].speakerEvidence.status).toBe('unknown');
  });
  it('does not merge adjacent different speakers or restore a rejected legacy label', () => {
    const grouped = buildSubtitleEvidence(parsed.segments);
    expect(grouped.cues.map((cue: any) => cue.speaker)).toEqual(['UNKNOWN', 'Guest', 'SPEAKER_02']);
  });
});
