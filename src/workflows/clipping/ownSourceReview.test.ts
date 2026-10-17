import { reviewOwnSourceCandidates, restoreOwnCandidatePlan } from './ownSourceReview';

const clips = [{start:100,end:120,title:'疑词片',uploadReady:true,attributionReview:{status:'passed'}},
    {start:150,end:170,title:'完整观点',uploadReady:true,attributionReview:{status:'passed'}}];
const input = () => ({enabled:true,roomId:'25788785',streamerName:'岁己',sourceSha256:'fixture',aiEnabled:true,
    cues:[{id:'G1',start:101,end:102,text:'还款是一千还是一万'},{id:'G2',start:155,end:158,text:'完整观点'},{id:'G3',start:168,end:169,text:'观点收尾'}],
    audience:[{time:106,text:'金额没听清'}],excludedCategories:['现实家庭关系'],diagnostics:{}});

test.each([true, false])('a no-clip signal holds before media and AI even with source review enabled=%s', async enabled => {
    const context = input(); context.enabled = enabled;
    context.cues[0].text = '刚才那个不要切了，别的可以切';
    const request = jest.fn();
    const [result] = await reviewOwnSourceCandidates([clips[0]], context, { snapshot: () => 'source', request });
    expect(result).toMatchObject({ uploadReady: false, publicCopyPending: true,
        clipIntent: { needsHumanReview: true }, sourceReview: { status: 'needs_review', issues: [expect.stringContaining('需人工核对')] } });
    expect(request).not.toHaveBeenCalled();
});

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
        expect(prompt).toContain('文案不依赖疑句时通过');
        expect(prompt).toContain('普通家人提及、童年坐车和无冲突的日常回忆允许');
        expect(prompt).toContain('若本房间明确有更广排除');
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

test('oversized combined source evidence is reviewed individually without dropping speech or approving a failed sibling', async () => {
    const context = input();
    context.cues[0].text = '金额不明确'.repeat(2400);
    context.cues[1].text = '完整观点'.repeat(3000);
    const request = jest.fn(async (prompt: string) => {
        expect(prompt.length).toBeLessThanOrEqual(36000);
        const { packets } = JSON.parse(prompt.split('\n').at(-1)!);
        expect(packets).toHaveLength(1);
        const packet = packets[0], unresolved = packet.clipId === 's1';
        const cue = context.cues[unresolved ? 0 : 1];
        expect(packet.retainedSpeech.some((row: any) => row.text === cue.text)).toBe(true);
        return { text: JSON.stringify({ reviews: [{ clipId: packet.clipId,
            status: unresolved ? 'needs_review' : 'passed',
            checks: { content: true, subtitles: !unresolved, policy: true },
            issues: unresolved ? ['核心金额未确认'] : [] }] }) };
    });
    const result = await reviewOwnSourceCandidates(clips, context, { snapshot: () => 'source', request });
    expect(request).toHaveBeenCalledTimes(2);
    expect(result[0]).toMatchObject({ uploadReady: false, sourceReview: { status: 'needs_review' } });
    expect(result[1].sourceReview.status).toBe('passed');
    expect(result[1].publicationDecision).toBeUndefined();
});

