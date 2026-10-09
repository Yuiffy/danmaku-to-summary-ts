export {};
const fs = require('fs'), os = require('os'), path = require('path');
const own = require('./own_stream_clipper'), topic = require('./topic_clipper');
const { buildSubtitleEvidence } = require('./clipping/subtitle_evidence');

test.each([false, true])('publication gate runs before media jobs, preserves deferred plans and obeys rollback (streaming=%s)', async streaming => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-publication-'));
    const mediaPath = path.join(dir, 'source.flv'), srtPath = path.join(dir, 'source.srt'), planPath = path.join(dir, 'input.json');
    const cut = jest.spyOn(topic, 'cutClipMedia').mockImplementation(async (_source, _window, _srt, output) => {
        fs.writeFileSync(output, 'fixture'); return { path: output, burnedSubtitles: true };
    });
    const cover = jest.spyOn(topic, 'generateClipCover').mockImplementation(async (media) => {
        fs.writeFileSync(media + '.jpg', 'fixture'); return media + '.jpg';
    });
    try {
        fs.writeFileSync(mediaPath, 'fixture');
        fs.writeFileSync(srtPath, '1\n00:00:00,000 --> 00:00:03,000\nThis is a complete story.\n\n2\n00:00:10,000 --> 00:00:13,000\nA second complete story.\n\n3\n00:00:20,000 --> 00:00:23,000\nThe third complete story.\n');
        const parsed = require('./asr/asr_backends').parseSrt(srtPath);
        const evidence = buildSubtitleEvidence(parsed.segments);
        const clips = evidence.cues.map((cue, index) => ({ start: cue.start, end: cue.end, duration: cue.end - cue.start,
            title: cue.text, description: cue.text, coverText: cue.text, score: [75, 94, 84][index], candidateIndex: index + 1,
            selectionSource: 'model_global_rerank', boundaryFromEvidence: true, startCueId: cue.id, endCueId: cue.id,
            grounding: { status: 'linked', sourceKind: 'live_speech', sourceSha256: evidence.sourceSha256,
                subtitleIds: [cue.id], subtitles: [cue], danmakuIds: [], audience: [], issues: [] } }));
        fs.writeFileSync(planPath, JSON.stringify({ clips }));
        const config = { ownStreamClips: { enabled: true, notify: { enabled: false }, minClipSeconds: 1,
            streamReviewRendering: streaming, clipResourceAdaptive: { enabled: false },
            publicationPolicy: { mode: 'curated', maxStandalone: 1 } } };
        const opts = { config, mediaPath, srtPath, planPath, registerUpload: false, context: { roomId: '25788785' } };
        const result = await own.generateOwnStreamClips(opts);
        expect(cut).toHaveBeenCalledTimes(1);
        expect(result.map(row => row.recommendationScore)).toEqual([94]);
        expect(result[0].publication).toMatchObject({ index: 2, protected: true });
        const plan = JSON.parse(fs.readFileSync(path.join(dir, 'own_stream_fun_clips/input_ALIGNED.json'), 'utf8'));
        expect(plan.clips).toHaveLength(1); expect(plan.publication.deferred).toHaveLength(2);
        expect(fs.readFileSync(plan.publication.reviewPath, 'utf8')).toContain('3 条候选 → 1 条优先独立');
        const manifestPath = path.join(dir, 'manifest.json');
        own.writeOwnUploadManifest(manifestPath, path.join(dir, 'review.md'), result, { roomId: '25788785' });
        expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).clips).toHaveLength(1);
        cut.mockClear();
        const restored = await own.generateOwnStreamClips({ ...opts, publicationMode: 'all',
            config: { ownStreamClips: { ...config.ownStreamClips, outputDirName: 'rollback' } } });
        expect(cut).toHaveBeenCalledTimes(3); expect(restored).toHaveLength(3);
        cut.mockClear();
        const empty = await own.generateOwnStreamClips({ ...opts,
            config: { ownStreamClips: { ...config.ownStreamClips, outputDirName: 'empty',
                publicationPolicy: { mode: 'curated', minScore: 100, standoutScore: 100 } } } });
        expect(empty).toEqual([]); expect(cut).not.toHaveBeenCalled();
        const emptyPlan = JSON.parse(fs.readFileSync(path.join(dir, 'empty/input_ALIGNED.json'), 'utf8'));
        expect(emptyPlan.publication.deferred).toHaveLength(3);
    } finally { cut.mockRestore(); cover.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
});
