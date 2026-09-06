const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const releaseDir = process.env.DANMAKU_WORKFLOW_RELEASE
    || JSON.parse(fs.readFileSync(path.join(root, 'build/workflow-candidate.json'), 'utf8')).releaseDir;
const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, 'manifest.json'), 'utf8'));
const responses = require(path.join(releaseDir, manifest.entries['text/response']));
const requests = require(path.join(releaseDir, manifest.entries['text/requests']));
const diagnostics = require(path.join(releaseDir, manifest.entries['summary/diagnostics']));

test('compiled text adapters handle chat/responses and usage aliases', () => {
    assert.equal(responses.extractOpenAITextResponse({ output: [{ content: [{ type: 'output_text', text: 'Good night' }] }] }), 'Good night');
    assert.equal(responses.extractOpenAITextResponse({ choices: [{ message: { content: [{ type: 'text', text: { value: 'Reply' } }] } }] }), 'Reply');
    assert.equal(responses.getOpenAITextFinishReason({ incomplete_details: { reason: 'max_output_tokens' } }), 'max_output_tokens');
    const usage = responses.getPromptTokenUsage({ input_tokens: '100', input_tokens_details: { cached_tokens: 60 } });
    const metrics = responses.buildAiUsageMetrics(usage);
    assert.equal(metrics.uncachedPromptTokens, 40);
    assert.equal(metrics.cacheHitRatio, 0.6);
    assert.equal(responses.buildAiUsageMetrics().cacheHitRatio, null);
});

test('compiled request builders preserve explicit caching and reasoning', () => {
    const options = { model: 'model', prompt: 'prefixsuffix', maxTokens: 100, thinkingEnabled: true,
        reasoningEffort: 'high', cachePlan: { enabled: true, prefix: 'prefix', suffix: 'suffix', requestKey: 'cache', ttl: '30m' } };
    const chat = requests.buildDaiYuChatCompletionsRequest({ ...options, thinkingBudgetTokens: 50 });
    assert.deepEqual(chat.thinking, { type: 'enabled', budget_tokens: 50 });
    assert.deepEqual(chat.messages[1].content[0].prompt_cache_breakpoint, { mode: 'explicit' });
    const response = requests.buildDaiYuResponsesRequest(options);
    assert.deepEqual(response.reasoning, { effort: 'high' });
    assert.equal(response.prompt_cache_key, 'cache');
    assert.equal(response.input[0].content[0].prompt_cache_breakpoint, undefined);
});

test('compiled ASR timings retain the machine-readable sentinel and emotion fields', () => {
    const output = [];
    const original = console.log;
    try {
        console.log = text => output.push(text);
        const summary = diagnostics.logAsrTimings({ asr_inference_s: 10, emotion_model_load_s: 1, emotion_inference_s: 2, emotion_total_s: 3 }, 100);
        assert.equal(summary.trueAsrSpeed, 10);
        assert.equal(summary.emotionTotalSeconds, 3);
        assert.deepEqual(JSON.parse(output[1].replace('[[ASR_TIMING]] ', '')), summary);
    } finally {
        console.log = original;
    }
});

for (const cli of ['ai_text_generator.js', 'enhanced_auto_summary.js']) {
    test(`${cli} starts against only its packaged release without source TS or dev dependencies`, () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-release-'));
        try {
            fs.copyFileSync(path.join(root, 'src/scripts', cli), path.join(directory, cli));
            fs.copyFileSync(path.join(root, 'src/scripts/workflow-runtime.js'), path.join(directory, 'workflow-runtime.js'));
            fs.cpSync(releaseDir, path.join(directory, 'release'), { recursive: true });
            const result = spawnSync(process.execPath, ['--no-experimental-strip-types', path.join(directory, cli), '--check-runtime'], {
                cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 10000,
                env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', DANMAKU_WORKFLOW_RELEASE: path.join(directory, 'release') }
            });
            assert.equal(result.status, 0, result.stderr);
            assert.deepEqual(JSON.parse(result.stdout).entries, Object.keys(manifest.entries));
        } finally { fs.rmSync(directory, { recursive: true, force: true }); }
    });
}

test('the bridge refuses a damaged or incomplete release before loading any module', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-integrity-'));
    try {
        fs.cpSync(releaseDir, directory, { recursive: true });
        fs.appendFileSync(path.join(directory, manifest.entries['text/response']), '\n// changed');
        const result = spawnSync(process.execPath, ['-e', 'require(process.argv[1]).checkRuntime()', path.join(root, 'src/scripts/workflow-runtime.js')], {
            encoding: 'utf8', windowsHide: true, timeout: 10000,
            env: { ...process.env, DANMAKU_WORKFLOW_RELEASE: directory }
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /integrity mismatch/);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
