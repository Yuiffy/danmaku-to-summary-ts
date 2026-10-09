import { subtitleRepairEligible, planSubtitleProbes, consensusSubtitleEdit, applyConsensusEdits,
    projectSubtitleRepairEvidence } from './ownSubtitleRepair';
import type { Artifact } from './enhancement';

const text = '线下问路我就没有这种被凶的预气所以很无所谓很自信';
const artifact = { mode: 'own_stream_fun_review', uploadReady: true, window: { start: 100, end: 120, duration: 20 },
    output: { burnedSubtitles: true }, publicationReview: { status: 'needs_review', technical: { passed: true },
        checks: { content: true, attribution: true, subtitles: false, visuals: true, policy: true },
        issues: ['字幕“没有这种被凶的预气”中的“预气”需核原音'] } } as Artifact;
const cues = [{ start: 6, end: 8, text }, { start: 14, end: 16, text: '别的句子' }];
const probe = planSubtitleProbes(artifact, cues)[0];
const decoded = (word: string) => ({ id: probe.id, start: probe.start, end: probe.end,
    decodes: ['nano', 'sensevoice'].map(model => ({ model, text: text.replace('预气', word), prompted: false, hotwords: [], useItn: false })) });

test('only subtitle defects qualify, and quoted probes stay local to the exact cue', () => {
    expect(subtitleRepairEligible(artifact)).toBe(true);
    expect(planSubtitleProbes(artifact, cues)).toEqual([expect.objectContaining({ index: 0, quote: '预气', start: 101, end: 113 })]);
    for (const change of [{ editPlan: {} }, { renderedSubtitles: {} }, { humanReview: {} }, { preRenderHold: true },
        { publicCopyPending: true }, { sourceExpansionRequest: {} }, { subtitleProofreading: { reviewGroups: [{}] } }]) {
        expect(subtitleRepairEligible({ ...artifact, ...change })).toBe(false);
    }
    expect(subtitleRepairEligible({ ...artifact, publicationReview: { ...artifact.publicationReview,
        checks: { ...artifact.publicationReview.checks, policy: false } } })).toBe(false);
    expect(planSubtitleProbes({ ...artifact, publicationReview: { ...artifact.publicationReview, issues: ['字幕似乎不对'] } }, cues)).toEqual([]);
});

test('two unprompted independent models must agree, with unique context and no ITN', () => {
    const edit = consensusSubtitleEdit(probe, decoded('预期'));
    expect(edit).toMatchObject({ index: 0, from: '预气', to: '预期', confirmed: true });
    const corrected = applyConsensusEdits(cues, [edit!]);
    expect(corrected).toEqual([{ ...cues[0], text: text.replace('预气', '预期') }, cues[1]]);
    expect(cues[0].text).toBe(text);
    for (const type of ['disagree', 'same_model', 'prompted', 'itn', 'wrong_window', 'repeated_context']) {
        const row = decoded('预期');
        if (type === 'disagree') row.decodes[1].text = text;
        if (type === 'same_model') row.decodes[1].model = 'nano';
        if (type === 'prompted') row.decodes[1].prompted = true;
        if (type === 'itn') row.decodes[1].useItn = true;
        if (type === 'wrong_window') row.start++;
        if (type === 'repeated_context') row.decodes.forEach(item => { item.text += item.text; });
        expect(consensusSubtitleEdit(probe, row)).toBeNull();
    }
});

test('visible word errors can request local audio even when also classified as visuals, while layout defects cannot', () => {
    const a = { ...artifact, publicationReview: { ...artifact.publicationReview,
        checks: { ...artifact.publicationReview.checks, visuals: false }, issues: ['字幕“信爵/星绝死囚了”需核实原词', 'final_visuals_not_passed', 'final_subtitles_not_passed'] } };
    expect(subtitleRepairEligible(a)).toBe(true);
    expect(planSubtitleProbes(a, [{ start: 1, end: 3, text: '信爵活没活着呀' }, { start: 4, end: 6, text: '星绝死囚了' }]))
        .toEqual([expect.objectContaining({ quote: '信爵' }), expect.objectContaining({ quote: '星绝死囚了' })]);
    for (const issue of ['字幕“信爵”与音轨错位', '字幕“信爵”被封面遮挡', '画面需要核对']) {
        expect(subtitleRepairEligible({ ...a, publicationReview: { ...a.publicationReview, issues: [issue] } })).toBe(false);
    }
});

test('numeric, negative, identity and configured-name changes cannot be adopted', () => {
    for (const [from, to] of [['三套', '五套'], ['要去', '不去'], ['爸爸', '妈妈'], ['他会', '她会'], ['岁吉', '岁己']]) {
        const context = '昨天在直播说到了' + from + '所以我们继续聊下去';
        const p = { ...probe, context, quote: from };
        const row = { ...decoded('预期'), decodes: decoded('预期').decodes.map(item => ({ ...item, text: context.replace(from, to) })) };
        expect(consensusSubtitleEdit(p, row, ['岁己'])).toBeNull();
    }
    expect(consensusSubtitleEdit(probe, decoded('预气'))).toMatchObject({ from: '预气', to: '预气', confirmed: true });
});

