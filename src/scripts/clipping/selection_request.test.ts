const fs = require('fs');
const os = require('os');
const path = require('path');
const generator = require('../ai_text_generator');
const { requestSelectionText, validSelectionResponse } = require('./selection_request');
const { buildSubtitleEvidence } = require('./subtitle_evidence');

describe('selection usage accounting', () => {
  test('retains failed request diagnostics and known subtotals without replacing unknown totals with zero', async () => {
    const failure = Object.assign(new Error('Request failed'), { attempts: [
      { provider: 'daiYu', model: 'same-model', status: 'failure', requestStarted: true, usageUnknown: true, requestId: 'unknown-use' },
      { provider: 'daiYu', model: 'same-model', status: 'failure', requestStarted: true, usageUnknown: false,
        requestId: 'known-use', promptTokens: 100, completionTokens: 25 }
    ] });
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockRejectedValue(failure);
    const diagnostics = {};
    try {
      await expect(requestSelectionText('Source.', {}, {}, { ai: { text: { provider: 'daiYu' } } }, {}, 'rerank', diagnostics, () => true))
        .rejects.toBe(failure);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(diagnostics.requests).toHaveLength(1);
      expect(diagnostics.requests[0]).toMatchObject({ status: 'failure', requestCount: 2, usageUnknown: true,
        promptTokens: null, completionTokens: null, knownUsage: { promptTokens: 100, completionTokens: 25 }, attempts: failure.attempts });
    } finally { generate.mockRestore(); }
  });

  test('success after a measured failed attempt counts both attempts', async () => {
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: 'valid', meta: { model: 'same-model', attempts: [
      { provider: 'daiYu', status: 'failure', requestStarted: true, promptTokens: 50, completionTokens: 5 },
      { provider: 'tuZi', status: 'success', requestStarted: true, promptTokens: 100, completionTokens: 10 }
    ] } });
    const diagnostics = {};
    try {
      await requestSelectionText('Source.', {}, {}, { ai: { text: { provider: 'daiYu' } } }, {}, 'rerank', diagnostics, () => true);
      expect(diagnostics.requests[0]).toMatchObject({ status: 'success', requestCount: 2, usageUnknown: false,
        promptTokens: 150, completionTokens: 15, provider: 'tuZi' });
    } finally { generate.mockRestore(); }
  });

  test('a joined failed request is accounted to its owner once, and the original error is not mutated', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-joined-failure-'));
    const failure = Object.assign(new Error('Rejected final text'), { attempts: [
      { provider: 'daiYu', status: 'failure', requestStarted: true, usageUnknown: false, requestId: 'one-http', promptTokens: 100, completionTokens: 25 }
    ] });
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockRejectedValue(failure);
    const diagnostics = {};
    const request = () => requestSelectionText('Source.', {}, {}, { ai: { text: { provider: 'daiYu' } } },
      { selectionCacheDirectory: directory }, 'rerank', diagnostics, () => true);
    try {
      const results = await Promise.allSettled([request(), request()]);
      expect(results.every(result => result.status === 'rejected')).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(failure).not.toHaveProperty('selectionCache');
      expect(diagnostics.requests.filter(row => row.joinedRequest)).toHaveLength(1);
      expect(diagnostics.requests.reduce((sum, row) => sum + row.promptTokens, 0)).toBe(100);
      expect(diagnostics.requests.reduce((sum, row) => sum + row.requestCount, 0)).toBe(1);
      const joined = diagnostics.requests.find(row => row.joinedRequest);
      expect(joined).toMatchObject({ status: 'failure', cacheHit: false, promptTokens: 0, requestCount: 0,
        reusedGeneration: { requestCount: 1, promptTokens: 100, completionTokens: 25 } });
      await expect(request()).rejects.toBe(failure);
      expect(generate).toHaveBeenCalledTimes(2);
      expect(diagnostics.requests.reduce((sum, row) => sum + row.promptTokens, 0)).toBe(200);
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('joined incomplete results are rejected without caching or counting the same usage twice', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-joined-incomplete-'));
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: 'valid looking text', meta: {
      finishReason: 'incomplete', attempts: [{ status: 'success', requestStarted: true, promptTokens: 100, completionTokens: 25 }]
    } });
    const diagnostics = {};
    const request = () => requestSelectionText('Source.', {}, {}, { ai: { text: { provider: 'daiYu' } } },
      { selectionCacheDirectory: directory }, 'rerank', diagnostics, () => true);
    try {
      const results = await Promise.allSettled([request(), request()]);
      expect(results.every(result => result.status === 'rejected')).toBe(true);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(diagnostics.requests.reduce((sum, row) => sum + row.promptTokens, 0)).toBe(100);
      expect(diagnostics.requests.reduce((sum, row) => sum + row.requestCount, 0)).toBe(1);
      expect(diagnostics.requests.every(row => row.status === 'failure')).toBe(true);
      expect(fs.readdirSync(directory).filter(name => name !== '.attempt-outcomes')).toEqual([]);
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('routing hints and transport retry limits reuse the existing semantic result cache', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-static-route-'));
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: 'valid', meta: {} });
    const prompt = 'Stable rules.\nSource facts.';
    const request = options => requestSelectionText(prompt, { primaryModel: 'same-model', ...options }, {},
      { ai: { text: { provider: 'daiYu' } } }, { selectionCacheDirectory: directory }, 'recall', {}, r => r.text === 'valid');
    try {
      await request({});
      await request({ staticPromptCachePrefix: 'Stable rules.\n' });
      await request({ staticPromptCachePrefix: 'Stable' });
      await request({ daiYuTransientMaxAttempts: 2 });
      await request({ daiYuTransientMaxAttempts: 3 });
      expect(generate).toHaveBeenCalledTimes(1);
      await request({ staticPromptCachePrefix: 'Stable rules.\n', reasoningEffort: 'high' });
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[1][1].staticPromptCachePrefix).toBe('Stable rules.\n');
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('invalidates stage output when the actual request protocol changes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-protocol-'));
    const originalVersion = generator.TEXT_REQUEST_PROTOCOL_VERSION;
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: 'valid', meta: {} });
    const request = () => requestSelectionText('source', {}, {}, { ai: { text: { provider: 'daiYu' } } },
      { selectionCacheDirectory: directory }, 'recall', null, r => r.text === 'valid');
    try {
      await request(); await request();
      expect(generate).toHaveBeenCalledTimes(1);
      generator.TEXT_REQUEST_PROTOCOL_VERSION = (originalVersion || 1) + 1;
      await request();
      expect(generate).toHaveBeenCalledTimes(2);
    } finally {
      generator.TEXT_REQUEST_PROTOCOL_VERSION = originalVersion;
      generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(['object', 'array'])('validates chunk audience references against both the supplied table and clip time (%s)', shape => {
    const source = buildSubtitleEvidence([{ start: 0, end: 60, text: 'A story.' }]);
    const comments = [{ time: 20, text: 'A reaction.' }, { time: 70, text: 'A later reaction.' }];
    const clip = { startCueId: 'G1', endCueId: 'G1', event: 'An incident', evidenceCueIds: ['G1'],
      evidenceDanmakuIds: ['D1'], sourceKind: 'live_speech' };
    const config = { minClipSeconds: 1, maxClipSeconds: 90 };
    const response = value => ({ text: JSON.stringify(shape === 'array' ? [value] : { clips: [value] }) });
    expect(validSelectionResponse(response(clip), source, null, config, new Set(['G1']), comments, new Set(['D1']))).toBe(true);
    expect(validSelectionResponse(response(clip), source, null, config, new Set(['G1']), comments, new Set())).toBe(false);
    expect(validSelectionResponse(response({ ...clip, evidenceDanmakuIds: ['D2'] }), source, null, config,
      new Set(['G1']), comments, new Set(['D2']))).toBe(false);
  });

  test('counts a generated request once across joined consumers and persisted cache hits', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-usage-'));
    const generate = jest.spyOn(generator, 'generateTextWithDaiYu').mockResolvedValue({ text: 'valid', meta: {
      model: 'same-model', attempts: [{ requestId: 'req-original', responseId: 'resp-original',
        promptTokens: 1000, cachedTokens: 100, completionTokens: 70, reasoningTokens: 30 }]
    } });
    const diagnostics = {};
    const request = () => requestSelectionText('source', { primaryModel: 'same-model' }, {},
      { ai: { text: { provider: 'daiYu' } } }, { selectionCacheDirectory: directory }, 'recall', diagnostics, r => r.text === 'valid');
    try {
      await Promise.all([request(), request()]);
      await request();
      expect(generate).toHaveBeenCalledTimes(1);
      expect(diagnostics.requests).toHaveLength(3);
      const fresh = diagnostics.requests.filter(r => !r.cacheHit);
      const reused = diagnostics.requests.filter(r => r.cacheHit);
      expect(fresh).toHaveLength(1);
      expect(reused).toHaveLength(2);
      expect(diagnostics.requests.reduce((sum, r) => sum + r.promptTokens, 0)).toBe(1000);
      reused.forEach(row => expect(row).toMatchObject({
        requestId: null, responseId: null, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0,
        reusedGeneration: { requestId: 'req-original', responseId: 'resp-original', promptTokens: 1000 }
      }));
    } finally { generate.mockRestore(); fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