test('splitting oversized evidence shares the request cap and keeps an oversized singleton pending', async () => {
    const context = input();
    context.cues[0].text = '完整观点'.repeat(3000);
    context.cues[1].text = '另一观点'.repeat(3000);
    Object.assign(context, { maxRequests: 1 });
    const request = jest.fn(async (prompt: string) => {
        const { packets } = JSON.parse(prompt.split('\n').at(-1)!);
        return { text: JSON.stringify({ reviews: packets.map((packet: any) => ({ clipId: packet.clipId,
            status: 'passed', checks: { content: true, subtitles: true, policy: true }, issues: [] })) }) };
    });
    const result = await reviewOwnSourceCandidates(clips, context, { snapshot: () => 'source', request });
    expect(request).toHaveBeenCalledTimes(1);
    expect(result[0].sourceReview.status).toBe('passed');
    expect(result[1]).toMatchObject({ uploadReady: false, sourceReview: { status: 'unavailable' } });
    context.cues[0].text = '完整观点'.repeat(10000);
    context.diagnostics = {};
    request.mockClear();
    const [oversized] = await reviewOwnSourceCandidates([clips[0]], context, { snapshot: () => 'source', request });
    expect(oversized).toMatchObject({ uploadReady: false, sourceReview: { status: 'unavailable' } });
    expect(request).not.toHaveBeenCalled();
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

const boundaryRow = (action?: Record<string, any>) => ({clipId:'s1',status:action?'needs_review':'passed',
    checks:{content:!action,subtitles:true,policy:true},issues:action?['片尾“为什么”尚未回答']:[],boundaryAction:action || null});

test('pre-render tools read missing continuation, revise once, and independently review the new retained window', async () => {
    const context=input();
    context.cues=[{id:'G1',start:100,end:105,text:'开始讨论'}, {id:'G2',start:115,end:120,text:'为什么'},
        {id:'G3',start:160,end:175,text:'因为如此，所以结束'}, {id:'G4',start:180,end:190,text:'另一话题'}];
    const request=jest.fn().mockImplementationOnce(async prompt=>{
        const packet=JSON.parse(prompt.split('\n').at(-1)).packets[0];
        expect(packet.retainedSpeech.map(row=>row.text)).toEqual(['开始讨论','为什么']);
        expect(packet.hasLater).toBe(true);
        expect(packet.speech.some(row=>row.id==='G3')).toBe(false);
        return {text:JSON.stringify({reviews:[boundaryRow({tool:'read_context',beforeSeconds:30,afterSeconds:180,reason:'读取完整回答'})]})};
    }).mockImplementationOnce(async prompt=>{
        const packet=JSON.parse(prompt.split('\n').at(-1)).packets[0];
        expect(packet.contextOnlyAfter.some(row=>row.id==='G3')).toBe(true);
        expect(packet.retainedSpeech.some(row=>row.text.includes('结束'))).toBe(false);
        return {text:JSON.stringify({reviews:[boundaryRow({tool:'revise_window',startCueId:'G1',endCueId:'G3',reason:'保留回答'})]})};
    }).mockImplementationOnce(async prompt=>{
        const packet=JSON.parse(prompt.split('\n').at(-1)).packets[0];
        expect(packet.end).toBe(175);
        expect(packet.retainedSpeech.some(row=>row.text.includes('结束'))).toBe(true);
        return {text:JSON.stringify({reviews:[boundaryRow()]})};
    });
    const replan=jest.fn(async(original,window)=>({...original,...window,attributionRequired:true,
        attributionReview:{status:'passed'},boundaryReview:{approved:true},topicEditPlan:{continuation:'complete'}}));
    const [result]=await reviewOwnSourceCandidates([clips[0]],context,{snapshot:()=> 'source',request,replan});
    expect(replan).toHaveBeenCalledWith(clips[0],{start:100,end:175},expect.objectContaining({phase:'pre-render'}));
    expect(result).toMatchObject({start:100,end:175,sourceReview:{status:'passed',boundaryRepair:{status:'replanned_before_render'}}});
    expect(result.publicationDecision).toBeUndefined();expect(clips[0].end).toBe(120);
    expect(request).toHaveBeenCalledTimes(3);
});

test.each(['unread_id','too_far','ignored_requested_end','changed_source','failed_actor','second_replan','no_budget'])('unsafe boundary tool %s never admits media',async failure=>{
    const context=input();context.cues.push({id:'G4',start:122,end:125,text:'完整回答'});
    if(failure==='no_budget')Object.assign(context,{maxRequests:1});
    const action={tool:'revise_window',startCueId:'G1',endCueId:failure==='unread_id'?'G999':'G4',reason:'保留回答'};
    let snapshot='source';
    const request=jest.fn(async()=>({text:JSON.stringify({reviews:[boundaryRow(action)]})}));
    const replan=jest.fn(async(original,window)=>{
        if(failure==='changed_source')snapshot='changed';
        return {...original,...window,end:failure==='too_far'?999:failure==='ignored_requested_end'?124:window.end,attributionRequired:true,
            attributionReview:{status:failure==='failed_actor'?'needs_review':'passed'},boundaryReview:{approved:true},topicEditPlan:{continuation:'complete'}};
    });
    const [result]=await reviewOwnSourceCandidates([clips[0]],context,{snapshot:()=>snapshot,request,replan});
    expect(result.uploadReady).toBe(false);expect(result.publicCopyPending).toBe(true);
    expect(result.sourceReview.status).not.toBe('passed');
    expect(replan.mock.calls.length).toBe(failure==='unread_id'?0:1);
    expect(request.mock.calls.length).toBe(failure==='second_replan'?2:1);
});

test('a repaired boundary that expands into a later no-clip warning is held before another AI pass', async () => {
    const context = input();
    context.cues = [{ id:'G1', start:100, end:105, text:'讨论开始' }, { id:'G2', start:115, end:120, text:'还没讲完' },
        { id:'G3', start:160, end:175, text:'接着讲完了，这段别切' }];
    const request = jest.fn().mockResolvedValueOnce({ text:JSON.stringify({reviews:[boundaryRow({tool:'read_context',
        beforeSeconds:30,afterSeconds:180,reason:'读取后续'})]}) }).mockResolvedValueOnce({ text:JSON.stringify({reviews:[boundaryRow({tool:'revise_window',
        startCueId:'G1',endCueId:'G3',reason:'保留完整后续'})]}) });
    const replan = jest.fn(async (original, window) => ({ ...original, ...window, attributionRequired:true,
        attributionReview:{status:'passed'},boundaryReview:{approved:true},topicEditPlan:{continuation:'complete'} }));
    const [result] = await reviewOwnSourceCandidates([clips[0]], context, {snapshot:()=>'source',request,replan});
    expect(result).toMatchObject({uploadReady:false,clipIntent:{needsHumanReview:true},sourceReview:{status:'needs_review'}});
    expect(result.sourceReview.issues[0]).toContain('ASR疑似');
    expect(request).toHaveBeenCalledTimes(2);
});

test('partial subtitle groups expose actual retained items and do not include their outside answer',async()=>{
    const context=input();
    context.cues=[{id:'G1',start:115,end:130,text:'为什么，因为如此',items:[
        {start:115,end:120,text:'为什么'},{start:121,end:130,text:'因为如此'}]}] as any;
    const request=jest.fn(async prompt=>{
        const packet=JSON.parse(prompt.split('\n').at(-1)).packets[0];
        expect(packet.retainedSpeech.map(row=>row.text)).toEqual(['为什么']);
        return {text:JSON.stringify({reviews:[boundaryRow({tool:'hold',reason:'不能把组内窗外回答当成片内'})]})};
    });
    const [result]=await reviewOwnSourceCandidates([clips[0]],context,{snapshot:()=> 'source',request});
    expect(result.uploadReady).toBe(false);
});
