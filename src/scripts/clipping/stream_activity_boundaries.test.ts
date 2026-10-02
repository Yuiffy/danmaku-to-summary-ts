export {};
const fs = require('fs'), os = require('os'), path = require('path');
const b = require('./stream_activity_boundaries'), p = require('./stream_activity_plan');
function fixture(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-boundaries-'));
    const config = p.getActivityConfig({ streamActivityClips: { verification: overrides } });
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
        expect(result).toMatchObject({ requests: 1, audioSeconds: 285, rejected: [] });
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
