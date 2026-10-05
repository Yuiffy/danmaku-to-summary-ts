export {};
const fs=require('fs'),os=require('os'),path=require('path');
const { produceOwnClips }=require('./own_production');

test.each([false,true])('source content review precedes all media work, including incremental batches (%s)',async streaming=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'source-before-render-'));
    const mediaPath=path.join(directory,'source.mp4'),srtPath=path.join(directory,'source.srt');
    fs.writeFileSync(mediaPath,'fixture video');fs.writeFileSync(srtPath,'fixture text');
    const clips=[{start:100,end:120,title:'hold'},{start:150,end:170,title:'pass'}],events:string[]=[];
    const context={clips,options:{mediaPath,srtPath},outputRoot:directory,info:{roomId:'25788785',streamerName:'岁己'},
        parsed:{segments:[]},danmaku:[],evidence:{sourceSha256:'fixture',cues:[{id:'G1',start:101,end:102,text:'疑词'}, {id:'G2',start:151,end:152,text:'观点'}]},
        diagnostics:{requests:[]},metadata:{aiStatus:{}},rootConfig:{ai:{text:{enabled:true}}},
        config:{streamReviewRendering:streaming,clipConcurrency:1,clipResourceAdaptive:{enabled:false},ai:{enabled:true},selectionPolicy:{excludedCategories:[]},
            attribution:{sourceReviewBeforeRender:true,roomIds:['25788785']}}};
    const media=jest.fn((clip)=>events.push(`media-${clip.title}`));
    const hooks={review:async(batch,options)=>{if(options?.onBatchReviewed)await options.onBatchReviewed(batch.map((clip,index)=>({clip,index})));return batch;},
        sourceReviewRequest:async(prompt)=>{
            events.push('source-review');const packet=JSON.parse(prompt.split('\n').at(-1));
            return {text:JSON.stringify({reviews:packet.packets.map(row=>({clipId:row.clipId,status:row.copy.title==='hold'?'needs_review':'passed',
                checks:{content:true,subtitles:row.copy.title!=='hold',policy:true},issues:row.copy.title==='hold'?['字幕疑词待核']:[]}))})};
        },prepare:async(batch)=>({clips:batch}),stats:()=>({}),render:async(clip,index,execution)=>{
            const held=clip.sourceReview.status!=='passed',metadataPath=path.join(directory,`${index}.json`);
            const output={metadataPath,mediaPath:held?null:path.join(directory,`${index}.mp4`),srtPath:path.join(directory,`${index}.srt`),burnedSubtitles:!held};
            if(!held){media(clip);fs.writeFileSync(output.mediaPath,'rendered');}fs.writeFileSync(output.srtPath,'subtitles');
            const result={window:{index:index+1,...clip},sourceReview:clip.sourceReview,preRenderHold:held,uploadReady:!held,output};
            fs.writeFileSync(metadataPath,JSON.stringify(result));await execution.finishMedia(false);return result;
        }};
    try {
        const result=await produceOwnClips(context,hooks);
        expect(media).toHaveBeenCalledTimes(1);expect(events).toEqual(['source-review','media-pass']);
        expect(result.results[0]).toMatchObject({preRenderHold:true,output:{mediaPath:null}});
        const plan=JSON.parse(fs.readFileSync(result.planPath,'utf8'));
        expect(plan.clips[0].sourceReview.issues).toEqual(['字幕疑词待核']);
    } finally{fs.rmSync(directory,{recursive:true,force:true});}
});
