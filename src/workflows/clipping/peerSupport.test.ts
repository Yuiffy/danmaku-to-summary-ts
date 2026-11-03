import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { supportPeer } from './peerSupport';
import type { PeerApi } from './peerCoverageApi';
import type { PeerVideo } from './peerCoverage';

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'peer-support-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
const peer: PeerVideo = { bvid: 'BV1234567890', aid: '1', ownerId: '2', complete: true, cues: [], duration: 10, publishedAt: 1, title: '', description: '' };
function apiFixture() {
    const done = new Set<string>();
    const api = { accountId: jest.fn(async () => '3'), has: jest.fn(async action => done.has(action)),
        act: jest.fn(async action => { done.add(action); }), defaultFolder: jest.fn(async () => '4') };
    return { api: api as unknown as PeerApi & typeof api, done };
}
test('like and favorite are explicit set operations; rerunning reconciles without repeating writes', async () => {
    const { api } = apiFixture(), file = path.join(directory, 'state.json');
    const result: any = await supportPeer(peer, {}, api, file, () => 100000000);
    expect(result.actions).toEqual({ like: 'confirmed', favorite: 'confirmed' });
    await supportPeer(peer, {}, api, file, () => 100100000);
    expect(api.act).toHaveBeenCalledTimes(2);
    expect(api.act).toHaveBeenCalledWith('favorite', peer, '4');
});
test('POST timeout persists uncertainty, pauses interactions, and never blindly replays after restart', async () => {
    const { api } = apiFixture(), file = path.join(directory, 'state.json');
    api.act.mockRejectedValue(new Error('timeout'));
    await supportPeer(peer, {}, api, file, () => 100000000);
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(state.accounts['3'].entries[peer.bvid].actions.like.status).toBe('unknown');
    expect(api.act).toHaveBeenCalledTimes(1);
    await supportPeer(peer, { supportActions: ['like'] }, api, file, () => 104000000);
    expect(api.act).toHaveBeenCalledTimes(1);
});
test('quota and interval span all sources and survive independent runs', async () => {
    const { api, done } = apiFixture(), file = path.join(directory, 'state.json');
    await supportPeer(peer, { supportActions: ['like'], maxSupportPerDay: 1 }, api, file, () => 100000000);
    done.clear();
    const result: any = await supportPeer({ ...peer, bvid: 'BVabcdefghij', aid: '5' }, { supportActions: ['like'], maxSupportPerDay: 1 }, api, file, () => 104000000);
    expect(result.actions.like).toBe('deferred_quota'); expect(api.act).toHaveBeenCalledTimes(1);
});
test('an existing journal lock prevents a second writer without deleting the owner lock', async () => {
    const { api } = apiFixture(), file = path.join(directory, 'state.json');
    await fs.writeFile(file + '.lock', 'owner');
    expect(await supportPeer(peer, {}, api, file)).toMatchObject({ status: 'deferred' });
    expect(api.act).not.toHaveBeenCalled(); expect(await fs.readFile(file + '.lock', 'utf8')).toBe('owner');
});

test('repost receipts survive restarts and an uncertain repost is never automatically sent twice', async () => {
    const { api } = apiFixture(), file = path.join(directory, 'state.json');
    api.act.mockImplementation(async action => {
        if (action === 'repost') throw new Error('reply lost after sending');
    });
    await supportPeer(peer, { supportActions: ['repost'] }, api, file, () => 100000000);
    await supportPeer(peer, { supportActions: ['repost'] }, api, file, () => 104000000);
    expect(api.act).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).accounts['3'].entries[peer.bvid].actions.repost.status).toBe('unknown');
});

test('reconciling a known repost keeps its durable original and new dynamic receipt', async () => {
    const { api } = apiFixture(), file = path.join(directory, 'state.json');
    const receipt = { dynamicId: '1166666666666666666', originalDynamicId: '1155555555555555555' };
    (api.act as jest.Mock).mockResolvedValue(receipt);
    api.has.mockResolvedValueOnce(false).mockResolvedValue(true);
    await supportPeer(peer, { supportActions: ['repost'] }, api, file, () => 100000000);
    await supportPeer(peer, { supportActions: ['repost'] }, api, file, () => 104000000);
    expect(api.act).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).accounts['3'].entries[peer.bvid].actions.repost)
        .toMatchObject({ status: 'confirmed', receipt });
});
