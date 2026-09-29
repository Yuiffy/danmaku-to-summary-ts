export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { runCreativeEnhancement } = require('./creative_runner');
const { protectedStoryCues, validateStoryPlan, storyReviewEvidence } = require('./creative_timeline');

const cues = [
    { id: 'C1', start: 0, end: 2.545, text: '原素材的开场过渡' },
    { id: 'C2', start: 3.11, end: 6.65, text: '想问对方能否辨认虫子' },
    { id: 'C3', start: 6.65, end: 10.45, text: '家里出现过虫子' },
    { id: 'C4', start: 12, end: 15, text: '无关的支线' },
    { id: 'C5', start: 20, end: 24, text: '原来是假的装饰' }
];
const protectedSpans = [{ id: 'G1', start: 0, end: 10.45, text: '原始分组包含过渡和起因' }];
const profile = { kind: 'conversation', tone: 'neutral', density: 'light', preserveContinuity: false,
    music: 'none', laughter: false, reason: '聊天' };
const draft = (fromCue = 'C1') => ({ profile, keep: [
    { fromCue, toCue: 'C3', role: 'setup', reason: '保留起因' },
    { fromCue: 'C5', toCue: 'C5', role: 'payoff', reason: '保留揭晓' }
] });

test('group protection exposes exact subtitle IDs while the full evidence span remains mandatory', () => {
    expect(protectedStoryCues(protectedSpans, cues)[0].cueIds).toEqual(['C1', 'C2', 'C3']);
    expect(protectedStoryCues([{ id: 'D1', start: 16, end: 16.05 }], cues)[0].cueIds).toEqual([]);
    expect(() => validateStoryPlan(draft('C2'), cues, 30, protectedSpans, profile)).toThrow('public-copy evidence');
    expect(validateStoryPlan(draft(), cues, 30, protectedSpans, profile).keep).toHaveLength(2);
});

test('semantic QA receives source and edited times plus verified coverage after earlier speech is removed', () => {
    const timeline = validateStoryPlan(draft(), cues, 30, protectedSpans, profile);
    const packet = storyReviewEvidence(cues, timeline, [...protectedSpans, { id: 'G2', start: 20, end: 24 }]);
    const ending = packet.kept.find(c => c.id === 'C5');
    expect(ending.start).toBeLessThan(20);
    expect(ending.sourceStart).toBe(20);
    expect(ending.sourceEnd).toBe(24);
    expect(packet.protectedCoverage[1]).toMatchObject({ covered: true, cueIds: ['C5'], retainedCueIds: ['C5'] });
    expect(() => storyReviewEvidence(cues, timeline, [{ id: 'G3', start: 12, end: 15 }])).toThrow('complete protected evidence');
});

