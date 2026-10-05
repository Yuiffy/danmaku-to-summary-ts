import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { activityPublicationEnabled, reviewActivityPublications, enqueueActivityPublications, assertActivityPublicationRetry, writeActivitySampleSheet } from './activityPublication';
import { activityTimingRevision } from './activityStages';
import { validateImageInputs, MAX_INLINE_IMAGES } from '../text/requests';
import { createHash } from 'crypto';
import { activityPublicationText, activityPublicationBatchText } from './activityPublicationEvidence';

const checks = { content: true, boundaries: true, titles: true, visuals: true, policy: true };
const passed = { status: 'passed', checks, issues: [] };
const picture = 'data:image/jpeg;base64,/9j/';
test('timing revision renews both kinds and their source evidence while preserving the existing bundle identity', () => {
    const source = { mediaPath:'source.flv',srtSha256:'original' };
    const previous = {source,signature:'old',uploadManifestPath:'old/UPLOAD_MANIFEST.json',uploadIds:{1:3112},
        transcript:{timingReliable:false},calibratedKinds:['watch'],efficiency:{boundaryRequests:1}};
    const next = {source,signature:'new',transcript:{mode:'repaired_source_audio'},summary:{sha256:'new-summary'}};
    const revised = activityTimingRevision(previous,next,{id:'revision',note:'已证实源字幕漂移'});
    expect(revised).toMatchObject({signature:'old',timingSignature:'new',uploadIds:{1:3112},calibratedKinds:[],
        uploadManifestPath:'old/UPLOAD_MANIFEST.json'});
    expect(revised.timingRevisions[0].previousEfficiency).toEqual({boundaryRequests:1});
    expect(()=>activityTimingRevision(previous,{...next,source:{mediaPath:'another.flv'}},{note:'修复'})).toThrow('source-bound');
    expect(()=>activityTimingRevision({...previous,transcript:{}},next,{note:'修复'})).toThrow('source-bound');
});
function fixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'activity-publication-'));
    const local = path.join(directory,'LOCAL.json'), assessment = path.join(directory,'RESPONSE.json');
    fs.writeFileSync(local,JSON.stringify({ method:'independent_local_asr', audio:[{ text:'独立原音观察' }] }));
    fs.writeFileSync(assessment,JSON.stringify({ text:'完整上下文包围边界',requestBinding:{ source:'fixture' } }));
    const row = { kind:'watch',roomId:'25788785',generatedAt:'2026-10-05T01:00:00Z',activityAutomaticPublicationRequired:true,
        uploadReady:false,activityReview:{status:'pending'},copy:{title:'本场视听'},
        transcript:{path:local,sha256:createHash('sha256').update(fs.readFileSync(local)).digest('hex')},sourceSnapshot:{xmlPath:null},
        activities:[{id:'a1',start:100,end:200,verification:{localAudioEvidence:{resultPath:local},responsePath:assessment}}],
        output:{metadataPath:path.join(directory,'watch.json'),parts:[{mediaPath:'P1.mp4',start:100,end:150},{mediaPath:'P2.mp4',start:150,end:200}]} };
    fs.writeFileSync(row.output.metadataPath,JSON.stringify(row));
    const config = { streamActivityClips:{enabled:true,roomIds:['25788785'],automaticPublication:{mode:'auto',roomIds:['25788785'],
        policyVersion:'stream-activity-v1',activatedAt:'2026-10-05T00:00:00Z',authorizationNote:'fixture authorization'}},
        ownStreamClips:{selectionPolicy:{excludedCategories:['全局排除'],roomOverrides:{'25788785':{excludedCategories:['现实家庭关系']}}}} };
    const adapters: any = { check:jest.fn(async()=>({contentSha256:'fixture'})),inspect:jest.fn(async()=>Array(3).fill(picture)),
        text:jest.fn(current=>activityPublicationText(current,{read:file=>fs.readFileSync(file),audience:async()=>[],
            parse:()=>[{start:95,end:99,text:'开始观影'},{start:120,end:124,text:'片内原话'},{start:201,end:205,text:'下次再看，今天结束了'}]})),
        request:jest.fn(async()=>({text:JSON.stringify(passed)})),
        approve:jest.fn(async(current,proofPath)=>{
            const proof=JSON.parse(fs.readFileSync(proofPath,'utf8'));
            expect(proof.binding.contentSha256).toBe('fixture');
            return {...current,uploadReady:true,activityReview:{status:'approved',authority:'automatic',proofPath}};
        }),enqueue:jest.fn(async()=> 'QUEUE_JOB_ID: upload-123') };
    return {directory,row,config,adapters};
}

