export {};
const fs = require('fs'), os = require('os'), path = require('path');
const b = require('./stream_activity_boundaries'), p = require('./stream_activity_plan');
function fixture(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-boundaries-'));
    const config = p.getActivityConfig({ streamActivityClips: { verification: { provider: 'tuZi', apiMode: 'gemini_native', model: 'gemini-3-flash-preview', evidenceMethod: 'native_audio', ...overrides } } });
    const events = [
        { id: 'song', kind: 'song', start: 100, end: 400, performance: 'full', evidenceIds: ['T1'] },
        { id: 'watch', kind: 'watch', start: 1000, end: 5000, mediaKind: 'movie', evidenceIds: ['T2'] },
        { id: 'fragment', kind: 'song', start: 5200, end: 5215, performance: 'fragment', evidenceIds: ['T3'] }
    ].map(event => ({ ...event, name: null, startObserved: true, endObserved: true, titleEvidenceIds: [], reviewIssues: [], windows: [1] }));
    const rows = events.map((e, i) => ({ id: `T${i + 1}`, source: 'audio_transcript', start: e.start, end: e.start + 5, text: `真实听见第${i + 1}段歌词` }));
    const extract = jest.fn(async args => {
        const out = args.at(-1);
        if (out.endsWith('.pcm')) {
            fs.writeFileSync(out, Buffer.alloc(Number(args[args.indexOf('-t') + 1]) * 8000 * 2));
            fs.writeFileSync(args[args.indexOf('-b:a') + 2], 'audio');
        } else fs.writeFileSync(out, 'frame');
    });
    const request = jest.fn(async prompt => {
        const candidates = JSON.parse(prompt.match(/Candidates: ([^\n]+)/)[1]);
        const anchors = JSON.parse(prompt.match(/Audio time anchors: ([^\n]+)/)[1]);
        return { text: JSON.stringify({ results: candidates.map((e, i) => ({ id: e.id, decision: 'keep', timeBasis: 'audio_local_seconds',
            reason: '听到完整起止附近的实际歌词', audibleEvidence: [rows[events.findIndex(r => r.id === e.id)].text],
            events: [{ kind: e.kind, performance: e.performance, mediaKind: e.mediaKind, startObserved: true, endObserved: true,
                start: { audioIndex: e.audioIndices[0], seconds: e.roughStart - 2 - anchors[e.audioIndices[0] - 1].recordingStart },
                end: { audioIndex: e.audioIndices.at(-1), seconds: e.roughEnd + 2 - anchors[e.audioIndices.at(-1) - 1].recordingStart } }] })) }), meta: {} };
    });
    return { directory, config, events, rows, extract, request,
        args: { directory, config, root: {}, source: { mediaPath: 'source.flv' }, info: { streamerName: '岁己' }, rows,
            duration: 6000, diagnostics: { requests: [] }, extract, request } };
}
test('one bounded batch calibrates several candidates using short audio and retains the complete song/movie middle', async () => {
    const f = fixture();
    try {
        const result = await b.calibrateBoundaries(f.events, f.args);
        expect(result).toMatchObject({ requests: 1, audioSeconds: 345, rejected: [] });
        expect(result.events.map(e => [e.start, e.end])).toEqual([[98, 402], [998, 5002], [5198, 5217]]);
        expect(f.request).toHaveBeenCalledTimes(1);
        expect(f.request.mock.calls[0][0]).toContain('rmsDb');
        expect(f.extract.mock.calls.filter(call => call[0].at(-1).endsWith('.pcm'))).toHaveLength(5);
        expect(f.extract.mock.calls.every(call => !call[0].includes('4000'))).toBe(true);
        const cached = await b.calibrateBoundaries(f.events, f.args);
        expect(cached).toMatchObject({ requests: 0, cacheHits: 1 });
        expect(f.request).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('a sibling audio reference or a verse-trimming boundary becomes uncertainty without a second AI attempt', async () => {
    const f = fixture(), original = f.request;
    const request = jest.fn(async (...args) => {
        const response = await original(...args), raw = JSON.parse(response.text);
        raw.results[0].events[0].start.seconds += 10;
        raw.results[2].events[0].start.audioIndex = 1;
        return { ...response, text: JSON.stringify(raw) };
    });
    try {
        const result = await b.calibrateBoundaries(f.events, { ...f.args, request });
        expect(result.events[0]).toMatchObject({ start: 100, end: 400, provisionalWindow: { start: 55, end: 430 }, verification: { decision: 'uncertain' } });
        expect(result.events[1].verification.decision).toBe('keep');
        expect(result.events[2].verification.reason).toContain('another candidate audio');
        expect(request).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('a per-stream budget preserves all remaining candidates rather than requesting more batches or dropping them', async () => {
    const f = fixture({ batchMaxEvents: 1, maxBatchRequests: 1 });
    try {
        const result = await b.calibrateBoundaries(f.events, f.args);
        expect(result.events).toHaveLength(3); expect(f.request).toHaveBeenCalledTimes(1);
        expect(result.events.slice(1).every(e => e.verification.reason === 'Per-stream AI budget reached')).toBe(true);
        expect(f.extract).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('unavailable media verification does no extraction or AI work', async () => {
    const f = fixture();
    try {
        const result = await b.calibrateBoundaries(f.events, { ...f.args, request: undefined });
        expect(result.requests).toBe(0); expect(result.events).toHaveLength(3); expect(f.extract).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a service retry reuses extracted packets and counts every request against the shared budget', async () => {
    const f = fixture(), wait = jest.fn(async () => undefined);
    const request = jest.fn().mockRejectedValueOnce(new Error('Activity media verification HTTP 502'))
        .mockImplementation(f.request);
    try {
        const result = await b.calibrateBoundaries(f.events, { ...f.args, request, wait });
        expect(result).toMatchObject({ requests: 2, audioSeconds: 690 });
        expect(result.events.every(event => event.verification.decision === 'keep')).toBe(true);
        expect(f.extract).toHaveBeenCalledTimes(6);
        expect(wait).toHaveBeenCalledWith(2000);
        expect(result.events[0].verification.transportRetries[0]).toMatchObject({ attempt: 1, delayMs: 2000 });
        const cached = await b.calibrateBoundaries(f.events, { ...f.args, request, wait, usedRequests: 3 });
        expect(cached).toMatchObject({ requests: 0, cacheHits: 1 });
        expect(request).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('local activity verification sends only original images to DaiYu and reuses the bound decoder and remote result', async () => {
    const f = fixture(), config = p.getActivityConfig({});
    const localDecode = jest.fn(async (input, output) => {
        const request = JSON.parse(fs.readFileSync(input, 'utf8'));
        fs.writeFileSync(output, JSON.stringify({ version: 1, method: 'independent_local_asr', source: request.source, settings: request.settings,
            audio: request.audio.map((a, i) => ({ index: i + 1, start: a.start, end: a.end, sha256: a.sha256, transcript: [],
                chunks: Array.from({ length: Math.ceil((a.end-a.start)/8) }, (_, j) => ({ index: j + 1, start: j*8,
                    end: Math.min(a.end-a.start, (j+1)*8), raw: '真实听见第1段歌词', text: '真实听见第1段歌词', tags: ['BGM'] })) })) }));
    });
    const extract = jest.fn(async args => {
        const out = args.at(-1);
        if (out.endsWith('.pcm')) fs.writeFileSync(out, Buffer.alloc(60 * 8000 * 2));
        else fs.writeFileSync(out, Buffer.alloc(2000));
    });
    const request = jest.fn(async (...args) => {
        expect(args[0]).toContain('NO audio');
        expect(args[1].every(input => input.mimeType.startsWith('image/'))).toBe(true);
        expect(args[3]).toMatchObject({ provider: 'daiYu', apiMode: 'openai_chat' });
        const response = await f.request(...args), raw = JSON.parse(response.text);
        Object.assign(raw.results[0], { performer: 'host', startContextClosed: true, endContextClosed: true,
            evidenceRefs: [{ audioIndex: 1, chunkIndex: 7, quote: '真实听见第1段歌词' }] });
        return { ...response, text: JSON.stringify(raw) };
    });
    try {
        const args = { ...f.args, config, extract, request, localDecode };
        const result = await b.calibrateBoundaries([f.events[0]], args);
        expect(result.events[0].verification).toMatchObject({ decision: 'keep', method: 'independent_local_asr',
            boundaryPolicy: 'complete_context_enclosure', responseSha256: expect.any(String) });
        expect(localDecode).toHaveBeenCalledTimes(1);
        expect(await b.calibrateBoundaries([f.events[0]], args)).toMatchObject({ requests: 0, cacheHits: 1 });
        expect(localDecode).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(1);
        const failed = await b.calibrateBoundaries([f.events[0]], { ...args, retryId: 'outage', usedRequests: 2,
            reusableEvidence: [result.events[0].verification], request: async () => { throw new Error('network timeout'); } });
        expect(failed.events[0].verification).toMatchObject({ decision: 'uncertain', localAudioEvidence: { sha256: expect.any(String) } });
        expect(localDecode).toHaveBeenCalledTimes(1);
        const resumed = await b.calibrateBoundaries([f.events[0]], { ...args, retryId: 'recovered',
            reusableEvidence: [result.events[0].verification] });
        expect(resumed.events[0].verification.decision).toBe('keep');
        expect(localDecode).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('long partial performances also use only boundary excerpts and the batch requests minimal thinking', async () => {
    const f = fixture();
    try {
        expect(b.boundaryIntervals({ ...f.events[0], performance: 'fragment' }, 6000, f.config.verification))
            .toEqual([{ start: 55, end: 115 }, { start: 385, end: 445 }]);
        await b.calibrateBoundaries(f.events, f.args);
        expect(f.request.mock.calls[0][3]).toMatchObject({ thinkingLevel: 'minimal', timeoutMs: 60000 });
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
test('a configured audio limit is enforced even when one candidate cannot fit', async () => {
    const f = fixture({ boundaryContextSeconds: 90, batchMaxAudioSeconds: 120 });
    try {
        const result = await b.calibrateBoundaries([f.events[0]], f.args);
        expect(result.requests).toBe(0); expect(f.extract).not.toHaveBeenCalled();
        expect(result.events[0].verification.reason).toContain('audio budget');
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('a short fragment encloses earlier lyrics and a later reprise within the configured context in one request', async () => {
    const f = fixture();
    const request = jest.fn(async (...args) => {
        const response = await f.request(...args), raw = JSON.parse(response.text);
        raw.results[0].events[0].start.seconds = 25;
        raw.results[0].events[0].end.seconds = 85;
        return { ...response, text: JSON.stringify(raw) };
    });
    try {
        const result = await b.calibrateBoundaries([f.events[2]], { ...f.args, request });
        expect(result).toMatchObject({requests:1,audioSeconds:105});
        expect(result.events[0]).toMatchObject({start:5180,end:5240,verification:{decision:'keep'}});
        expect(request).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory,{recursive:true,force:true}); }
});

test('later stages share the spent request budget while completed boundary cache entries remain reusable', async () => {
    const f = fixture({ maxBatchRequests: 1 });
    try {
        const songs = await b.calibrateBoundaries([f.events[0]], f.args);
        expect(songs.events[0].id).toBe('song');
        const watch = await b.calibrateBoundaries([f.events[1]], { ...f.args, usedRequests: songs.requests });
        expect(watch.requests).toBe(0);
        expect(watch.events[0].verification.reason).toBe('Per-stream AI budget reached');
        const cached = await b.calibrateBoundaries([f.events[0]], { ...f.args, usedRequests: 1 });
        expect(cached).toMatchObject({ requests: 0, cacheHits: 1 });
        expect(cached.events[0].verification.decision).toBe('keep');
        expect(f.request).toHaveBeenCalledTimes(1);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('legacy calibrated caches without IDs bind the cached raw reply to current candidates without extracting or requesting again', async () => {
    const f = fixture();
    try {
        const first = await b.calibrateBoundaries(f.events, f.args);
        const cacheDirectory = path.join(f.directory, 'temp', 'boundary-cache');
        const cachePath = path.join(cacheDirectory, fs.readdirSync(cacheDirectory).find(name => name.endsWith('.json')));
        const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const event of cached.result.calibrated.events) {
            delete event.id;
            event.start = -1;
        }
        fs.writeFileSync(cachePath, JSON.stringify(cached));
        const extracted = f.extract.mock.calls.length;
        const resumed = await b.calibrateBoundaries(f.events, { ...f.args, usedRequests: f.config.verification.maxBatchRequests });
        expect(resumed).toMatchObject({ requests: 0, cacheHits: 1 });
        expect(resumed.events).toEqual(first.events);
        expect(resumed.events.map(event => event.id)).toEqual(['song', 'watch', 'fragment']);
        expect(f.request).toHaveBeenCalledTimes(1);
        expect(f.extract).toHaveBeenCalledTimes(extracted);
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});
