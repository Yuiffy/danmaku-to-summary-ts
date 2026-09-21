export {};
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'),
    spawnSync: jest.fn(() => ({ status: 0, stdout: '', stderr: '' })),
    execFile: jest.fn((_file, _args, _options, callback) => callback(null, JSON.stringify({
        format: { duration: 60 }, streams: [{ codec_type: 'video', width: 640, height: 360, start_time: 0 },
            { codec_type: 'audio', start_time: 0 }] }))) }));
const fs = require('fs');
const path = require('path');
const os = require('os');
const own = require('./own_stream_clipper');
const topic = require('./topic_clipper');
const asr = require('./asr/asr_backends');

test.each([
    { accepts: true, workflow: 'legacy_packaging' }, { accepts: false, workflow: 'legacy_packaging' },
    { accepts: true, workflow: 'creative' }, { accepts: false, workflow: 'creative' }
])('attribution-reviewed batch reaches precision finalization ($workflow, accepts=$accepts)', async ({ accepts, workflow }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'precision-pipeline-'));
    const jpeg = await require('sharp')({ create: { width: 320, height: 180, channels: 3, background: '#354757' } }).jpeg().toBuffer();
    const mediaPath = path.join(directory, 'source.flv'), srtPath = path.join(directory, 'source.srt'), planPath = path.join(directory, 'input.json');
    const cut = jest.spyOn(topic, 'cutClipMedia').mockImplementation(async (_source, _window, _srt, file, options) => {
        fs.writeFileSync(file, 'rendered fixture'); return { path: file, burnedSubtitles: true, creativeEffectsApplied: options?.creativePlan?.effects.length };
    });
    const cover = jest.spyOn(topic, 'generateClipCover').mockImplementation(async (media, _title, output, info) => {
        const file = info.outputPath || path.join(output, path.basename(media) + '.jpg');
        fs.writeFileSync(file, jpeg); return file;
    });
    const ffmpeg = jest.spyOn(topic, 'runFfmpeg').mockImplementation(async args => {
        if (String(args.at(-1)).endsWith('.jpg')) fs.writeFileSync(args.at(-1), jpeg);
    });
    const calls: string[] = [];
    const generate = jest.spyOn(require('./ai_text_generator'), 'generateTextWithDaiYu').mockImplementation(async (prompt, options) => {
        let response;
        if (prompt.includes('for 精切实验模式.')) {
            calls.push('selection');
            response = { selected: [{ id: 1, reason: 'Complete story with a useful contrast' }] };
        } else if (prompt.includes('找出最值得强调的反应')) {
            calls.push('creative-moments'); response = { moments: [{ start: 3, end: 5, speechIds: ['S1'], reason: 'A reaction' }] };
        } else if (prompt.includes('"effects":[{"momentId"')) {
            calls.push('creative-plan'); response = { effects: [{ momentId: 'M1', frameIds: ['M1F0', 'M1F1', 'M1F2'],
                visualConfirmed: true, reason: 'The subject is visible', zoom: { x: .5, y: .4, scale: 1.3, target: 'avatar', safeToCrop: true } }] };
        } else if (prompt.includes('独立核对实际成片效果')) {
            calls.push('qa'); response = { approved: accepts, checks: { meaning: true, focus: true, subtitles: true, restraint: true }, issues: [] };
        } else if (prompt.includes('factual Chinese Bilibili clip title/cover variants')) {
            calls.push('packaging');
            response = { variants: [{ title: 'Host asked Guest about a book', coverText: 'Book\nQuestion', description: 'Host recalled asking Guest about a book.' }] };
        } else if (prompt.includes('Select one of the actually rendered covers')) {
            calls.push('cover'); response = { selectedIndex: 0 };
        } else if (prompt.includes('Independently audit the final edited clip')) {
            calls.push('qa');
            response = { approved: true, checks: { meaning: true, attribution: true, title: true, cover: true, subtitles: true, completeStory: true }, issues: [] };
        } else {
            const final = prompt.includes('Final-copy verification only:');
            calls.push(final ? 'final-actor' : 'initial-actor');
            const packets = prompt.split('\n').filter(line => line.startsWith('{"clipId":')).map(line => JSON.parse(line));
            expect(packets.length).toBeGreaterThan(0);
            response = { reviews: packets.map(packet => ({ clipId: packet.clipId, decision: final && !accepts ? 'needs_review' : 'accept',
                copy: final ? packet.copy : { title: 'Host asked Guest', coverText: 'Book\nQuestion', description: 'Host recalled asking Guest about a book.' },
                claims: [{ fields: ['title', 'coverText', 'description'], action: 'asked', narrator: 'Host', actor: 'Host', target: 'Guest',
                    sourceKind: 'recount', identityBasis: 'voice', speakerCueIds: [packet.inRangeCueIds[0]], cueIds: [packet.inRangeCueIds[0]] }],
                evidenceDanmakuIds: [], reason: 'Source checked' })) };
        }
        return { text: JSON.stringify(response), meta: { model: 'fixture', usage: { input_tokens: 100, output_tokens: 10 },
            attempts: [{ provider: 'daiYu', model: 'fixture', apiModeUsed: 'responses', reasoningEffortSent: 'high' }] } };
    });
    try {
        fs.writeFileSync(mediaPath, 'source fixture');
        asr.writeSrt({ backend: 'fixture', segments: Array.from({ length: 4 }, (_, i) => ({
            start: i * 100, end: i * 100 + 10, text: 'Host recalled asking Guest about a book.',
            speakerEvidence: { version: 1, status: 'row_supported', label: 'Host', observations: [{ start: i * 100,
                end: i * 100 + 10, label: 'Host', scope: 'row', row: { accepted: true, score: .8, margin: .2 } }] }
        })) }, srtPath, { write_evidence: true });
        const clips = Array.from({ length: 4 }, (_, i) => ({ start: i * 100, end: i * 100 + 60, duration: 60, boundaryFromEvidence: true,
            title: 'Host asked Guest', description: 'Host recalled asking Guest about a book.', coverText: 'Book\nQuestion', grounding: { sourceKind: 'recount' } }));
        fs.writeFileSync(planPath, JSON.stringify({ clips }));
        const config = { ai: { text: { provider: 'daiYu', enabled: true }, streamerRegistry: {
            host: { displayName: 'Host', aiClipName: 'Host', roomIds: ['room'] }, guest: { displayName: 'Guest', aiClipName: 'Guest' }
        } }, ownStreamClips: { enabled: true, minClipSeconds: 1, clipConcurrency: 1, notify: { enabled: false }, streamReviewRendering: workflow === 'creative',
            clipResourceAdaptive: { enabled: false }, attribution: { enabled: true, roomIds: ['room'], maxRequests: 1, batchSize: 4 },
            ai: { enabled: true, model: 'fixture' }, enhancements: { enabled: true, workflow, roomIds: ['room'], editing: true,
                experiment: { enabled: true, ratio: .25, maxClips: 5 }, budget: { mode: 'log_only', ledgerPath: path.join(directory, 'ledger.json') },
                stageDefaults: { provider: 'daiYu', model: 'fixture', apiMode: 'responses', reasoningEffort: 'high',
                    maxTokens: 2000, maxInputTokens: 100000, timeoutMs: 1000,
                    capabilities: { reasoningEfforts: ['high'], images: true, imageTokenUpperBound: 1000 } } } } };
        const results = await own.generateOwnStreamClips({ config, context: { roomId: 'room' }, mediaPath, srtPath, planPath,
            totalDurationSeconds: 400, registerUpload: false });
        expect(results).toHaveLength(4);
        if (workflow === 'creative') {
            const attempted = results[0];
            expect(attempted.uploadReady).toBe(true);
            expect(attempted.attributionReview.status).toBe('passed');
            expect(attempted.creativeResult.status).toBe(accepts ? 'edited' : 'kept_original');
            expect(attempted.precisionExperiment.selected).toBe(accepts);
            expect(calls).not.toContain('packaging'); expect(calls).not.toContain('final-actor');
            if (accepts) {
                expect(attempted.attributionReview.phase).toBe('precision_final_copy');
                expect(attempted.attributionReview.artifactDigests.video).toMatch(/^[a-f0-9]{64}$/);
                expect(attempted.qaResult.status).toBe('passed');
            }
            const rows = cut.mock.calls.filter(call => !call[4]?.creativePlan);
            expect(rows.map(call => call[1].index).sort()).toEqual([1, 2, 3, 4]);
            return;
        }
        expect(results.filter(row => row.precisionExperiment.selected)).toHaveLength(1);
        const selected = results.find(row => row.precisionExperiment.selected);
        expect(selected.uploadReady).toBe(accepts);
        expect(selected.attributionReview.status).toBe(accepts ? 'passed' : 'needs_review');
        expect(selected.attributionReview.phase).toBe('precision_final_copy');
        expect(selected.copy.description).toContain('精切实验模式');
        expect(results.filter(row => !row.precisionExperiment.selected).every(row => row.uploadReady && !row.qaRequired)).toBe(true);
        if (accepts) {
            expect(selected.attributionReview.artifactDigests.video).toMatch(/^[a-f0-9]{64}$/);
            expect(selected.qaResult.status).toBe('passed');
            expect(calls.indexOf('final-actor')).toBeLessThan(calls.indexOf('qa'));
            expect(selected.enhancement.generationLogs.find(call => call.stage === 'attribution').ledgerId).toBeTruthy();
        } else {
            expect(calls.filter(call => call === 'final-actor')).toHaveLength(3);
            expect(calls).not.toContain('qa');
        }
        expect(require('child_process').spawnSync).not.toHaveBeenCalled();
    } finally {
        cut.mockRestore(); cover.mockRestore(); ffmpeg.mockRestore(); generate.mockRestore();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
