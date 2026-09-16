export {};
const fs = require('fs'), os = require('os'), path = require('path');
const { classifyGeneratedOutput, assertGeneratedOutput } = require('./generated_output');
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
