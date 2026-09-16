'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseModelJson } = require('../workflow-runtime').loadWorkflow('text/response');
const RULES = [
    ['claude_identity', /I'm Claude/i], ['anthropic_identity', /Anthropic/i],
    ['english_refusal', /I (?:can't|cannot) (?:complete|comply|help|assist)/i],
    ['chinese_refusal', /我不能(?:完成|协助|帮助|满足)/], ['request_refusal', /无法(?:完成|协助|满足)这个请求/],
    ['ai_identity', /作为(?:一个)?AI(?:语言)?模型/], ['system_prompt_zh', /系统提示/], ['system_prompt_en', /system prompt/i]
];
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function classifyGeneratedOutput(text, options = {}, data = {}) {
    const matches = RULES.filter(([, pattern]) => pattern.test(String(text || ''))).map(([id]) => id);
    const explicit = (Array.isArray(data.choices) ? data.choices : []).some(choice => choice.message?.refusal)
        || (Array.isArray(data.output) ? data.output : []).some(item => (Array.isArray(item.content) ? item.content : []).some(part => part.type === 'refusal'));
    if (explicit) return { rejected: true, reason: 'provider_refusal', matches };
    if (options.structuredOutputKey) {
        let parsed;
        try { parsed = parseModelJson(text); } catch {
            const first = String(text || '').indexOf('{'), last = String(text || '').lastIndexOf('}');
            if (first < 0 || last < first) return { rejected: true, reason: 'invalid_structured_json', matches };
            if (RULES.some(([, rule]) => rule.test(String(text).slice(0, first)))) return { rejected: true, reason: 'refusal_preamble', matches };
            try { parsed = parseModelJson(String(text).slice(first, last + 1)); }
            catch { return { rejected: true, reason: 'invalid_structured_json', matches }; }
        }
        if (parsed?.refusal || parsed?.error || ['refused', 'rejected'].includes(parsed?.status)) return { rejected: true, reason: 'structured_refusal', matches };
        const rows = options.structuredOutputKey === 'clips' && Array.isArray(parsed) ? parsed : parsed?.[options.structuredOutputKey], type = options.structuredOutputType || 'records';
        const valid = type === 'boolean' ? typeof rows === 'boolean' : type === 'number' ? Number.isFinite(rows)
            : Array.isArray(rows) && rows.every(row => type === 'strings' ? typeof row === 'string' : row && typeof row === 'object' && !Array.isArray(row));
        if (!valid) {
            return { rejected: true, reason: 'unexpected_structured_shape', matches };
        }
        // Valid structured data may quote a refusal or discuss prompts. Domain validators still check every claim and citation.
        return { rejected: false, reason: matches.length ? 'keywords_inside_structured_data' : 'structured_output', matches };
    }
    return { rejected: matches.length > 0, reason: matches.length ? 'reply_refusal_or_identity' : 'reply', matches };
}

function assertGeneratedOutput(text, options = {}, data = {}, context = {}) {
    const result = classifyGeneratedOutput(text, options, data);
    if (!result.rejected) return result;
    const error = new Error(`Generated output rejected: ${result.reason}${result.matches.length ? ` (${result.matches.join(',')})` : ''}`);
    error.outputRejection = result;
    if (options.responseDiagnosticsDirectory) {
        try {
            fs.mkdirSync(options.responseDiagnosticsDirectory, { recursive: true });
            const file = path.join(options.responseDiagnosticsDirectory, `${Date.now()}-${crypto.randomUUID()}.json`);
            fs.writeFileSync(file, JSON.stringify({ version: 1, at: new Date().toISOString(), ...context,
                phase: options.requestPhase || null, structuredOutputKey: options.structuredOutputKey || null,
                rejection: result, textSha256: sha(String(text || '')), text: text || '',
                response: { id: data.id, model: data.model, status: data.status, output: data.output,
                    choices: data.choices, output_text: data.output_text, usage: data.usage, incomplete_details: data.incomplete_details } }, null, 2), { encoding: 'utf8', flag: 'wx' });
            error.rejectionDiagnosticPath = file;
            console.warn(`[TEXT_REJECTION] ${JSON.stringify({ reason: result.reason, matches: result.matches, path: file })}`);
        } catch (failure) { error.rejectionDiagnosticError = failure.message; }
    }
    throw error;
}
function stageOutputContract(phase) {
    if (/^precision-experiment-selection/.test(phase)) return { key: 'selected', type: 'records' };
    if (/^edit-/.test(phase)) return { key: 'removeEvidenceIds', type: 'strings' };
    if (/^packaging-/.test(phase)) return { key: 'variants', type: 'records' };
    if (/^cover-/.test(phase)) return { key: 'selectedIndex', type: 'number' };
    if (/^qa-/.test(phase)) return { key: 'approved', type: 'boolean' };
    if (/^attribution-/.test(phase)) return { key: 'reviews', type: 'records' };
    return null;
}
module.exports = { classifyGeneratedOutput, assertGeneratedOutput, stageOutputContract };
