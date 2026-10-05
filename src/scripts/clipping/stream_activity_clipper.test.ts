export {};
const fs = require('fs'), os = require('os'), path = require('path');
const workflow = require('./stream_activity_clipper');
const { sha } = require('./stream_activity_plan');
const { songStatistics } = require('../stream_activity_clips');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-activities-'));
    const mediaPath = path.join(dir, '录制-25788785-20261001-200000-000-测试.flv'), srtPath = path.join(dir, 'source.srt');
    fs.writeFileSync(mediaPath, 'recording');
    fs.writeFileSync(srtPath, '1\n00:01:40,000 --> 00:06:40,000\n唱一下测试曲\n\n2\n00:16:40,000 --> 01:40:00,000\n现在来看测试电影\n');
    const config = { streamActivityClips: { enabled: true, detectionMode: 'standalone_scan', songs: { collection: { sectionId: 111, seasonId: 11 } },
        watch: { collection: { sectionId: 222, seasonId: 22 } } } };
    const scheduler = () => ({ acquire: async () => ({ release() {}, profile: { mode: 'idle', ffmpegThreads: 4 } }) });
    const renderPart = jest.fn(async (_source, part, out) => { fs.writeFileSync(out, `render:${part.start}-${part.end}`);
        return { ...part, mediaPath: out, actualDuration: part.duration, bytes: fs.statSync(out).size, sha256: sha(fs.readFileSync(out).toString()) }; });
    const cover = jest.fn(async (_part, out) => { fs.writeFileSync(out, 'cover'); });
    const request = jest.fn(async (prompt: string) => {
        const [coreStart, coreEnd] = prompt.match(/Core window ([\d.]+)-([\d.]+)/)!.slice(1).map(Number);
        const [from, to] = prompt.match(/context ([\d.]+)-([\d.]+)/)!.slice(1).map(Number);
        const events = [];
        if (coreStart < 400) events.push({ kind: 'song', start: 100, end: 400, name: '测试曲', performance: 'full',
            startObserved: true, endObserved: true, evidenceIds: ['T1'], titleEvidenceIds: ['T1'] });
        if (coreEnd >= 1000) events.push({ kind: 'watch', start: Math.max(1000, from), end: Math.min(6000, to),
            name: '测试电影', mediaKind: 'movie', startObserved: from <= 1000, endObserved: to >= 6000,
            evidenceIds: ['T2'], titleEvidenceIds: ['T2'] });
        return { text: JSON.stringify({ events }), meta: {} };
    });
    return { dir, options: { config, mediaPath, srtPath, probe: async () => 6100, request, renderPart, cover, scheduler,
        verify: async event => ({ decision: 'keep', events: [{ ...event, verification: { decision: 'keep', reason: 'fixture media check' } }] }),
        registerUpload: false }, renderPart, request };
}
test('one archive per kind, full song JSON, complete multipart rendering and restart reuse', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities(f.options);
        expect(result).toMatchObject({ status: 'rendered', submissions: 2, parts: 5, pendingReview: true });
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
        const metadata = manifest.clips.map(row => JSON.parse(fs.readFileSync(row.metadataPath, 'utf8')));
        expect(metadata.map(row => row.output.parts.length)).toEqual([1, 4]);
        expect(metadata.map(row => row.upload.collectionSectionId)).toEqual([111, 222]);
        expect(metadata.every(row => row.uploadReady === false && row.activityReview.status === 'pending')).toBe(true);
        const songs = JSON.parse(fs.readFileSync(result.songsPath, 'utf8'));
        expect(songs.songs).toHaveLength(1); expect(songs.songs[0]).toMatchObject({ name: '测试曲', part: 1 });
        expect(songStatistics(f.dir)).toMatchObject({ inspectedSessions: 1, performances: 1, unknownPerformances: 0 });
        expect(fs.readFileSync(result.reviewPath, 'utf8')).toContain('一个投稿，4 P');
        await workflow.generateStreamActivities(f.options);
        expect(f.renderPart).toHaveBeenCalledTimes(5); expect(f.request).toHaveBeenCalledTimes(4);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('AI failure persists incomplete coverage and does not masquerade as a songless stream', async () => {
    const f = fixture();
    try {
        await expect(workflow.generateStreamActivities({ ...f.options, request: async () => { throw new Error('upstream down'); } })).rejects.toThrow('upstream down');
        const files = workflow.pathsFor(f.options.mediaPath, f.options.config, require('./stream_activity_plan').getActivityConfig(f.options.config));
        expect(JSON.parse(fs.readFileSync(files.songs, 'utf8'))).toMatchObject({ status: 'failed', coverage: { status: 'incomplete' } });
        expect(songStatistics(f.dir)).toMatchObject({ inspectedSessions: 0, incompleteSessions: 1 });
        expect(f.renderPart).not.toHaveBeenCalled(); expect(fs.existsSync(files.lock)).toBe(false);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('one malformed boundary response is repaired from the complete original window', async () => {
    const f = fixture(); let malformed = true;
    try {
        const request = async (prompt, ...args) => {
            if (malformed) { malformed = false; return { text: JSON.stringify({ events: [{ kind: 'watch', start: -1, end: 1900 }] }) }; }
            return f.request(prompt, ...args);
        };
        const result = await workflow.generateStreamActivities({ ...f.options, request, planOnly: true });
        const plan = JSON.parse(fs.readFileSync(result.planPath, 'utf8'));
        expect(plan.coverage.status).toBe('complete');
        expect(f.request.mock.calls[0][0]).toContain('FORMAT/BOUNDARY REPAIR');
        expect(plan.events).toHaveLength(2);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('a hallucinated citation is repaired without losing the genuine in-core song', async () => {
    const f = fixture(); let malformed = true;
    try {
        const request = async (prompt, ...args) => {
            const response = await f.request(prompt, ...args);
            if (malformed) {
                malformed = false;
                const raw = JSON.parse(response.text); raw.events[0].evidenceIds.push('T999');
                return { text: JSON.stringify(raw) };
            }
            return response;
        };
        const result = await workflow.generateStreamActivities({ ...f.options, request, planOnly: true });
        expect(f.request.mock.calls[1][0]).toContain('unseen source citations: T999');
        expect(f.request.mock.calls[1][0]).toContain('numbers from a D row cannot be cited as T');
        expect(JSON.parse(fs.readFileSync(result.songsPath, 'utf8')).songs).toHaveLength(1);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
test('unverified singing candidates remain reviewable but do not become confirmed song statistics', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities({ ...f.options, planOnly: true,
            verify: async event => ({ decision: 'uncertain', events: [{ ...event, reviewIssues: ['media_verification_unconfirmed'] }] }) });
        expect(JSON.parse(fs.readFileSync(result.songsPath, 'utf8')).songs[0].verificationStatus).toBe('uncertain');
        expect(songStatistics(f.dir)).toMatchObject({ inspectedSessions: 1, performances: 0, unverifiedPerformances: 1 });
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('restyling legacy pending packages reuses every video and detector result and is cached on restart', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities(f.options);
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
        const originals = manifest.clips.map(row => JSON.parse(fs.readFileSync(row.metadataPath, 'utf8')));
        for (const row of originals) {
            delete row.presentation;
            row.copy.title = '旧版标题'; row.upload.prefix = '【小岁】';
            fs.writeFileSync(row.output.metadataPath, JSON.stringify(row));
        }
        const restyleOptions = { ...f.options, manifestPath: result.manifestPath };
        expect(await workflow.restyleStreamActivities(restyleOptions)).toMatchObject({ status: 'restyled', updated: 2 });
        const updated = manifest.clips.map(row => JSON.parse(fs.readFileSync(row.metadataPath, 'utf8')));
        expect(updated.map(row => row.upload.prefix)).toEqual(['【岁己歌切】', '【岁己同步视听】']);
        expect(updated.map(row => row.output.parts.map(part => [part.mediaPath, part.sha256, part.start, part.end])))
            .toEqual(originals.map(row => row.output.parts.map(part => [part.mediaPath, part.sha256, part.start, part.end])));
        expect(updated.every(row => !row.uploadReady && row.activityReview.status === 'pending')).toBe(true);
        expect(f.renderPart).toHaveBeenCalledTimes(5); expect(f.request).toHaveBeenCalledTimes(4);
        expect(f.options.cover).toHaveBeenCalledTimes(4);
        expect(await workflow.restyleStreamActivities(restyleOptions)).toMatchObject({ updated: 0 });
        expect(f.options.cover).toHaveBeenCalledTimes(4);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('restyling an approved package stops before generating covers or changing metadata', async () => {
    const f = fixture();
    try {
        const result = await workflow.generateStreamActivities(f.options);
        const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
        const metadataPath = manifest.clips[0].metadataPath;
        const row = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
        row.activityReview.status = 'approved'; row.uploadReady = true;
        const original = JSON.stringify(row); fs.writeFileSync(metadataPath, original);
        await expect(workflow.restyleStreamActivities({ ...f.options, manifestPath: result.manifestPath }))
            .rejects.toThrow('explicit reviewed revision');
        expect(fs.readFileSync(metadataPath, 'utf8')).toBe(original);
        expect(f.options.cover).toHaveBeenCalledTimes(2);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('standalone detection is shared while kind-specific original-media checks and renders are deferred', async () => {
    const f = fixture();
    const verify = jest.fn(f.options.verify);
    try {
        await workflow.generateStreamActivities({ ...f.options, verify, kind: 'songs' });
        expect(verify.mock.calls.map(call => call[0].kind)).toEqual(['song']);
        expect(f.renderPart).toHaveBeenCalledTimes(1);
        const requests = f.request.mock.calls.length;
        await workflow.generateStreamActivities({ ...f.options, verify, kind: 'watch' });
        expect(verify.mock.calls.map(call => call[0].kind)).toEqual(['song', 'watch']);
        expect(f.request).toHaveBeenCalledTimes(requests);
        expect(f.renderPart).toHaveBeenCalledTimes(5);
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('fresh summary packages receive independent final review, keep their stable IDs and refresh one status list', async () => {
    const f = fixture(), timeline: string[] = [];
    const config: any = f.options.config;
    config.streamActivityClips.detectionMode = 'summary';
    config.streamActivityClips.roomIds = ['25788785'];
    config.streamActivityClips.automaticPublication = { mode: 'auto', policyVersion: 'stream-activity-v1', roomIds: ['25788785'],
        activatedAt: '2026-01-01T00:00:00Z', authorizationNote: 'fixture authorization' };
    const detector = jest.spyOn(require('./stream_activity_summary_plan'), 'detectSummaryActivities').mockImplementation(async (...args: any[]) => {
        const [options, settings, source, info, files] = args;
        const evidencePath = path.join(f.dir,'LOCAL.json'), responsePath = path.join(f.dir,'RESPONSE.json');
        fs.writeFileSync(evidencePath,'{}'); fs.writeFileSync(responsePath,'{}');
        const events = [{id:'song1',kind:'song',start:100,end:400,name:'测试曲',performance:'full',startObserved:true,endObserved:true,reviewIssues:[]},
            {id:'watch1',kind:'watch',start:1000,end:6000,name:'测试电影',mediaKind:'movie',startObserved:true,endObserved:true,reviewIssues:[]}]
            .map(event=>({...event,verification:{decision:'keep',method:'independent_local_asr',localAudioEvidence:{resultPath:evidencePath},responsePath}}));
        const plan = {version:9,signature:'fixture-plan',status:'planned',...info,source,
            transcript:{path:options.srtPath,mode:'source_srt'},events,rawEvents:events,calibratedKinds:['songs','watch'],
            parts:require('./stream_activity_plan').buildParts(events,6100,settings),
            coverage:{status:'complete',duration:6100,windows:[{start:0,end:6100,status:'inspected'}]}};
        fs.writeFileSync(files.plan,JSON.stringify(plan));
        return plan;
    });
    const queuedIds = new Set();
    const register = jest.fn(async (file:string)=>{
        timeline.push(queuedIds.size?'registry:refresh':'registry:import');
        const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
        return {clipIdsByReviewIndex:Object.fromEntries(manifest.clips.map((row:any)=>[row.reviewIndex,row.reviewIndex===1?3113:3112])),
            clipStatusByReviewIndex:{1:queuedIds.has(3113)?'queued':'review',2:queuedIds.has(3112)?'queued':'needs_review'}};
    });
    const publicationAdapters = {check:jest.fn(async(row:any)=>{
        if(row.kind==='watch')throw new Error('unresolved viewing boundary');return {contentSha256:'fixture'};
    }),text:jest.fn(async()=>({version:3,activities:[{id:'fixture',cues:[],before:[],after:[],audience:[]}]})),inspect:jest.fn(async(_row:any,parts:any[])=>Array(parts.length+1).fill('data:image/jpeg;base64,/9j/')),
        request:jest.fn(async()=>{timeline.push('final-review');return{text:JSON.stringify({status:'passed',
            checks:{content:true,boundaries:true,titles:true,visuals:true,policy:true},issues:[]})};}),
        approve:jest.fn(async(row:any)=>({...row,uploadReady:true,activityReview:{authority:'automatic',status:'approved'}})),
        enqueue:jest.fn(async(_row:any,id:number)=>{timeline.push('enqueue');queuedIds.add(id);return 'QUEUE_JOB_ID: fixture-job';})};
    try {
        const result = await workflow.generateStreamActivities({...f.options,registerUpload:true,register,publicationAdapters});
        expect(timeline).toEqual(['final-review','registry:import','enqueue','registry:refresh']);
        expect(publicationAdapters.enqueue.mock.calls[0][1]).toBe(3113);
        expect(result.publicationResults.map((row:any)=>[row.id,row.status])).toEqual([[3113,'已排队投稿'],[3112,'待人工复核']]);
        expect(result.retainSource).toBe(true);
        const review=fs.readFileSync(result.reviewPath,'utf8');
        expect(review).toContain('状态: 已排队投稿');expect(review).toContain('unresolved viewing boundary');
        expect(review).not.toMatch(/BV[A-Za-z0-9]+|bilibili\.com/u);
        expect(register).toHaveBeenCalledTimes(2);
        const plan=JSON.parse(fs.readFileSync(result.planPath,'utf8'));
        plan.contentSha256=require('./stream_activity_summary_plan').digest(plan);
        fs.writeFileSync(result.planPath,JSON.stringify(plan));
        const watchPath=JSON.parse(fs.readFileSync(result.manifestPath,'utf8')).clips.find(row=>row.reviewIndex===2).metadataPath;
        publicationAdapters.check.mockResolvedValue({contentSha256:'fixture'});
        const resumed=await workflow.generateStreamActivities({...f.options,kind:'watch',retryPublication:true,
            revisionNote:'修复审核图片传输后重试当前成片',registerUpload:true,register,publicationAdapters,
            readRegistry:()=>({clips:{3112:{id:3112,status:'needs_review',metadataPath:watchPath}}})});
        expect(detector).toHaveBeenCalledTimes(1);
        expect(f.renderPart).toHaveBeenCalledTimes(5);
        expect(publicationAdapters.enqueue.mock.calls.map(call=>call[1])).toEqual([3113,3112]);
        expect(resumed.publicationResults.find(row=>row.id===3112).status).toBe('已排队投稿');
        expect(JSON.parse(fs.readFileSync(result.planPath,'utf8')).publicationRetries[0].note).toContain('图片传输');
        expect(register).toHaveBeenCalledTimes(4);
    } finally {detector.mockRestore();fs.rmSync(f.dir,{recursive:true,force:true});}
});
