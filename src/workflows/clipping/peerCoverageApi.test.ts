import { createPeerApi } from './peerCoverageApi';
import type { PeerVideo } from './peerCoverage';

const peer: PeerVideo = { bvid: 'BV1234567890', aid: '11', ownerId: '22', title: '', description: '', duration: 0, publishedAt: 1, cues: [], complete: false };
function fixture(options: { subtitleUrl?: string; wrongCid?: boolean } = {}) {
    const transport = jest.fn(async (url: string, request: any): Promise<any> => {
        let data: any;
        const path = new URL(url).pathname;
        if (path.endsWith('/nav')) data = { isLogin: true, mid: 33, wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/0123456789abcdef0123456789abcdef.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/abcdef0123456789abcdef0123456789.png' } };
        else if (path.endsWith('/search/type')) data = { result: [{ ...peer, mid: peer.ownerId, title: '<em>岁己</em>片段' }] };
        else if (path.endsWith('/view')) data = { ...peer, aid: 11, owner: { mid: 22 }, duration: 30, pages: [{ cid: 44 }] };
        else if (path.endsWith('/wbi/v2')) data = { aid: 11, cid: options.wrongCid ? 55 : 44, subtitle: { subtitles: [{ lan: 'zh-CN',
            subtitle_url: options.subtitleUrl || '//aisubtitle.hdslb.com/bfs/ai_subtitle/prod/1144/test.json' }] } };
        else if (url.includes('hdslb.com')) return { ok: true, status: 200, text: async () => JSON.stringify({ body: [{ from: 0, to: 5, content: '完整原话证据' }] }) };
        else if (path.endsWith('/has/like')) data = 0;
        else if (path.endsWith('/favoured')) data = { favoured: true };
        else if (path.endsWith('/list-all')) data = { list: [{ id: 66, mid: 33, title: '默认收藏夹' }] };
        else if (request.method === 'POST') data = {};
        else throw new Error('Unexpected request');
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) };
    });
    return { transport, api: createPeerApi('SESSDATA=test; bili_jct=csrf-test; DedeUserID=33', transport as any, () => 1800000000000) };
}
test('bounded signed search uses the platform account and strips markup without following search URLs', async () => {
    const { api, transport } = fixture();
    expect(await api.accountId()).toBe('33');
    expect((await api.search('岁己 完整故事', 3))[0].title).toBe('岁己片段');
    const target = new URL(transport.mock.calls[1][0]);
    expect(target.hostname).toBe('api.bilibili.com'); expect(target.searchParams.get('page_size')).toBe('3');
    expect(target.searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/);
    expect(transport.mock.calls.every(([, init]) => init.redirect === 'error')).toBe(true);
});
test('complete transcript is bound to the actual aid/cid and CDN never receives cookies', async () => {
    const { api, transport } = fixture(), result = await api.read(peer);
    expect(result).toMatchObject({ complete: true, duration: 30, cues: [{ id: 'P1', text: '完整原话证据' }] });
    const cdn = transport.mock.calls.find(([url]) => url.includes('hdslb.com'))!;
    expect(cdn[1].headers.Cookie).toBeUndefined();
    expect(new URL(transport.mock.calls.find(([url]) => url.includes('/player/wbi/v2'))![0]).searchParams.get('w_rid')).toMatch(/^[a-f0-9]{32}$/);
    expect((await fixture({ wrongCid: true }).api.read(peer)).complete).toBe(false);
});
test.each(['https://evil.example/steal', 'https://api.bilibili.com/bfs/subtitle/test',
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/9999/test.json'])('rejects an unbound subtitle URL %s before fetching it', async subtitleUrl => {
    const { api, transport } = fixture({ subtitleUrl });
    expect((await api.read(peer)).complete).toBe(false);
    expect(transport).toHaveBeenCalledTimes(3);
});
test('support explicitly sets like/favorite and resolves only our default folder', async () => {
    const { api, transport } = fixture();
    expect(await api.has('like', peer)).toBe(false); expect(await api.has('favorite', peer)).toBe(true);
    expect(await api.defaultFolder(peer)).toBe('66');
    await api.act('like', peer); await api.act('favorite', peer, '66');
    const writes = transport.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(writes).toHaveLength(2); expect(writes[0][1].body.get('like')).toBe('1');
    expect(writes[1][1].body.get('add_media_ids')).toBe('66'); expect(writes[1][1].body.get('del_media_ids')).toBe('');
    expect(writes[0][1].body.get('csrf')).toBe('csrf-test');
});
test('risk response stops subsequent reads and writes without signing refresh or retries', async () => {
    const transport = jest.fn(async (): Promise<any> => ({ ok: false, status: 412 }));
    const api = createPeerApi('test', transport as any);
    await expect(api.accountId()).rejects.toThrow('blocked');
    await expect(api.has('like', peer)).rejects.toThrow('blocked'); expect(transport).toHaveBeenCalledTimes(1);
});

