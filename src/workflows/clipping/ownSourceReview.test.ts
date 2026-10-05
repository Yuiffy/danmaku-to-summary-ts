import { reviewOwnSourceCandidates, restoreOwnCandidatePlan } from './ownSourceReview';

const clips = [{start:100,end:120,title:'疑词片',uploadReady:true,attributionReview:{status:'passed'}},
    {start:150,end:170,title:'完整观点',uploadReady:true,attributionReview:{status:'passed'}}];
const input = () => ({enabled:true,roomId:'25788785',streamerName:'岁己',sourceSha256:'fixture',aiEnabled:true,
    cues:[{id:'G1',start:101,end:102,text:'还款是一千还是一万'},{id:'G2',start:155,end:158,text:'完整观点'},{id:'G3',start:168,end:169,text:'观点收尾'}],
    audience:[{time:106,text:'金额没听清'}],excludedCategories:['现实家庭关系'],diagnostics:{}});

test('passed attribution cannot admit an unresolved core amount; source passes only admit later media work', async () => {
    const request = jest.fn(async(prompt:string)=>{
        expect(prompt).toContain('还款是一千还是一万');
        expect(prompt).toContain('观点收尾');
        expect(prompt).toContain('金额没听清');
        return {text:JSON.stringify({reviews:[
            {clipId:'s1',status:'needs_review',checks:{content:true,subtitles:false,policy:true},issues:['还款金额“一千还是一万”不明确，影响核心事实']},
            {clipId:'s2',status:'passed',checks:{content:true,subtitles:true,policy:true},issues:[]}]})};
    });
    const original=JSON.stringify(clips);
    const result=await reviewOwnSourceCandidates(clips,input(),{snapshot:()=> 'source',request});
    expect(result[0]).toMatchObject({publicCopyPending:true,uploadReady:false,sourceReview:{status:'needs_review'}});
    expect(result[0].attributionReview.status).toBe('passed');
    expect(result[1].sourceReview.status).toBe('passed');
    expect(result[1].publicationReview).toBeUndefined();
    expect(result[1].publicationDecision).toBeUndefined();
    expect(JSON.stringify(clips)).toBe(original);
});

test('minor homophone errors are judged by factual impact without rewriting or granting publication', async () => {
    const context=input();
    context.cues[0].text='没有这种被凶的预气';
    const request=jest.fn(async(prompt:string)=>{
        expect(prompt).toContain('不要求逐字零错');
        expect(prompt).toContain('不要求额外ASR');
        expect(prompt).toContain('整段语境无歧义');
        expect(prompt).toContain('不因省略同义的“考虑”再次阻塞');
        return {text:JSON.stringify({reviews:[
            {clipId:'s1',status:'passed',checks:{content:true,subtitles:true,policy:true},issues:[]},
            {clipId:'s2',status:'passed',checks:{content:true,subtitles:true,policy:true},issues:[]}]})};
    });
    const result=await reviewOwnSourceCandidates(clips,context,{snapshot:()=> 'source',request});
    expect(result[0].sourceReview.status).toBe('passed');
    expect(result[0].publicationDecision).toBeUndefined();
    expect(context.cues[0].text).toBe('没有这种被凶的预气');
});

test.each(['ai_disabled','budget_zero','oversized','changed','bad_schema'])('%s holds source text without silently truncating, rendering or approving',async failure=>{
    const context=input();let snapshot=0;
    if(failure==='ai_disabled')context.aiEnabled=false;
    if(failure==='budget_zero')Object.assign(context,{maxRequests:0});
    if(failure==='oversized')Object.assign(context,{maxBatchChars:1});
    const request=jest.fn(async()=>({text:failure==='bad_schema'?'{}':JSON.stringify({reviews:[
        {clipId:'s1',status:'passed',checks:{content:true,subtitles:true,policy:true},issues:[]},
        {clipId:'s2',status:'passed',checks:{content:true,subtitles:true,policy:true},issues:[]}]})}));
    const result=await reviewOwnSourceCandidates(clips,context,{snapshot:()=>failure==='changed'?String(snapshot++):'source',request});
    expect(result.every(row=>row.uploadReady===false&&row.sourceReview.status==='unavailable')).toBe(true);
    if(['ai_disabled','budget_zero','oversized'].includes(failure))expect(request).not.toHaveBeenCalled();
});

test('restored low-score recall topics require matching source and detailed editing before any render',async()=>{
    const source={mediaPath:'fixture.mp4',srtPath:'fixture.srt'},refine=jest.fn(async()=>clips);
    const plan={source,requiresDetailPlanning:true,recallSourceSha256:'fixture',recallCandidates:[{index:8,start:100,end:200}]};
    expect(await restoreOwnCandidatePlan(plan,source,'fixture',refine)).toBe(clips);
    expect(refine).toHaveBeenCalledWith(plan.recallCandidates);
    refine.mockClear();
    await expect(restoreOwnCandidatePlan(plan,source,'changed',refine)).rejects.toThrow('current source');
    expect(refine).not.toHaveBeenCalled();
});
