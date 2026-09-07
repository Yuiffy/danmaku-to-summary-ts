'use strict';

const fs = require('fs');
const [directory, role, mode] = process.argv.slice(2);
const originalWatch = fs.watch;
fs.watch = function (...args) {
    const watcher = originalWatch.apply(this, args);
    process.send({ event: 'waiting' });
    return watcher;
};
const originalRename = fs.renameSync;
fs.renameSync = function (from, to) {
    if (role === 'owner' && (mode === 'missing-outcome'
        || (mode === 'cache-write-failed' && !String(to).includes('.attempt-outcomes')))) {
        throw Object.assign(new Error('Synthetic write failure'), { code: 'EIO' });
    }
    return originalRename.call(this, from, to);
};
const generator = require('../../src/scripts/ai_text_generator');
const { requestSelectionText } = require('../../src/scripts/clipping/selection_request');
const released = new Promise(resolve => process.once('message', resolve));
generator.generateTextWithDaiYu = async () => {
    process.send({ event: 'generated' });
    if (role === 'owner') await released;
    const pending = mode === 'pending';
    const attempts = [{ status: 'success', requestStarted: true, promptTokens: 100, completionTokens: 25,
        requestId: 'synthetic-http', responseId: 'synthetic-response', provider: 'daiYu', model: 'synthetic',
        usageFinal: !pending, usageUnknown: pending }];
    if (role === 'owner' && ['failure', 'pending', 'missing-outcome'].includes(mode)) {
        attempts[0].status = 'failure';
        if (pending) attempts[0].outcomeUnknown = true;
        throw Object.assign(new Error('Synthetic selection failure'), { code: 'SYNTHETIC_FAILURE', attempts, outcomeUnknown: pending });
    }
    return { text: role === 'owner' && mode === 'invalid' ? 'malformed' : 'valid', meta: {
        model: 'synthetic', attempts, finishReason: role === 'owner' && mode === 'incomplete' ? 'incomplete' : 'stop'
    } };
};
const diagnostics = {};
requestSelectionText('Synthetic public input.', { primaryModel: 'synthetic' }, {},
    { ai: { text: { provider: 'daiYu' } } }, { selectionCacheDirectory: directory }, 'recall', diagnostics, result => result.text === 'valid')
    .then(result => process.send({ event: 'resolved', result, diagnostics }), error => process.send({ event: 'rejected', diagnostics,
        error: { message: error.message, name: error.name, code: error.code, outcomeUnknown: error.outcomeUnknown,
            attempts: error.attempts, selectionCache: error.selectionCache } }))
    .finally(() => process.disconnect());
