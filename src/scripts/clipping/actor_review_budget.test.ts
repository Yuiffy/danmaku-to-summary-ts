export {};
const { reviewClipActors } = require('./actor_review_runner');
const { buildSubtitleEvidence } = require('./subtitle_evidence');
test('repair rounds cannot consume the requests reserved for unreviewed batches', async () => {
    const parsed = { participantContext: { people: [{ id: 'host', label: 'Host', preferredName: 'Host', names: ['Host'], sourceHost: true }] },
        segments: Array.from({ length: 12 }, (_, i) => ({ start: i * 100, end: i * 100 + 30, text: 'Host tells a complete story.',
            speakerEvidence: { status: 'row_supported', label: 'Host', observations: [{ start: i * 100, end: i * 100 + 30,
                label: 'Host', scope: 'row', row: { accepted: true, score: .8, margin: .2 } }] } })) };
    const clips = parsed.segments.map(row => ({ start: row.start, end: row.end, title: 'Host tells a complete story',
        coverText: 'Complete\nStory', description: 'Host tells a complete story.', grounding: { sourceKind: 'playback' } }));
    const batches = [];
    const generate = jest.spyOn(require('../ai_text_generator'), 'generateTextWithDaiYu').mockImplementation(async prompt => {
        const packets = prompt.split('\n').filter(line => line.startsWith('{"clipId":')).map(line => JSON.parse(line));
        batches.push(packets.map(packet => packet.clipId));
        return { text: JSON.stringify({ reviews: packets.map(packet => ({ clipId: packet.clipId, decision: 'accept', copy: packet.copy,
            claims: [{ fields: ['title', 'coverText', 'description'], action: 'tells story', narrator: 'Host', actor: 'Host', target: null,
                sourceKind: 'playback', identityBasis: 'voice', speakerCueIds: [packet.inRangeCueIds[0]], cueIds: ['G99999'] }],
            evidenceDanmakuIds: [], reason: 'intentional invalid citation' })) }), meta: {} };
    });
    try {
        const diagnostics = { requests: [], errors: [] };
        await reviewClipActors(clips, parsed, [], buildSubtitleEvidence(parsed.segments), { roomId: 'room' },
            { ai: { enabled: true, model: 'fixture' }, attribution: { enabled: true, roomIds: ['room'], batchSize: 4,
                concurrency: 1, maxRequests: 3, repairAttempts: 1, dialogueEnabled: false } }, { ai: { text: { provider: 'daiYu' } } }, diagnostics);
        expect(batches).toEqual([['c1', 'c2', 'c3', 'c4'], ['c5', 'c6', 'c7', 'c8'], ['c9', 'c10', 'c11', 'c12']]);
        expect(diagnostics.attribution.requests).toBe(3);
        expect(diagnostics.attribution.events.some(row => row.reason === 'request_budget_exhausted')).toBe(false);
    } finally { generate.mockRestore(); }
});