test('unique local anchors resolve the suspect word without requiring a separate neighboring ASR error to match', () => {
    const context = '如果能只带一个行李箱就能赚够的话就得装够所有会用的东西的话那还是会考虑的';
    const p = { ...probe, quote: '赚够', context };
    const row = decoded('预期');
    row.decodes[0].text = context.replace('赚够', '装够').replace('就得', '就能');
    row.decodes[1].text = context.replace('赚够', '装够');
    expect(consensusSubtitleEdit(p, row)).toMatchObject({ from: '赚够', to: '装够' });
    const confirmation = { ...p, quote: '装够所有会用的东西' };
    expect(consensusSubtitleEdit(confirmation, row)).toMatchObject({ from: confirmation.quote, to: confirmation.quote });
    row.decodes[1].text = row.decodes[1].text.replace('装够的话', '装够然后');
    expect(consensusSubtitleEdit(p, row)).toBeNull();
});

test('a cue-boundary quote needs a unique six-character anchor and the same actual transcript boundary', () => {
    const context = '就得装够所有会用的东西的话', p = { ...probe, quote: '就得装够', context };
    const row = { ...decoded('预期'), decodes: decoded('预期').decodes.map(item => ({ ...item, text: context.replace('就得', '就能') })) };
    expect(consensusSubtitleEdit(p, row)).toMatchObject({ from: '就得装够', to: '就能装够' });
    row.decodes[1].text = '也许' + row.decodes[1].text;
    expect(consensusSubtitleEdit(p, row)).toBeNull();
    const narrow = planSubtitleProbes({ ...artifact, publicationReview: { ...artifact.publicationReview, issues: ['字幕“预气”需核对'] } }, cues, .25);
    expect(narrow).toEqual([expect.objectContaining({ start: 105.75, end: 108.25 })]);
});

test('a comparison ASR alternative is not miscounted as a second problematic cue', () => {
    const current = { ...artifact, publicationReview: { ...artifact.publicationReview,
        issues: ['“就得装够”与“就能装够”识别不一致，关键措辞未确认。'] } };
    const rows = [{ start: 6, end: 8, text: '如果只带行李箱就能装够的话' }, { start: 14, end: 16, text: '就得装够所有会用的东西的话' }];
    expect(planSubtitleProbes(current, rows, .25)).toEqual([expect.objectContaining({ index: 1, quote: '就得装够', start: 113.75, end: 116.25 })]);
});

test('a long suspect cue keeps its full audio by reducing padding within the thirty-second limit', () => {
    const current={...artifact,window:{start:100,end:180,duration:80},publicationReview:{...artifact.publicationReview,issues:['字幕“疑句”需要核对']}};
    const [probe]=planSubtitleProbes(current,[{start:20,end:47,text:'嗯嗯疑句'}]);
    expect(probe).toMatchObject({start:118.5,end:148.5,quote:'疑句'});
    expect(planSubtitleProbes(current,[{start:20,end:51,text:'嗯嗯疑句'}])).toEqual([]);
});

test('source-only rebuilt subtitles permit diagnosis while manual subtitle revisions stay protected', () => {
    expect(subtitleRepairEligible({...artifact,renderedSubtitles:{revision:0,edits:[]}})).toBe(true);
    for(const renderedSubtitles of [{revision:1,edits:[]},{revision:0,edits:[{from:'词',to:'字'}]},{}]) {
        expect(subtitleRepairEligible({...artifact,renderedSubtitles})).toBe(false);
    }
});

test('source projection retains G IDs, grouping and voice rows without mutating the source evidence', () => {
    const voice = { status: 'row_supported', label: '小岁' };
    const item = { start: 106, end: 108, text, speakerEvidence: voice };
    const evidence = { sourceSha256: 'original', cues: [{ id: 'G7', start: 106, end: 108, text, items: [item] }] };
    const repair = { ...artifact, automaticSubtitleRepair: { edits: [{ index: 0, from: '预气', to: '预期', sourceStart: 106, sourceEnd: 108 }] } };
    const projected = projectSubtitleRepairEvidence(evidence, repair);
    expect(projected.sourceSha256).toBe('original');
    expect(projected.byId.get('G7').items[0].speakerEvidence).toBe(voice);
    expect(projected.cues[0].text).toContain('预期');
    expect(evidence.cues[0].text).toBe(text);
    expect(() => projectSubtitleRepairEvidence(evidence, { ...repair, automaticSubtitleRepair: {
        edits: [{ from: '预气', to: '预期', sourceStart: 107, sourceEnd: 108 }] } })).toThrow('no matching source');
});
