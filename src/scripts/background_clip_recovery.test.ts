import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recheckSkippedCampaignJob, retryFailedBackgroundJob } from './background_clip_recovery';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'background-recovery-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const payload = path.join(root, 'payload.json'), id = 'existing-job';
    fs.writeFileSync(payload, '{"originalMediaPath":"source.flv"}');
    const state = { version: 1, status: 'failed', completed: { topics: [], songs: { status: 'disabled' } } };
    fs.writeFileSync(`${payload}.progress.json`, JSON.stringify(state));
    const entry = { jobId: id, payloadPath: payload, status: 'failed', attempts: 3, lastError: 'missing map' };
    fs.writeFileSync(path.join(root, `${id}.failed.json`), JSON.stringify(entry));
    return { id, payload, state };
}
test('retries the same job with immutable history and keeps successful stage receipts', () => {
    const { id, payload, state } = fixture();
    const next = retryFailedBackgroundJob(root, id, 'repaired map and verified source');
    expect(next).toMatchObject({ jobId: id, payloadPath: payload, attempts: 0, status: 'pending', nextAttemptAt: 0 });
    expect(next).not.toHaveProperty('lastError');
    expect(next.recoveryHistory[0]).toMatchObject({ attempts: 3, lastError: 'missing map' });
    expect(JSON.parse(fs.readFileSync(`${payload}.progress.json`, 'utf8'))).toEqual(state);
    expect(fs.readdirSync(path.join(root, 'recovery-history'))).toHaveLength(1);
    expect(() => retryFailedBackgroundJob(root, id, 'again')).toThrow('already');
});
test.each(['working', 'completed', 'missing-payload', 'no-note'])('refuses unsafe recovery without consuming failed entry: %s', reason => {
    const { id, payload } = fixture();
    if (reason === 'working') fs.writeFileSync(path.join(root, `${id}.working.json`), '{}');
    if (reason === 'completed') fs.writeFileSync(`${payload}.progress.json`, '{"status":"completed"}');
    if (reason === 'missing-payload') fs.unlinkSync(payload);
    expect(() => retryFailedBackgroundJob(root, id, reason === 'no-note' ? '' : 'repair')).toThrow();
    expect(fs.existsSync(path.join(root, `${id}.failed.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, `${id}.pending.json`))).toBe(false);
});

function skippedFixture() {
    const { id, payload } = fixture();
    const media = path.join(root, 'source.flv');
    fs.writeFileSync(media, 'source');
    fs.writeFileSync(payload, JSON.stringify({ originalMediaPath: media, roomId: '123' }));
    const progress = { status: 'completed', completed: { own: [], topics: ['retained'], games: ['game'] } };
    fs.writeFileSync(`${payload}.progress.json`, JSON.stringify(progress));
    fs.renameSync(path.join(root, `${id}.failed.json`), path.join(root, `${id}.done.json`));
    return { id, payload, progress };
}

test('rechecks only the empty own stage with current source admission and the original identity', () => {
    const { id, payload } = skippedFixture();
    const admit = jest.fn().mockReturnValue(true);
    const next = recheckSkippedCampaignJob(root, id, 'verified actual gameplay alias', admit);
    expect(next).toMatchObject({ jobId: id, payloadPath: payload, attempts: 0, status: 'pending' });
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({ roomId: '123' }));
    expect(JSON.parse(fs.readFileSync(`${payload}.progress.json`, 'utf8'))).toMatchObject({
        status: 'pending', stage: 'own', completed: { topics: ['retained'], games: ['game'] }
    });
    expect(JSON.parse(fs.readFileSync(`${payload}.progress.json`, 'utf8')).completed).not.toHaveProperty('own');
    expect(fs.existsSync(path.join(root, `${id}.done.json`))).toBe(false);
});

test.each(['no-admission', 'rendered-own', 'managed', 'activity', 'working', 'missing-media'])('preserves completed receipt and progress on refused campaign recheck: %s', reason => {
    const { id, payload, progress } = skippedFixture();
    if (reason === 'rendered-own') (progress.completed.own as unknown[]) = [{ id: 'published' }];
    if (reason === 'managed') Object.assign(progress.completed, { recordingJob: {} });
    if (reason === 'activity') fs.writeFileSync(payload, '{"activityOptions":{}}');
    if (reason === 'working') fs.writeFileSync(path.join(root, `${id}.working.json`), '{}');
    if (reason === 'missing-media') fs.unlinkSync(path.join(root, 'source.flv'));
    fs.writeFileSync(`${payload}.progress.json`, JSON.stringify(progress));
    expect(() => recheckSkippedCampaignJob(root, id, 'repair', () => reason !== 'no-admission')).toThrow();
    expect(JSON.parse(fs.readFileSync(`${payload}.progress.json`, 'utf8'))).toEqual(progress);
    expect(fs.existsSync(path.join(root, `${id}.done.json`))).toBe(true);
    expect(fs.existsSync(path.join(root, `${id}.pending.json`))).toBe(false);
});