test.each(['recovered', 'invalid_again', 'qa_rejected', 'resumed', 'source_incomplete', 'repair_request_fails'])('semantic story repair %s cannot bypass protected evidence or final QA', async outcome => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-story-'));
    const output = { mediaPath: path.join(dir, 'clip.mp4'), srtPath: path.join(dir, 'clip.srt'),
        metadataPath: path.join(dir, 'clip.json'), coverPath: path.join(dir, 'cover.jpg'), burnedSubtitles: true };
    const source = path.join(dir, 'source.mp4'), srt = path.join(dir, 'source.srt');
    for (const file of [source, srt, output.mediaPath, output.srtPath, output.coverPath]) fs.writeFileSync(file, 'fixture');
    const baseline = { uploadReady: true, window: { start: 100, end: 130, duration: 30, index: 1 },
        copy: { title: '考对方辨认假虫', description: '完整起因和揭晓', coverText: '原来是假的' }, output };
    const context: any = { config: { enhancements: { creative: { style: 'compact' }, budget: {} } }, info: {},
        parsed: { segments: cues.map(c => ({ ...c, start: c.start + 100, end: c.end + 100 })) }, danmaku: [],
        source: { mediaPath: source }, options: { srtPath: srt },
        clip: { attributionReview: { claims: [{ cueIds: ['G1'] }] } },
        subtitleEvidence: { byId: new Map([['G1', { start: 100, end: 110.45, text: '受保护的整组证据' }]]) },
        topic: { parseTopicSrt: () => ({ segments: cues }), cutClipMedia: jest.fn(),
            runFfmpeg: jest.fn(() => { throw new Error('test_media_boundary'); }) } };
    if (outcome === 'resumed') {
        const resume = path.join(dir, 'previous'), scratch = path.join(resume, 'temp', 'clip-creative');
        fs.mkdirSync(scratch, { recursive: true });
        fs.writeFileSync(path.join(resume, 'clip.json'), JSON.stringify({}));
        fs.writeFileSync(path.join(scratch, 'story-qa-repair-response.json'), JSON.stringify({ text: JSON.stringify(draft('C2')) }));
        fs.writeFileSync(path.join(scratch, 'story-qa-constraint-repair-response.json'), JSON.stringify({ text: JSON.stringify(draft()) }));
        context.options.creativeResumeDirectory = resume;
    }
    const stages: string[] = [];
    const dependencies = { requestStage: jest.fn(async (_config, _budget, _info, phase, prompt) => {
        const stage = phase.replace(/^creative-/, '').replace(/-1$/, ''); stages.push(stage);
        let value;
        if (stage.startsWith('story')) {
            expect(prompt).toContain('protectedCues');
            expect(prompt).toContain('"cueIds":["C1","C2","C3"]');
        }
        switch (stage) {
        case 'story': value = draft(); break;
        case 'story-qa': value = outcome === 'source_incomplete'
            ? { approved: false, needsSourceExpansion: true, issues: ['结尾后半句在素材窗之外，需扩展素材'] }
            : { approved: false, issues: ['删除无关的开头C1'] }; break;
        case 'story-qa-repair':
            if (outcome === 'repair_request_fails') throw new Error('invalid_structured_json');
            value = draft('C2'); break;
        case 'story-qa-constraint-repair':
            expect(prompt).toContain('Retain public-copy evidence: G1');
            value = draft(outcome === 'invalid_again' ? 'C2' : 'C1'); break;
        case 'story-qa-final': value = { approved: outcome !== 'qa_rejected', issues: outcome === 'qa_rejected' ? ['指代仍不完整'] : [] }; break;
        case 'moments': value = { moments: [] }; break;
        default: throw new Error('Unexpected stage ' + stage);
        }
        return { text: JSON.stringify(value), meta: {} };
    }) };
    try {
        const result = await runCreativeEnhancement(baseline, context, dependencies);
        if (outcome === 'repair_request_fails') {
            expect(result.creativeResult.reason).toContain('删除无关的开头C1');
            expect(result.creativeResult.reason).toContain('invalid_structured_json');
            expect(context.topic.cutClipMedia).not.toHaveBeenCalled();
            return;
        }
        if (outcome === 'source_incomplete') {
            expect(stages).toEqual(['story', 'story-qa']);
            expect(result.creativeResult.reason).toContain('source_window_incomplete');
            expect(result.creativeResult.reason).toContain('结尾后半句');
            expect(result.creativeResult.history.at(-1).qa.needsSourceExpansion).toBe(true);
            expect(context.topic.cutClipMedia).not.toHaveBeenCalled();
            return;
        }
        expect(stages.filter(s => s === 'story-qa-constraint-repair')).toHaveLength(1);
        expect(context.topic.cutClipMedia).not.toHaveBeenCalled();
        expect(result.output).toEqual(output);
        expect(result.creativeResult.status).toBe('kept_original');
        if (outcome === 'invalid_again') {
            expect(result.creativeResult.reason).toContain('Retain public-copy evidence');
            expect(stages).not.toContain('story-qa-final');
        } else {
            expect(stages).toContain('story-qa-final');
            expect(result.creativeResult.reason).toBe(outcome === 'qa_rejected' ? 'story_qa_rejected' : 'creative_failed: test_media_boundary');
            expect(stages.includes('moments')).toBe(outcome !== 'qa_rejected');
        }
        if (outcome === 'resumed') {
            expect(stages).not.toContain('story');
            expect(stages).not.toContain('story-repair');
            expect(result.enhancement.generationLogs.find(row => row.stage === 'story').source).toContain('story-qa-constraint-repair-response.json');
        }
        const saved = JSON.parse(fs.readFileSync(path.join(dir, 'temp', 'clip-creative', 'story-input.json'), 'utf8'));
        expect(saved.protectedCues[0].cueIds).toEqual(['C1', 'C2', 'C3']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
