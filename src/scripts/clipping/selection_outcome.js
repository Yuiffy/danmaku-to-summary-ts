'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const ERROR_FIELDS = ['code', 'status', 'statusCode', 'outcomeUnknown', 'requestStarted', 'requestId', 'responseId', 'usageFinal', 'attempts'];

function outcomePath(cacheFile, generationId) {
    if (!UUID.test(String(generationId || ''))) return null;
    return path.join(path.dirname(cacheFile), '.attempt-outcomes', `${generationId}.json`);
}

function serializeGenerationError(error) {
    return { name: error?.name || 'Error', message: String(error?.message || error),
        ...Object.fromEntries(ERROR_FIELDS.filter(field => error?.[field] !== undefined).map(field => [field, error[field]])) };
}

function publishGenerationOutcome(cacheFile, generationId, outcome, log = console.warn) {
    const file = outcomePath(cacheFile, generationId);
    if (!file) return;
    const directory = path.dirname(file);
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ version: 1, cacheKey: path.basename(cacheFile), generationId,
            createdAt: Date.now(), ...outcome }), 'utf8');
        fs.renameSync(temporary, file);
        for (const name of fs.readdirSync(directory)) {
            if (!name.endsWith('.json') || !UUID.test(name.slice(0, -5))) continue;
            const candidate = path.join(directory, name);
            try {
                if (Date.now() - fs.statSync(candidate).mtimeMs > RETENTION_MS) fs.unlinkSync(candidate);
            } catch { /* Another process may already have removed the expired record. */ }
        }
    } catch (error) {
        log(`Selection attempt outcome unavailable: ${error.message}`);
    } finally {
        try { fs.unlinkSync(temporary); } catch { /* already renamed */ }
    }
}

function readGenerationOutcome(cacheFile, generationId) {
    const file = outcomePath(cacheFile, generationId);
    if (!file) return null;
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value.version !== 1 || value.cacheKey !== path.basename(cacheFile) || value.generationId !== generationId) return null;
        if (value.kind === 'failure' && typeof value.error?.message === 'string') return value;
        if (value.kind === 'result' && value.result && typeof value.result === 'object') return value;
    } catch { /* A live owner may not have published its terminal outcome yet. */ }
    return null;
}

function consumeGenerationOutcome(outcome, key, generationId) {
    const selectionCache = { hit: false, joined: true, key, generationId: generationId || null };
    if (outcome?.kind === 'result') {
        const result = outcome.result;
        return { ...result, meta: { ...result.meta, selectionCache: { ...selectionCache, hit: true } } };
    }
    const data = outcome?.error || { message: 'Joined selection request ended without a recoverable outcome',
        code: 'SELECTION_OUTCOME_UNKNOWN', outcomeUnknown: true, attempts: [] };
    const error = new Error(data.message);
    error.name = data.name || 'Error';
    for (const field of ERROR_FIELDS) if (data[field] !== undefined) error[field] = data[field];
    error.selectionCache = selectionCache;
    throw error;
}

module.exports = { publishGenerationOutcome, readGenerationOutcome, consumeGenerationOutcome, serializeGenerationError };
