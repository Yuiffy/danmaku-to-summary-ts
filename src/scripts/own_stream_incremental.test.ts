export {};
const fs = require('fs'), os = require('os'), path = require('path');
const own = require('./own_stream_clipper'), topic = require('./topic_clipper'), asr = require('./asr/asr_backends');
test.each([false, true])('real orchestration renders while another actor request is pending (creative=%s)', async creative => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-stream-incremental-'));
    let finishSlow, sawRender;
    const slow = new Promise(resolve => { finishSlow = resolve; });
    const firstRender = new Promise(resolve => { sawRender = resolve; });
    const mediaPath = path.join(dir, 'source.flv'), srtPath = path.join(dir, 'source.srt'), planPath = path.join(dir, 'input.json');
    const cut = jest.spyOn(topic, 'cutClipMedia').mockImplementation(async (_source, window, _srt, target) => {
        fs.writeFileSync(target, 'rendered fixture'); sawRender(window.index); return { path: target, burnedSubtitles: true };
    });
    const cover = jest.spyOn(topic, 'generateClipCover').mockImplementation(async (media, _title, output) => {
        const file = path.join(output, path.basename(media) + '.jpg'); fs.writeFileSync(file, Buffer.from([255, 216, 255, 217])); return file;
    });
    const generated = jest.spyOn(require('./ai_text_generator'), 'generateTextWithDaiYu').mockImplementation(async prompt => {
        if (prompt.includes('for 精切实验模式.')) return { text: '{"selected":[]}', meta: { usage: { input_tokens: 10, output_tokens: 5 },
            attempts: [{ provider: 'daiYu', model: 'fixture', apiModeUsed: 'responses', reasoningEffortSent: 'high' }] } };
        const packets = prompt.split('\n').filter(line => line.startsWith('{"clipId":')).map(line => JSON.parse(line));
        if (packets.some(packet => packet.clipId === 'c5')) await slow;
        return { text: JSON.stringify({ reviews: packets.map(packet => ({ clipId: packet.clipId, decision: 'accept', copy: packet.copy,
            claims: [{ fields: ['title', 'coverText', 'description'], action: 'recalled a complete story', narrator: 'Host', actor: 'Host', target: null,
                sourceKind: 'playback', identityBasis: 'voice', speakerCueIds: [packet.inRangeCueIds[0]], cueIds: [packet.inRangeCueIds[0]] }],
            evidenceDanmakuIds: [], reason: 'source checked' })) }), meta: { model: 'fixture', attempts: [] } };
    });
    let work, deadline;
    try {
        fs.writeFileSync(mediaPath, 'source');
        asr.writeSrt({ backend: 'fixture', segments: Array.from({ length: 8 }, (_, i) => ({ start: i * 100, end: i * 100 + 30,
            text: 'Host recalled a complete story.', speakerEvidence: { version: 1, status: 'row_supported', label: 'Host',
                observations: [{ start: i * 100, end: i * 100 + 30, label: 'Host', scope: 'row', row: { accepted: true, score: .8, margin: .2 } }] } })) }, srtPath, { write_evidence: true });
        fs.writeFileSync(planPath, JSON.stringify({ clips: Array.from({ length: 8 }, (_, i) => ({ start: i * 100, end: i * 100 + 30,
            title: 'Host recalled a complete story', description: 'Host recalled a complete story.', coverText: 'Complete\nStory',
            boundaryFromEvidence: true, grounding: { sourceKind: 'playback' } })) }));
        const config = { ai: { text: { enabled: true, provider: 'daiYu' }, streamerRegistry: { host: { displayName: 'Host', aiClipName: 'Host', roomIds: ['room'] } } },
            ownStreamClips: { enabled: true, minClipSeconds: 1, notify: { enabled: false }, streamReviewRendering: true,
                clipConcurrency: 1, clipResourceAdaptive: { enabled: false }, enhancements: { enabled: creative, workflow: 'creative', roomIds: ['room'],
                    experiment: { enabled: true, ratio: 1, maxClips: 1 }, budget: { mode: 'log_only', ledgerPath: path.join(dir, 'ledger.json') },
                    stageDefaults: { provider: 'daiYu', model: 'fixture', apiMode: 'responses', reasoningEffort: 'high', maxTokens: 1000,
                        maxInputTokens: 50000, timeoutMs: 1000, capabilities: { reasoningEfforts: ['high'], images: false } } },
                attribution: { enabled: true, roomIds: ['room'], batchSize: 4, concurrency: 2, maxRequests: 2, repairAttempts: 0 }, ai: { enabled: true, model: 'fixture' } } };
        work = own.generateOwnStreamClips({ config, mediaPath, srtPath, planPath, context: { roomId: 'room' }, registerUpload: false });
        const observed = await Promise.race([firstRender, new Promise(resolve => { deadline = setTimeout(() => resolve(null), 1500); })]);
        expect(observed).not.toBeNull();
        expect(observed).toBeLessThanOrEqual(4);
        const progress = JSON.parse(fs.readFileSync(path.join(dir, 'own_stream_fun_clips/input_PROGRESS.json'), 'utf8'));
        expect(progress.entries.slice(4).every(row => row.status === 'awaiting_review')).toBe(true);
        finishSlow();
        const result = await work;
        expect(result.map(row => row.window.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(result.every(row => row.attributionReview.status === 'passed')).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'own_stream_fun_clips/input_ALIGNED.json'), 'utf8')).status).toBe('complete');
    } finally { clearTimeout(deadline); finishSlow(); await work; cut.mockRestore(); cover.mockRestore(); generated.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
});