test('a current independent final review binds complete evidence, real cover/P samples and the existing ID',async()=>{
    const f=fixture();
    try {
        const [approved]=await reviewActivityPublications([f.row],f.config,f.adapters);
        expect(approved.activityReview).toMatchObject({status:'approved',authority:'automatic'});
        const evidence=JSON.parse(f.adapters.request.mock.calls[0][1].split('EVIDENCE_JSON ')[1]);
        expect(evidence.boundaryEvidence[0].independentAudio.audio[0].text).toBe('独立原音观察');
        expect(evidence.excludedCategories).toEqual(['全局排除','现实家庭关系']);
        expect(evidence.completeText.activities[0]).toMatchObject({cues:[{text:'片内原话'}],after:[{text:'下次再看，今天结束了'}]});
        expect(f.adapters.inspect).toHaveBeenCalledWith(f.row,f.row.output.parts);
        const clips=[{metadataPath:f.row.output.metadataPath,reviewIndex:7}];
        const result=await enqueueActivityPublications([approved],clips,{clipIdsByReviewIndex:{7:3112},clipStatusByReviewIndex:{7:'review'}},f.adapters);
        expect(result.results).toEqual([{id:3112,kind:'watch',status:'queued',jobId:'upload-123'}]);
        expect(f.adapters.enqueue).toHaveBeenCalledWith(approved,3112);
        expect(JSON.parse(fs.readFileSync(f.row.output.metadataPath,'utf8')).uploadReady).toBe(true);
    }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test.each([5,6])('%i viewing Ps fit the real image transport limit and every batch must pass before approval',async count=>{
    const f=fixture();
    try {
        f.row.output.parts=Array.from({length:count},(_,index)=>({mediaPath:`P${index+1}.mp4`,start:100+index*100/count,end:100+(index+1)*100/count}));
        f.adapters.inspect.mockImplementation(async(_row,parts)=>Array(parts.length+1).fill(picture));
        f.adapters.request.mockImplementation(async(_row,prompt,images)=>{
            validateImageInputs(images);
            expect(images.length).toBeLessThanOrEqual(MAX_INLINE_IMAGES);
            expect(f.adapters.approve).not.toHaveBeenCalled();
            const evidence=JSON.parse(prompt.split('EVIDENCE_JSON ')[1]);
            expect(evidence.allParts).toHaveLength(count);
            expect(evidence.reviewScope.partNumbers).toHaveLength(evidence.sampledParts.length);
            expect(evidence.reviewScope.batches).toBe(3);
            expect(evidence.reviewScope.imageManifest).toHaveLength(images.length);
            expect(evidence.reviewScope.imageManifest.slice(1).every(sheet => sheet.samples.length === 3)).toBe(true);
            expect(prompt).toContain('checks apply ONLY to reviewScope.partNumbers');
            return {text:JSON.stringify(passed)};
        });
        const [row]=await reviewActivityPublications([f.row],f.config,f.adapters);
        expect(row.activityReview.status).toBe('approved');
        expect(f.adapters.request).toHaveBeenCalledTimes(3);
        expect(f.adapters.inspect.mock.calls.flatMap(call=>call[1].map(part=>part.mediaPath)))
            .toEqual(f.row.output.parts.map(part=>part.mediaPath));
        expect(f.adapters.approve).toHaveBeenCalledTimes(1);
    }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('a failed middle batch holds the entire six-P package even when the final batch passes',async()=>{
    const f=fixture();
    try {
        f.row.output.parts=Array.from({length:6},(_,index)=>({mediaPath:`P${index+1}.mp4`,start:100+index*100/6,end:100+(index+1)*100/6}));
        f.adapters.inspect.mockImplementation(async(_row,parts)=>Array(parts.length+1).fill(picture));
        f.adapters.request.mockResolvedValueOnce({text:JSON.stringify(passed)})
            .mockResolvedValueOnce({text:JSON.stringify({status:'needs_review',checks:{...checks,visuals:false},issues:['P3画面不符']})})
            .mockResolvedValueOnce({text:JSON.stringify(passed)});
        const [row]=await reviewActivityPublications([f.row],f.config,f.adapters);
        expect(row.uploadReady).toBe(false);
        expect(row.activityReview.issues).toEqual(['P3画面不符']);
        expect(f.adapters.request).toHaveBeenCalledTimes(3);
        expect(f.adapters.approve).not.toHaveBeenCalled();
    }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('an explicit unavailable-review retry rechecks current evidence, while ordinary restart and real review failures stay held',async()=>{
    const f=fixture();
    try {
        const row={...f.row,activityReview:{status:'pending',authority:'automatic',
            issues:['automatic_activity_review_unavailable:Invalid or oversized inline image input']}};
        const registered={id:3112,status:'needs_review'};
        expect(()=>assertActivityPublicationRetry(row,registered)).not.toThrow();
        await reviewActivityPublications([row],f.config,f.adapters);
        expect(f.adapters.request).not.toHaveBeenCalled();
        expect((await reviewActivityPublications([row],f.config,f.adapters,{retryUnavailable:true,kinds:['watch']}))[0].activityReview.status).toBe('approved');
        const blocked={...row,activityReview:{...row.activityReview,issues:['uncertain viewing boundary']}};
        expect(()=>assertActivityPublicationRetry(blocked,registered)).toThrow('unavailable');
        for(const status of ['queued','uploading','uploaded']) expect(()=>assertActivityPublicationRetry(row,{...registered,status})).toThrow('unpublished pending');
        expect(()=>assertActivityPublicationRetry(row,{...registered,bvid:'published'})).toThrow('unpublished pending');
        expect(()=>assertActivityPublicationRetry(row)).toThrow('unpublished pending');
        f.adapters.request.mockClear();
        await reviewActivityPublications([blocked],f.config,f.adapters,{retryUnavailable:true});
        expect(f.adapters.request).not.toHaveBeenCalled();
    }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('explicit legacy evidence upgrade includes all text once, but content rejection and the same evidence cannot be retried',async()=>{
    const f=fixture();
    try {
        const proofPath=path.join(f.directory,'legacy-proof.json');
        const heldChecks={...checks,boundaries:false,policy:false};
        const proof={version:1,binding:{contentSha256:'fixture'},status:'needs_review',checks:heldChecks,
            responses:[{status:'needs_review',checks:heldChecks}]};
        fs.writeFileSync(proofPath,JSON.stringify(proof));
        const row={...f.row,activityReview:{status:'pending',authority:'automatic',checks:heldChecks,issues:['缺少完整字幕'],proofPath}};
        expect(()=>assertActivityPublicationRetry(row,{status:'needs_review'})).not.toThrow();
        await reviewActivityPublications([row],f.config,f.adapters);
        expect(f.adapters.request).not.toHaveBeenCalled();
        expect((await reviewActivityPublications([row],f.config,f.adapters,{retryUnavailable:true}))[0].uploadReady).toBe(true);
        fs.writeFileSync(proofPath,JSON.stringify({...proof,evidenceVersion:2}));
        expect(()=>assertActivityPublicationRetry(row,{status:'needs_review'})).toThrow('missing-text');
        fs.writeFileSync(proofPath,JSON.stringify({...proof,responses:[{status:'rejected',checks:heldChecks}]}));
        expect(()=>assertActivityPublicationRetry(row,{status:'needs_review'})).toThrow('missing-text');
        f.adapters.request.mockClear();
        await reviewActivityPublications([row],f.config,f.adapters,{retryUnavailable:true});
        expect(f.adapters.request).not.toHaveBeenCalled();
    } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('a changed transcript cannot be sent to the final reviewer or acquire approval',async()=>{
    const f=fixture();
    try {
        fs.writeFileSync(f.row.transcript.path,'changed');
        const [held]=await reviewActivityPublications([f.row],f.config,f.adapters);
        expect(held.uploadReady).toBe(false);
        expect(f.adapters.request).not.toHaveBeenCalled();
        expect(f.adapters.approve).not.toHaveBeenCalled();
    } finally {fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('partitioned v2 evidence gets one explicit labelled-sheet upgrade, with no inherited approval or rejected-batch retry', async () => {
    const f = fixture();
    try {
        const heldChecks = { ...checks, visuals: false };
        const proofPath = path.join(f.directory, 'partitioned-v2.json');
        const proof = { version: 1, evidenceVersion: 2, binding: { contentSha256: 'fixture' }, status: 'needs_review',
            checks: heldChecks, completeText: { version: 2, activities: [{ cues: [{ text: '完整原文' }] }] },
            responses: [{ status: 'needs_review', checks: heldChecks, issues: ['缺少另一批P'] }] };
        fs.writeFileSync(proofPath, JSON.stringify(proof));
        const row = { ...f.row, activityReview: { status: 'pending', authority: 'automatic', checks: heldChecks, proofPath } };
        expect(() => assertActivityPublicationRetry(row, { status: 'needs_review' })).not.toThrow();
        await reviewActivityPublications([row], f.config, f.adapters);
        expect(f.adapters.request).not.toHaveBeenCalled();
        f.adapters.request.mockResolvedValue({ text: JSON.stringify({ status: 'needs_review', checks: heldChecks, issues: ['P1实际画面待核'] }) });
        const [held] = await reviewActivityPublications([row], f.config, f.adapters, { retryUnavailable: true });
        expect(held.uploadReady).toBe(false);
        expect(f.adapters.approve).not.toHaveBeenCalled();
        const upgraded = JSON.parse(fs.readFileSync(held.activityReview.proofPath, 'utf8'));
        expect(upgraded).toMatchObject({ evidenceVersion: 3, evidenceUpgrade: { fromVersion: 2, fromProofPath: proofPath } });
        expect(() => assertActivityPublicationRetry(held, { status: 'needs_review' })).toThrow('upgrade');
        fs.writeFileSync(proofPath, JSON.stringify({ ...proof, responses: [{ status: 'rejected', checks: heldChecks }] }));
        expect(() => assertActivityPublicationRetry(row, { status: 'needs_review' })).toThrow('upgrade');
        fs.writeFileSync(proofPath, JSON.stringify(proof));
        f.adapters.check.mockResolvedValue({ contentSha256: 'changed' });
        f.adapters.request.mockClear();
        await reviewActivityPublications([row], f.config, f.adapters, { retryUnavailable: true });
        expect(f.adapters.request).not.toHaveBeenCalled();
    } finally { fs.rmSync(f.directory, { recursive: true, force: true }); }
});

test('labelled P sample sheets preserve three distinct full frames and place labels outside source pixels', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-sheet-'));
    try {
        const sharp = (await import('sharp')).default;
        const samples = [];
        for (const [index, colour] of ['#ff0000', '#00ff00', '#0000ff'].entries()) {
            const file = path.join(directory, `${index}.jpg`);
            await sharp({ create: { width: 320, height: 180, channels: 3, background: colour } }).jpeg().toFile(file);
            samples.push({ path: file, label: ['BEGIN', 'MIDDLE', 'END'][index] });
        }
        const output = path.join(directory, 'sheet.jpg');
        await writeActivitySampleSheet(samples, output);
        const meta = await sharp(output).metadata();
        expect(meta).toMatchObject({ width: 960, height: 1728 });
        for (const [index, channel] of [0, 1, 2].entries()) {
            const pixel = await sharp(output).extract({ left: 480, top: index * 576 + 306, width: 1, height: 1 }).raw().toBuffer();
            expect(pixel[channel]).toBeGreaterThan(240);
            expect(pixel[(channel + 1) % 3]).toBeLessThan(15);
        }
        await expect(writeActivitySampleSheet(samples.slice(0, 2), output)).rejects.toThrow('BEGIN/MIDDLE/END');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('partitioning full P text covers every cue and reaction while keeping outer context in each batch',()=>{
    const cues=Array.from({length:6},(_,index)=>({id:`T${index}`,start:100+index*10,end:105+index*10,text:'原话'}));
    const audience=cues.map(cue=>({time:cue.start,text:'弹幕'}));
    const text={activities:[{cues,audience,before:[{text:'开始语境'}],after:[{text:'结束语境'}]}]};
    const batches=[[{start:100,end:130}],[{start:130,end:160}]].map(parts=>activityPublicationBatchText(text,parts));
    expect(batches.flatMap(batch=>batch.activities[0].cues)).toEqual(cues);
    expect(new Set(batches.flatMap(batch=>batch.activities[0].audience.map(cue=>cue.time))).size).toBe(6);
    expect(batches.every(batch=>batch.activities[0].after[0].text==='结束语境')).toBe(true);
    expect(batches.every(batch=>batch.activities[0].cues.length===3)).toBe(true);
});

test('disabled policy, old or manually imported packages never contact the reviewer',async()=>{
    const f=fixture();
    try{
        expect(activityPublicationEnabled(f.config,'other')).toBe(false);
        const old={...f.row,generatedAt:'2026-10-04T00:00:00Z'},manual={...f.row,activityAutomaticPublicationRequired:false};
        expect(await reviewActivityPublications([old,manual],f.config,f.adapters)).toEqual([old,manual]);
        f.config.streamActivityClips.automaticPublication.mode='off';
        await reviewActivityPublications([f.row],f.config,f.adapters);
        expect(f.adapters.check).not.toHaveBeenCalled();expect(f.adapters.request).not.toHaveBeenCalled();
    }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test.each(['uncertain boundaries','failed final','policy changed during review','missing frames'])(
    '%s preserves the pending package without approval',async failure=>{
    const f=fixture();
    try{
        if(failure==='uncertain boundaries') f.adapters.check.mockRejectedValue(new Error('complete boundaries remain uncertain'));
        if(failure==='failed final') f.adapters.request.mockResolvedValue({text:JSON.stringify({...passed,checks:{...checks,titles:false},status:'needs_review',issues:['标题不符']})});
        if(failure==='policy changed during review') f.adapters.approve.mockRejectedValue(new Error('policy changed'));
        if(failure==='missing frames') f.adapters.inspect.mockResolvedValue([picture]);
        const [row]=await reviewActivityPublications([f.row],f.config,f.adapters);
        expect(row.uploadReady).toBe(false);expect(row.activityReview.status).toBe('pending');
        expect(row.activityReview.issues.length).toBeGreaterThan(0);
        await enqueueActivityPublications([row],[],{},f.adapters);
        expect(f.adapters.enqueue).not.toHaveBeenCalled();
        if(failure==='uncertain boundaries'||failure==='missing frames') expect(f.adapters.request).not.toHaveBeenCalled();
    }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});

test('queued/uploaded IDs and unknown receipts do not cause duplicate submissions on recovery',async()=>{
    const f=fixture();
    try{
        const row={...f.row,uploadReady:true,activityReview:{status:'approved',authority:'automatic'}};
        const clips=[{metadataPath:f.row.output.metadataPath,reviewIndex:1}];
        const registry={clipIdsByReviewIndex:{1:3112},clipStatusByReviewIndex:{1:'queued'}};
        expect((await enqueueActivityPublications([row],clips,registry,f.adapters)).results[0].status).toBe('queued');
        expect(f.adapters.enqueue).not.toHaveBeenCalled();
        registry.clipStatusByReviewIndex[1]='review';
        f.adapters.enqueue.mockResolvedValue('receipt lost');
        const receipt=await enqueueActivityPublications([row],clips,registry,f.adapters);
        expect(receipt.results[0].status).toBe('unknown');
        await enqueueActivityPublications([row],clips,registry,f.adapters,receipt);
        expect(f.adapters.enqueue).toHaveBeenCalledTimes(1);
        f.adapters.enqueue.mockClear();
        expect((await enqueueActivityPublications([row],[],registry,f.adapters)).results[0].status).toBe('blocked');
        expect(f.adapters.enqueue).not.toHaveBeenCalled();
    }finally{fs.rmSync(f.directory,{recursive:true,force:true});}
});