test('repost binds the original author and archive, preserves string IDs and saves the returned receipt', async () => {
    const originalId = '1155555555555555555', repostId = '1166666666666666666';
    let posted = false;
    const original = { id_str: originalId, modules: { module_author: { mid: 22 },
        module_dynamic: { major: { archive: { bvid: peer.bvid, aid: '11' } } } } };
    const transport = jest.fn(async (url: string, request: any): Promise<any> => {
        const target = new URL(url);
        let data: any;
        if (target.pathname.endsWith('/nav')) data = { isLogin: true, mid: 33 };
        else if (target.pathname.endsWith('/feed/space')) data = { has_more: false, items:
            target.searchParams.get('host_mid') === '22' ? [original] : posted ? [{ id_str: repostId,
                type: 'DYNAMIC_TYPE_FORWARD', modules: { module_author: { mid: 33 } }, orig: original }] : [] };
        else {
            expect(target.href).toBe('https://api.vc.bilibili.com/dynamic_repost/v1/dynamic_repost/repost');
            expect(request.body.get('dynamic_id')).toBe(originalId);
            expect(request.body.get('csrf')).toBe('test');
            posted = true; data = { dynamic_id_str: repostId };
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) };
    });
    const api = createPeerApi('bili_jct=test', transport as any);
    expect(await api.has('repost', peer)).toBe(false);
    expect(await api.act('repost', peer)).toEqual({ dynamicId: repostId, originalDynamicId: originalId });
    expect(await api.has('repost', peer)).toBe(true);
    expect(transport.mock.calls.filter(([, request]) => request.method === 'POST')).toHaveLength(1);
});

test('a mismatched archive or author cannot become the repost target', async () => {
    const transport = jest.fn(async (url: string): Promise<any> => ({ ok: true, status: 200,
        text: async () => JSON.stringify({ code: 0, data: url.endsWith('/nav') ? { isLogin: true, mid: 33 }
            : { has_more: false, items: [{ id_str: '1155555555555555555', modules: { module_author: { mid: 99 },
                module_dynamic: { major: { archive: { bvid: peer.bvid, aid: '11' } } } } }] } }) }));
    const api = createPeerApi('bili_jct=test', transport as any);
    await expect(api.act('repost', peer)).rejects.toThrow('unavailable');
    expect(transport).toHaveBeenCalledTimes(2);
});

test('known repost receipts reconcile the exact dynamic and reject a different original', async () => {
    const base = fixture(), receipt = { dynamicId: '1166666666666666666', originalDynamicId: '1155555555555555555' };
    const item = { id_str: receipt.dynamicId, type: 'DYNAMIC_TYPE_FORWARD', modules: { module_author: { mid: 33 } },
        orig: { id_str: receipt.originalDynamicId, modules: { module_author: { mid: 22 },
            module_dynamic: { major: { archive: { bvid: peer.bvid, aid: '11' } } } } } };
    const transport = jest.fn(async (url: string, request: any): Promise<any> => url.includes('/web-dynamic/v1/detail?')
        ? { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { item } }) }
        : base.transport(url, request));
    const api = createPeerApi('bili_jct=test', transport as any);
    expect(await api.has('repost', peer, receipt)).toBe(true);
    expect(await api.has('repost', peer, { ...receipt, originalDynamicId: '1177777777777777777' })).toBe(false);
    expect(transport.mock.calls.every(([, request]) => request.method === 'GET')).toBe(true);
});
