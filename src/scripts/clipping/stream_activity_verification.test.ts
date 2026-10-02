export {};
jest.mock('node-fetch', () => jest.fn());
const fs = require('fs'), os = require('os'), path = require('path');
const fetch = require('node-fetch');
const v = require('./stream_activity_verification');
const p = require('./stream_activity_plan');
const event = { kind: 'song', start: 200, end: 400, name: null, performance: 'full', startObserved: false,
    endObserved: false, evidenceIds: ['T1'], titleEvidenceIds: [], windows: [1] };
const rows = p.evidenceRows([{ start: 185, end: 187, text: '[UNKNOWN] 唱一首告' }, { start: 187, end: 189, text: '[UNKNOWN] 诉我这首歌' },
    { start: 205, end: 380, text: '实际演唱歌词' }]);
const window = { index: 1, start: 200, end: 400, from: 20, to: 580, rows };
test('media review excludes BGM or retains a complete source-cited named performance', () => {
    expect(v.parseVerification({ text: JSON.stringify({ decision: 'exclude', reason: '开场等待画面，只有播放器放歌', events: [] }) }, event, window, 1000).events).toEqual([]);
    const kept = v.parseVerification({ text: JSON.stringify({ decision: 'keep', timeBasis: 'recording_seconds', audibleEvidence: ['实际演唱歌词'], reason: '原音频确认主播唱完', events: [
        { ...event, start: 190, end: 390, startObserved: true, endObserved: true }] }) },
        { ...event, name: '告诉我', evidenceIds: ['T1', 'T2', 'T3'], titleEvidenceIds: ['T1', 'T2'] }, window, 1000);
    expect(kept.events[0]).toMatchObject({ name: '告诉我', start: 190, end: 390 });
    expect(() => v.parseVerification({ text: JSON.stringify({ decision: 'keep', reason: 'guess', events: [] }) }, event, window, 1000)).toThrow();
});
test('configured transport sends original audio and actual frames in declared order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-multimodal-'));
    try {
        const audio = path.join(dir, 'audio.mp3'), frame = path.join(dir, 'frame.jpg');
        fs.writeFileSync(audio, 'audio'); fs.writeFileSync(frame, 'frame');
        fetch.mockResolvedValue({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"decision":"exclude","reason":"BGM","events":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } }) });
        const result = await v.requestMediaVerification('Verify', [{ path: audio, mimeType: 'audio/mpeg' }, { path: frame, mimeType: 'image/jpeg' }],
            { ai: { text: { tuZi: { apiKey: 'fixture-key', baseUrl: 'https://example.com/v1/' } } } },
            { provider: 'tuZi', model: 'gemini-3-flash-preview', timeoutMs: 1000 });
        const body = JSON.parse(fetch.mock.calls.at(-1)[1].body);
        expect(fetch.mock.calls.at(-1)[0]).toBe('https://example.com/v1/chat/completions');
        expect(body.messages[0].content.map(row => row.type)).toEqual(['text', 'input_audio', 'image_url']);
        expect(result.meta.attempts[0]).toMatchObject({ provider: 'tuZi', totalTokens: 18 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('unavailable media review remains uncertainty, never verification or an empty setlist', async () => {
    const result = await v.verifyActivity(event, { root: {}, config: p.getActivityConfig({}) });
    expect(result.decision).toBe('uncertain');
    expect(p.mergeEvents(result.events)[0].reviewIssues).toContain('media_verification_unconfirmed');
});
test('viewing verification uses configured audio context to refine a recalled open start', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-watch-context-'));
    try {
        const watch = { ...event, kind: 'watch', mediaKind: 'movie', start: 5393, end: 12388 };
        const local = p.evidenceRows([{ start: 5510, end: 5513, text: '现在开始看电影' }, { start: 12385, end: 12388, text: '看完了' }]);
        const extract = jest.fn(async args => { fs.writeFileSync(args.at(-1), 'fixture'); });
        const request = jest.fn(async () => ({ text: JSON.stringify({ decision: 'keep', timeBasis: 'recording_seconds', audibleEvidence: ['现在开始看电影'], reason: '边界音频确认实际播放起点',
            events: [{ ...watch, start: 5510, startObserved: true, endObserved: true, evidenceIds: ['T1', 'T2'] }] }) }));
        const result = await v.verifyActivity(watch, { root: {}, config: p.getActivityConfig({}), source: { mediaPath: 'source.flv' },
            info: { streamerName: '岁己' }, directory: dir, rows: local, duration: 15000, diagnostics: { requests: [] }, extract, request });
        expect(result).toMatchObject({ decision: 'keep', events: [{ start: 5510, end: 12388 }] });
        expect(request.mock.calls[0][1].slice(0, 2).map(row => [row.start, row.end])).toEqual([[5213, 5573], [12208, 12568]]);
        expect(request.mock.calls[0][0]).not.toContain('现在开始看电影');
        expect(request.mock.calls[0][0]).not.toContain('SOURCE DATA');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('blind media observation cannot invent source IDs or replace an unsupported title', () => {
    const response = { text: JSON.stringify({ decision: 'keep', timeBasis: 'recording_seconds', audibleEvidence: ['实际演唱歌词'], reason: '听见实际演唱歌词', events: [
        { ...event, name: '猜测歌名', evidenceIds: ['D999'], titleEvidenceIds: ['D999'], startObserved: true, endObserved: true }] }) };
    expect(v.parseVerification(response, event, window, 1000).events[0]).toMatchObject({ name: null, evidenceIds: ['T1'], titleEvidenceIds: [] });
});

test('explicit local-audio coordinates are converted once and cannot silently masquerade as recording time', () => {
    const song = { ...event, start: 4302, end: 4502 };
    const local = { ...window, start: 4302, end: 4502, from: 4122, to: 4682,
        rows: p.evidenceRows([{ start: 4308, end: 4499, text: '实际演唱歌词' }]) };
    const observed = { ...song, start: { audioIndex: 1, seconds: 146 }, end: { audioIndex: 1, seconds: 380 },
        startObserved: true, endObserved: true };
    const result = v.parseVerification({ text: JSON.stringify({ decision: 'keep', timeBasis: 'audio_local_seconds',
        audibleEvidence: ['实际演唱歌词'], reason: '前奏之后连续演唱，尾奏结束', events: [observed] }) }, song, local, 5000, [{ start: 4122, end: 4682 }]);
    expect(result.events[0]).toMatchObject({ start: 4268, end: 4502 });
    expect(() => v.parseVerification({ text: JSON.stringify({ decision: 'keep', reason: '演唱',
        events: [{ ...song, start: 186, end: 380 }] }) }, song, local, 5000)).toThrow('explicit timeBasis');
    expect(() => v.parseVerification({ text: JSON.stringify({ decision: 'keep', timeBasis: 'audio_local_seconds',
        audibleEvidence: ['实际演唱歌词'], reason: '演唱', events: [{ ...observed, end: { audioIndex: 1, seconds: 600 } }] }) }, song, local, 5000,
        [{ start: 4122, end: 4682 }])).toThrow('outside its declared audio');
});

test('two viewing boundary packets retain their independent local time origins and the complete middle', () => {
    const watch = { ...event, kind: 'watch', mediaKind: 'movie', start: 5393, end: 12388 };
    const local = { ...window, start: 5393, end: 12388, from: 5213, to: 12568,
        rows: p.evidenceRows([{ start: 5510, end: 5513, text: '实际播放' }]) };
    const result = v.parseVerification({ text: JSON.stringify({ decision: 'keep', timeBasis: 'audio_local_seconds',
        audibleEvidence: ['实际播放'], reason: '实际开始播放和结束', events: [{ ...watch, start: { audioIndex: 1, seconds: 297 },
            end: { audioIndex: 2, seconds: 180 }, startObserved: true, endObserved: true }] }) }, watch, local, 15000,
        [{ start: 5213, end: 5573 }, { start: 12208, end: 12568 }]);
    expect(result.events[0]).toMatchObject({ start: 5510, end: 12388 });
});

test('verification cannot turn verses and neighboring context into extra performances', () => {
    expect(() => v.parseVerification({ text: JSON.stringify({ decision: 'keep', timeBasis: 'recording_seconds',
        reason: '先唱主歌再唱副歌', events: [{ ...event, start: 200, end: 300 }, { ...event, start: 300, end: 400 }] }) },
        event, window, 1000)).toThrow('one complete candidate');
});

test('one malformed media coordinate response is repaired from the same original attachments', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-audio-repair-'));
    try {
        const extract = jest.fn(async args => fs.writeFileSync(args.at(-1), 'fixture'));
        const request = jest.fn(async (prompt: string) => ({ text: JSON.stringify({ decision: 'keep', audibleEvidence: ['实际演唱歌词'], reason: '实际连续演唱歌词',
            ...(prompt.includes('FORMAT REPAIR') ? { timeBasis: 'audio_local_seconds' } : {}),
            events: [{ ...event, start: { audioIndex: 2, seconds: 80 }, end: { audioIndex: 3, seconds: 20 },
                startObserved: true, endObserved: true }] }) }));
        const result = await v.verifyActivity(event, { root: {}, config: p.getActivityConfig({}), source: { mediaPath: 'source.flv' },
            info: { streamerName: '岁己' }, directory: dir, rows, duration: 1000, diagnostics: { requests: [] }, extract, request });
        expect(result).toMatchObject({ decision: 'keep', events: [{ start: 190, end: 390 }] });
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1][0]).toContain('FORMAT REPAIR');
        expect(extract).toHaveBeenCalledTimes(7);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a full song uses independent musical boundary audio instead of copying its first lyric timestamp', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-musical-intro-'));
    try {
        const song = { ...event, start: 4302, end: 4502 };
        const local = p.evidenceRows([{ start: 4308, end: 4499, text: '实际演唱歌词' }]);
        const extract = jest.fn(async args => fs.writeFileSync(args.at(-1), 'fixture'));
        const request = jest.fn(async () => ({ text: JSON.stringify({ decision: 'keep', timeBasis: 'audio_local_seconds',
            audibleEvidence: ['实际演唱歌词'], reason: '先有前奏，随后连续演唱，最后尾奏结束转为说话', events: [{ ...song,
                start: { audioIndex: 2, seconds: 56 }, end: { audioIndex: 3, seconds: 30 },
                startObserved: true, endObserved: true }] }) }));
        const result = await v.verifyActivity(song, { root: {}, config: p.getActivityConfig({}), source: { mediaPath: 'source.flv' },
            info: { streamerName: '岁己' }, directory: dir, rows: local, duration: 5000, diagnostics: { requests: [] }, extract, request });
        expect(result).toMatchObject({ decision: 'keep', events: [{ start: 4268, end: 4502 }] });
        expect(request.mock.calls[0][1].slice(0, 3).map(a => [a.start, a.end])).toEqual([[4212, 4532], [4212, 4332], [4472, 4532]]);
        expect(request.mock.calls[0][0]).not.toContain('unverified interval 4302-4502');
        expect(request.mock.calls[0][0]).toContain('A first lyric timestamp is not the intro');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native Gemini transport preserves multiple audio attachments and their audio usage evidence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-native-audio-'));
    try {
        const first = path.join(dir, 'first.mp3'), second = path.join(dir, 'second.mp3');
        fs.writeFileSync(first, 'first-audio'); fs.writeFileSync(second, 'second-audio');
        fetch.mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"decision":"exclude","reason":"旧录音播放","events":[]}' }] } }],
            usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 20, totalTokenCount: 220,
                promptTokensDetails: [{ modality: 'TEXT', tokenCount: 40 }, { modality: 'AUDIO', tokenCount: 160 }] } }) });
        const result = await v.requestMediaVerification('Listen independently', [{ path: first, mimeType: 'audio/mpeg' }, { path: second, mimeType: 'audio/mpeg' }],
            { ai: { text: { tuZi: { apiKey: 'fixture-key', baseUrl: 'https://example.com/v1' } } } },
            { provider: 'tuZi', apiMode: 'gemini_native', model: 'gemini-3-flash-preview', timeoutMs: 1000 });
        const body = JSON.parse(fetch.mock.calls.at(-1)[1].body);
        expect(fetch.mock.calls.at(-1)[0]).toBe('https://example.com/v1beta/models/gemini-3-flash-preview:generateContent');
        expect(body.contents[0].parts.slice(1).map(p => Buffer.from(p.inlineData.data, 'base64').toString())).toEqual(['first-audio', 'second-audio']);
        expect(result.meta).toMatchObject({ apiMode: 'gemini_native', attempts: [{ inputAudioTokens: 160 }] });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('generic media claims and audience-only lyric quotes cannot become confirmed listening evidence', () => {
    const base = { decision: 'keep', timeBasis: 'recording_seconds', reason: 'The host sings from the intro through the outro', events: [event] };
    expect(() => v.parseVerification({ text: JSON.stringify(base) }, event, window, 1000)).toThrow('specific audibleEvidence');
    const audienceOnly = { ...window, rows: p.evidenceRows([{ start: 200, end: 400, text: '普通聊天内容' }], [{ time: 220, text: '猜测的演唱歌词' }]) };
    expect(() => v.parseVerification({ text: JSON.stringify({ ...base, audibleEvidence: ['猜测的演唱歌词'] }) },
        event, audienceOnly, 1000)).toThrow('do not match the source transcript');
});

