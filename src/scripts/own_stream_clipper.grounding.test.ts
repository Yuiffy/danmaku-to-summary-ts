jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '' }))
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const own = require('./own_stream_clipper');
const topic = require('./topic_clipper');
const asr = require('./asr/asr_backends');
const { buildSubtitleEvidence, linkClipEvidence } = require('./clipping/subtitle_evidence');

describe('final own-stream copy grounding', () => {
  test.each([0, 1, 2])('checks plan or final metadata with %i media workers', async clipConcurrency => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'person-evidence-workflow-'));
    const mediaPath = path.join(directory, 'FooterPerson.flv');
    const srtPath = path.join(directory, 'source.srt');
    const xmlPath = path.join(directory, 'source.xml');
    const planPath = path.join(directory, 'input-plan.json');
    const cut = jest.spyOn(topic, 'cutClipMedia').mockImplementation(async (_source, _window, _srt, media) => ({
      path: media, burnedSubtitles: true
    }));
    const cover = jest.spyOn(topic, 'generateClipCover').mockResolvedValue(null);
    const generate = jest.spyOn(require('./ai_text_generator'), 'generateTextWithDaiYu').mockRejectedValue(new Error('Unexpected model call'));
    try {
      fs.writeFileSync(mediaPath, 'fixture');
      fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:10,000\nGuestName left a message.\n\n'
        + '2\n00:00:20,000 --> 00:00:30,000\nAnother message was left.\n');
      fs.writeFileSync(xmlPath, '<i><d p="24,1,25,16777215,1,0,user,0">A replacement reaction.</d></i>');
      const evidence = buildSubtitleEvidence(asr.parseSrt(srtPath).segments);
      const clips = [
        { start: 0, end: 10, title: '"GuestName"', description: 'A message was left.', evidenceCueIds: ['G1'] },
        { start: 20, end: 30, title: 'Another message', description: 'GuestName left another message.', evidenceCueIds: ['G2'], evidenceDanmakuIds: ['D1'] }
      ].map(clip => ({ ...clip, duration: 10, boundaryFromEvidence: true,
        grounding: linkClipEvidence({ ...clip, sourceKind: 'recount' }, clip, evidence, [{ time: 24, text: 'Original reaction.' }]) }));
      fs.writeFileSync(planPath, JSON.stringify({ clips }));
      const config = {
        ownStreamClips: { enabled: true, minClipSeconds: 1, clipConcurrency: clipConcurrency || 1,
          clipResourceAdaptive: { enabled: false }, ai: { enabled: false }, notify: { enabled: false } },
        ai: { streamerRegistry: { guest: { displayName: 'GuestName', aiClipName: 'GuestClip' },
          sourceOnly: { displayName: 'FooterPerson' } } }
      };
      const results = await own.generateOwnStreamClips({ mediaPath, srtPath, xmlPath, planPath, config,
        streamerName: 'FooterPerson', planOnly: clipConcurrency === 0 });
      expect(results).toHaveLength(2);
      const outputRoot = path.join(directory, 'own_stream_fun_clips');
      const savedPlan = JSON.parse(fs.readFileSync(path.join(outputRoot, 'input-plan_ALIGNED.json'), 'utf8'));
      expect(savedPlan.clips[0].grounding.issues).toEqual([]);
      expect(savedPlan.clips[1].grounding.issues).toEqual(['unreferenced_person:description:GuestName', 'danmaku_source_changed:D1']);
      expect(savedPlan.clips[1].grounding.audienceChanges[0]).toMatchObject({ id: 'D1',
        original: { text: 'Original reaction.' }, current: { text: 'A replacement reaction.' } });
      expect(savedPlan.clips.map(({ start, end }) => ({ start, end }))).toEqual([{ start: 0, end: 10 }, { start: 20, end: 30 }]);
      const review = fs.readFileSync(path.join(outputRoot, 'REVIEW_input-plan.md'), 'utf8');
      expect(review).toContain('unreferenced_person:description:GuestName');
      expect(review).toContain('danmaku_source_changed:D1');
      expect(review).not.toContain('unreferenced_person:description:FooterPerson');
      if (clipConcurrency === 0) {
        expect(cut).not.toHaveBeenCalled();
        expect(spawnSync).not.toHaveBeenCalled();
      } else {
        expect(cut).toHaveBeenCalledTimes(2);
        expect(results[0].copy.title).toBe('"GuestClip"');
        expect(results[0].grounding.issues).toEqual(['unsupported_quote:title:GuestClip']);
        expect(results[0].grounding.personEvidence.checks[0].basis).toBe('cited_subtitle_mention');
        expect(results[0].grounding.personEvidence.checks.map(check => check.person.id)).toEqual(['guest']);
        expect(results[0].copy.description).toContain('FooterPerson');
        expect(results[1].grounding.issues).toEqual(['unreferenced_person:description:GuestName', 'danmaku_source_changed:D1']);
        expect(results[1].grounding.audienceChanges).toEqual(savedPlan.clips[1].grounding.audienceChanges);
        const savedMetadata = JSON.parse(fs.readFileSync(results[0].output.metadataPath, 'utf8'));
        expect(savedMetadata.grounding).toEqual(results[0].grounding);
        expect(review).toContain('unsupported_quote:title:GuestClip');
        expect(spawnSync).toHaveBeenCalledTimes(1);
        expect(spawnSync.mock.calls[0][1][1]).toBe('import-json');
      }
      expect(generate).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
      spawnSync.mockClear();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
