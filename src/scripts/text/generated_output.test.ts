export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { classifyGeneratedOutput, assertGeneratedOutput, stageOutputContract } = require('./generated_output');

test.each(['curation', 'peer-cli'])('peer %s stages accept both positive and negative domain decisions', prefix => {
    for (const [phase, key] of [['assess-1', 'worthPublishing'], ['compare-1-BV1234567890', 'sameEvent']]) {
        const contract = stageOutputContract(`${prefix}-${phase}`);
        expect(contract).toEqual({ key, type: 'boolean' });
        const options = { structuredOutputKey: contract.key, structuredOutputType: contract.type };
        for (const value of [true, false]) expect(classifyGeneratedOutput(JSON.stringify({ [key]: value,
            reason: '明确的编辑判断', score: 90 }), options).rejected).toBe(false);
        expect(classifyGeneratedOutput(JSON.stringify({ [key]: 'true', reason: '错误结构' }), options).rejected).toBe(true);
        expect(classifyGeneratedOutput(JSON.stringify({ refusal: 'no', [key]: false }), options).rejected).toBe(true);
    }
});
test('structured quoted and internal text cannot trigger a whole-response refusal match', () => {
    const text = JSON.stringify({ clips: [{ title: '聊到提示词', reason: '讨论 system prompt 与 Anthropic', evidenceCueIds: ['G1'] }] });
    expect(classifyGeneratedOutput(text, { structuredOutputKey: 'clips' })).toMatchObject({ rejected: false, reason: 'keywords_inside_structured_data' });
    expect(classifyGeneratedOutput('作为AI模型，我不能帮助你')).toMatchObject({ rejected: true });
});
test.each(['我不能帮助你', '{"refusal":"我不能帮助你","clips":[]}', '{"error":"refused"}', '{"clips":"not an array"}'])('real refusal or wrong structured output is held: %s', text => {
    expect(classifyGeneratedOutput(text, { structuredOutputKey: 'clips' }).rejected).toBe(true);
});
test('explicit provider refusal cannot be concealed by an otherwise correct shape', () => {
    expect(classifyGeneratedOutput('{"clips":[]}', { structuredOutputKey: 'clips' },
        { output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] }).reason).toBe('provider_refusal');
});
test('a typed final-review object accepts approval and explicitly allowed domain rejection', () => {
    const options = { structuredOutputKey: 'checks', structuredOutputType: 'object' };
    const checks = { content: true, attribution: true, subtitles: true, visuals: true, policy: true };
    expect(classifyGeneratedOutput(JSON.stringify({ status: 'passed', checks, issues: [] }), options).rejected).toBe(false);
    const rejected = JSON.stringify({ status: 'rejected', checks: { ...checks, policy: false }, issues: ['涉及排除内容'] });
    expect(classifyGeneratedOutput(rejected, options).reason).toBe('structured_refusal');
    expect(classifyGeneratedOutput(rejected, { ...options, structuredOutputAllowDomainRejected: true }).rejected).toBe(false);
    expect(classifyGeneratedOutput('{"status":"rejected","clips":[]}', {
        structuredOutputKey: 'clips', structuredOutputAllowDomainRejected: true }).reason).toBe('structured_refusal');
});
test.each([null, [], 'true', true, 1])('object contracts reject invalid checks shape %s', checks => {
    expect(classifyGeneratedOutput(JSON.stringify({ status: 'passed', checks }), {
        structuredOutputKey: 'checks', structuredOutputType: 'object', structuredOutputAllowDomainRejected: true
    }).reason).toBe('unexpected_structured_shape');
});
test('domain rejection permission does not allow actual structured or provider refusals', () => {
    const options = { structuredOutputKey: 'checks', structuredOutputType: 'object', structuredOutputAllowDomainRejected: true };
    for (const extra of [{ refusal: 'no' }, { error: 'provider failed' }, { status: 'refused' }]) {
        expect(classifyGeneratedOutput(JSON.stringify({ checks: {}, ...extra }), options).reason).toBe('structured_refusal');
    }
    expect(classifyGeneratedOutput('{"status":"rejected","checks":{}}', options,
        { output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] }).reason).toBe('provider_refusal');
});
test('compatible JSON wrappers and bare clip arrays work without masking a refusal preamble', () => {
    expect(classifyGeneratedOutput('结果如下：\n{"clips":[{"reason":"system prompt"}]}', { structuredOutputKey: 'clips' }).rejected).toBe(false);
    expect(classifyGeneratedOutput('[{"title":"片段"}]', { structuredOutputKey: 'clips' }).rejected).toBe(false);
    expect(classifyGeneratedOutput('我不能帮助你。\n{"clips":[]}', { structuredOutputKey: 'clips' }).reason).toBe('refusal_preamble');
});
test('rejected raw response and match reason are saved with request identity without request credentials', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejected-text-'));
    try {
        let failure;
        try { assertGeneratedOutput('我不能帮助你', { structuredOutputKey: 'clips', responseDiagnosticsDirectory: dir,
            requestPhase: 'global-rank' }, { id: 'resp-one', status: 'completed', usage: { input_tokens: 100 } }, { requestId: 'req-one' }); }
        catch (error) { failure = error; }
        const record = JSON.parse(fs.readFileSync(failure.rejectionDiagnosticPath, 'utf8'));
        expect(record).toMatchObject({ text: '我不能帮助你', requestId: 'req-one', phase: 'global-rank',
            rejection: { reason: 'invalid_structured_json', matches: ['chinese_refusal'] }, response: { id: 'resp-one' } });
        expect(record).not.toHaveProperty('headers');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