test('full performance verification cannot omit an already observed verse', () => {
    const recalled = { ...event, startObserved: true, endObserved: true };
    const response = { text: JSON.stringify({ decision: 'keep', timeBasis: 'recording_seconds',
        audibleEvidence: ['实际演唱歌词'], reason: '后半段实际演唱', events: [{ ...recalled, start: 250 }] }) };
    expect(() => v.parseVerification(response, recalled, window, 1000)).toThrow('would omit recalled singing');
});

test('unresolved full song boundaries preserve available musical context as a provisional review video', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-provisional-song-'));
    try {
        const recalled = { ...event, startObserved: true, endObserved: true };
        const extract = jest.fn(async args => fs.writeFileSync(args.at(-1), 'fixture'));
        const request = jest.fn(async () => ({ text: JSON.stringify({ decision: 'keep', timeBasis: 'audio_local_seconds',
            audibleEvidence: ['实际演唱歌词'], reason: '只有后半段实际演唱的边界', events: [{ ...recalled,
                start: { audioIndex: 2, seconds: 100 }, end: { audioIndex: 3, seconds: 30 } }] }) }));
        const result = await v.verifyActivity(recalled, { root: {}, config: p.getActivityConfig({}), source: { mediaPath: 'source.flv' },
            info: { streamerName: '岁己' }, directory: dir, rows, duration: 1000, diagnostics: { requests: [] }, extract, request });
        expect(result).toMatchObject({ decision: 'uncertain', events: [{ start: 200, end: 400, startObserved: false,
            endObserved: false, provisionalWindow: { start: 110, end: 430 }, verification: { decision: 'uncertain' } }] });
        expect(result.events[0].reviewIssues).toContain('performance_boundary_provisional');
        const events = p.mergeEvents(result.events), parts = p.buildParts(events, 1000, p.getActivityConfig({}));
        expect(parts.songs[0]).toMatchObject({ start: 108, end: 432 });
        expect(p.songRecord({ events, parts }).songs[0]).toMatchObject({ verificationStatus: 'uncertain',
            provisionalWindow: { start: 110, end: 430 } });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('short fragments are checked near the actual candidate rather than a long earlier performance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-fragment-context-'));
    try {
        const fragment = { ...event, start: 4514, end: 4525, performance: 'fragment' };
        const extract = jest.fn(async args => fs.writeFileSync(args.at(-1), 'fixture'));
        const request = jest.fn(async () => ({ text: JSON.stringify({ decision: 'exclude', reason: '只有邻近旧录音播放，候选内没有现场演唱', events: [] }) }));
        const result = await v.verifyActivity(fragment, { root: {}, config: p.getActivityConfig({}), source: { mediaPath: 'source.flv' },
            info: { streamerName: '岁己' }, directory: dir, rows: [], duration: 5000, diagnostics: { requests: [] }, extract, request });
        expect(result.decision).toBe('exclude');
        expect(request.mock.calls[0][1][0]).toMatchObject({ start: 4484, end: 4555 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
