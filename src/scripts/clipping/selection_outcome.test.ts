const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { publishGenerationOutcome, readGenerationOutcome, consumeGenerationOutcome, serializeGenerationError } = require('./selection_outcome');

describe('selection attempt outcome journal', () => {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'selection-outcome-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  test('binds each record to the observed generation and stage cache key', () => {
    const file = path.join(directory, 'stage.json');
    const generationId = crypto.randomUUID();
    const result = { text: 'invalid but shared with current consumers', meta: { finishReason: 'incomplete' } };
    publishGenerationOutcome(file, generationId, { kind: 'result', result });
    expect(readGenerationOutcome(file, generationId).result).toEqual(result);
    expect(readGenerationOutcome(path.join(directory, 'different-stage.json'), generationId)).toBeNull();
    expect(readGenerationOutcome(file, crypto.randomUUID())).toBeNull();
    expect(readGenerationOutcome(file, '../other-file')).toBeNull();
    expect(consumeGenerationOutcome(readGenerationOutcome(file, generationId), 'key', generationId)).toMatchObject({
      text: result.text, meta: { selectionCache: { hit: true, joined: true, generationId } }
    });
  });

  test('serializes diagnostics but not arbitrary error properties, and does not mutate the original', () => {
    const failure = Object.assign(new Error('Failed'), { code: 'UPSTREAM', outcomeUnknown: true,
      attempts: [{ requestId: 'one', responseId: 'response', usageUnknown: true }], apiKey: 'must-not-serialize' });
    const serialized = serializeGenerationError(failure);
    expect(serialized).not.toHaveProperty('apiKey');
    expect(() => consumeGenerationOutcome({ kind: 'failure', error: serialized }, 'stage', 'generation')).toThrow('Failed');
    try { consumeGenerationOutcome({ kind: 'failure', error: serialized }, 'stage', 'generation'); } catch (error) {
      expect(error).toMatchObject({ message: 'Failed', code: 'UPSTREAM', outcomeUnknown: true, attempts: failure.attempts,
        selectionCache: { joined: true, hit: false } });
      expect(error).not.toBe(failure);
    }
    expect(failure).not.toHaveProperty('selectionCache');
  });

  test('keeps corrupt or missing results unknown rather than inventing a new submission', () => {
    const file = path.join(directory, 'stage.json');
    const id = crypto.randomUUID();
    publishGenerationOutcome(file, id, { kind: 'unknown' });
    expect(readGenerationOutcome(file, id)).toBeNull();
    fs.writeFileSync(path.join(directory, '.attempt-outcomes', `${id}.json`), '{broken');
    expect(readGenerationOutcome(file, id)).toBeNull();
    expect(() => consumeGenerationOutcome(null, 'key', id)).toThrow('without a recoverable outcome');
  });

  test('expires only old journal entries, preserving current attempts and unrelated files', () => {
    const file = path.join(directory, 'stage.json');
    const oldId = crypto.randomUUID();
    const currentId = crypto.randomUUID();
    publishGenerationOutcome(file, oldId, { kind: 'failure', error: { message: 'old' } });
    const oldPath = path.join(directory, '.attempt-outcomes', `${oldId}.json`);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, old, old);
    const unrelated = path.join(directory, '.attempt-outcomes', 'notes.json');
    fs.writeFileSync(unrelated, 'keep');
    fs.utimesSync(unrelated, old, old);
    publishGenerationOutcome(file, currentId, { kind: 'failure', error: { message: 'new' } });
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(readGenerationOutcome(file, currentId).error.message).toBe('new');
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep');
  });
});
