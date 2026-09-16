'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SHARED_PROMPT_CACHE_START, SHARED_PROMPT_CACHE_END } = require('../live_generation_context');

const VERSION = 1;
const TTL_MS = 25 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const DIRECTORY = path.resolve(__dirname, '../../..', 'data/runtime/live-text-cache');
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function identity(body, config) {
    if (config.ai?.text?.sharedPromptCache?.continuationEnabled !== true
        || config.ai.text.sharedPromptCache.enabled === false || !/^gpt-5\.6(?:[.-]|$)/u.test(body?.model || '')
        || body.input?.length !== 1 || body.input[0].role !== 'user' || body.tools
        || !body.instructions || !Array.isArray(body.input[0].content)
        || body.input[0].content.some(p => p.type !== 'input_text' || typeof p.text !== 'string')) return null;
    const [source, ...task] = body.input[0].content;
    if (!source?.text.startsWith(SHARED_PROMPT_CACHE_START) || !source.text.endsWith(SHARED_PROMPT_CACHE_END)
        || !task.length) return null;
    return { source: source.text, task, key: sha({ version: VERSION, source: source.text,
        endpoint: config.ai.text.daiYu?.baseUrl, model: body.model, instructions: body.instructions,
        text: body.text, reasoning: body.reasoning, temperature: body.temperature,
        cacheKey: body.prompt_cache_key, cacheOptions: body.prompt_cache_options }) };
}

function validMessages(messages) {
    return Array.isArray(messages) && messages.length > 0 && messages.length <= 4
        && messages.every(m => m.type === 'message' && m.role === 'assistant' && m.status === 'completed'
            && Array.isArray(m.content) && m.content.length > 0
            && m.content.every(p => p.type === 'output_text' && typeof p.text === 'string'));
}

function captureSeed(body, response, config) {
    const context = identity(body, config);
    if (!context || response?.status !== 'completed' || response.model !== body.model) return null;
    const messages = Array.isArray(response.output) ? response.output.filter(item => item.type === 'message') : null;
    if (!validMessages(messages)) return null;
    const value = { version: VERSION, key: context.key, createdAt: Date.now(), body, messages };
    if (Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) return null;
    // Keep this out of public generation metadata and usage logs. The caller
    // must explicitly accept it after its factual/output checks succeed.
    return JSON.parse(JSON.stringify({ ...value, checksum: sha(value) }));
}

function validateSeed(seed, config, key, now) {
    if (!seed || seed.version !== VERSION || seed.key !== key || !Number.isFinite(seed.createdAt)
        || seed.createdAt > now || now - seed.createdAt >= TTL_MS || !validMessages(seed.messages)) return false;
    const { checksum, ...value } = seed;
    return checksum === sha(value) && identity(seed.body, config)?.key === key;
}

function prepareContinuation(body, config, { directory = DIRECTORY, now = Date.now() } = {}) {
    const context = identity(body, config);
    if (!context) return body;
    try {
        const file = path.join(directory, `${context.key}.json`);
        if (fs.statSync(file).size > MAX_BYTES) return body;
        const seed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!validateSeed(seed, config, context.key, now)) return body;
        return { ...body, input: [...seed.body.input, ...seed.messages, { role: 'user', content: [
            { type: 'input_text', text: 'The previous generated answer is conversation history, NOT original evidence. '
                + 'Use the complete original live source for the NEW task below. Never inherit unsupported details from the earlier draft. '
                + 'The current task and its reviewed activity constraints supersede the earlier draft. '
                + 'Preserve uncertainty and speaker attribution; do not treat anonymous speakers or game dialogue as the host.' },
            ...context.task
        ] }] };
    } catch { return body; }
}

function acceptSeed(seed, config, { directory = DIRECTORY, now = Date.now() } = {}) {
    if (!seed || !validateSeed(seed, config, seed.key, now)) return false;
    let temporary;
    try {
        fs.mkdirSync(directory, { recursive: true });
        // Only this module's disposable cache files are eligible for cleanup.
        for (const name of fs.readdirSync(directory).filter(n => /^[a-f0-9]{64}\.json$/u.test(n))) {
            const file = path.join(directory, name);
            try { if (now - fs.statSync(file).mtimeMs >= TTL_MS) fs.unlinkSync(file); } catch { /* Another process may own it now. */ }
        }
        temporary = path.join(directory, `${seed.key}.${crypto.randomUUID()}.tmp`);
        fs.writeFileSync(temporary, JSON.stringify(seed), 'utf8');
        fs.renameSync(temporary, path.join(directory, `${seed.key}.json`));
        return true;
    } catch (error) {
        console.warn(`[LIVE_TEXT_CACHE] Could not save accepted context: ${error.code || 'write_failed'}`);
        return false;
    } finally {
        if (temporary) { try { fs.unlinkSync(temporary); } catch { /* Renamed or unavailable. */ } }
    }
}

module.exports = { VERSION, TTL_MS, captureSeed, prepareContinuation, acceptSeed };
