const { parseCopyProposal, repairUnsupportedChapters } = require('./stream_game_editorial');
const fs = require('fs'), os = require('os'), path = require('path');
const { fileDigest } = require('./source_snapshot');
describe('factual game chapter repair proposals',()=>{
  const parse=(value:any,chapter:any={kind:'phase'})=>parseCopyProposal({text:JSON.stringify(value)},chapter);
  const proposal={title:'战后讨论与湖区探索',description:'讨论此前战斗，随后查看地图并沿水域探索。',reason:'Original phase words and water-traversal frames'};
  test('a supported draft changes copy without granting review or changing boundaries',()=>{
    expect(parse(proposal)).toEqual(proposal);
    expect(()=>parse({...proposal,description:''})).toThrow(/Invalid factual/);
  });
  test('a separately verified literal Boss title stays locked and names cannot be discarded',()=>{
    expect(()=>parse(proposal,{kind:'boss',nameEvidence:'熔炉骑士'})).toThrow(/discard a verified name/);
    const chapter={kind:'boss',title:'接肢葛瑞克战',nameEvidence:'接肢 葛瑞克',nameEvidenceSource:'original_frame'};
    expect(()=>parse({...proposal,title:'接肢葛瑞克挑战'},chapter)).toThrow(/discard a verified name/);
    expect(parse({...proposal,title:chapter.title},chapter).title).toBe(chapter.title);
  });
  test.each([false,true])('an overlapping proposal cites its actual phase when copy changes=%s',async(changesCopy:boolean)=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'game-editorial-citations-'));
    try {
      const srtPath=path.join(directory,'source.srt'), imagePath=path.join(directory,'frame.jpg');
      fs.writeFileSync(srtPath,'1\n00:00:05,000 --> 00:00:08,000\n此前已结束的战斗\n\n2\n00:00:20,000 --> 00:00:23,000\n看看要加什么属性\n\n3\n00:00:30,000 --> 00:00:33,000\n查看耐力再确认路线\n\n4\n00:00:45,000 --> 00:00:48,000\n接下来开始交战\n');
      fs.writeFileSync(imagePath,'original frame fixture');
      const chapters=[{start:20,title:'整理卢恩',kind:'phase',description:'整理卢恩并升级。',evidenceIds:['T1','T4']},
        {start:20,title:'升级与路线',kind:'phase',description:'查看属性选项。',evidenceIds:['T2']},
        {start:40,title:'下一阶段',kind:'phase',description:'继续战斗。',evidenceIds:['T4']}];
      if (!changesCopy) Object.assign(chapters[0],{title:'属性与路线讨论',description:'讨论属性分配与接下来的路线。'});
      const event={end:60,chapters}, source={id:'original-source'}, verification={decision:'uncertain',
        chapterReviews:[{index:1,supported:false,reason:'No confirmed rune action'}],
        originalFrameEvidence:[{index:1,time:25,path:imagePath,sha256:fileDigest(imagePath)}]};
      const request=jest.fn(async(prompt:string)=>{
        expect(prompt).toContain('"id":"T2"');expect(prompt).toContain('"id":"T3"');
        expect(prompt).not.toContain('此前已结束的战斗');expect(prompt).not.toContain('接下来开始交战');
        return {text:JSON.stringify({title:'属性与路线讨论',description:'讨论属性分配与接下来的路线。',reason:'Original phase speech supports the discussion.'})};
      });
      expect(await repairUnsupportedChapters(event,{source},verification,{srtPath,config:{},editorialRequest:request},{directory},{})).toBe(true);
      expect(event.chapters[0]).toMatchObject({evidenceIds:['T2','T3'],editorialRevision:{phaseStart:20,phaseEnd:40,originalEvidenceIds:['T1','T4']}});
      expect(verification.decision).toBe('uncertain');
    } finally {fs.rmSync(directory,{recursive:true,force:true});}
  });
  test('a rejected legacy rewrite gets one concise repair and retains its history without granting approval', async () => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'game-editorial-legacy-'));
    try {
      const srtPath=path.join(directory,'source.srt'), imagePath=path.join(directory,'frame.jpg');
      fs.writeFileSync(srtPath,'1\n00:00:20,000 --> 00:00:23,000\n我要去找狼人\n\n2\n00:00:25,000 --> 00:00:28,000\n是不是坐风上去\n');
      fs.writeFileSync(imagePath,'original phase frame');
      const previousRevision={version:1,newCopy:{title:'地下路线',description:'骑乘经过崖边小径，随后查看地图。'},proposalSha256:'old-proposal'};
      const event={start:20,end:40,chapters:[{start:20,title:'地下路线',kind:'phase',description:previousRevision.newCopy.description,
        evidenceIds:['T1'],editorialRevision:previousRevision}]};
      const verification={decision:'uncertain',chapterReviews:[{index:1,supported:false,reason:'原文和画面没有证实骑乘经过崖边小径'}],
        originalFrameEvidence:[{index:1,time:25,path:imagePath,sha256:fileDigest(imagePath)}]};
      const editorialRequest=jest.fn(async () => ({text:JSON.stringify({title:'寻找狼人与路线讨论',description:'讨论寻找狼人及向上的路线。',reason:'原字幕两句只支持寻找和路线讨论。'})}));
      const options={srtPath,config:{},editorialRequest};
      expect(await repairUnsupportedChapters(event,{source:{id:'original'}},verification,options,{directory},{})).toBe(true);
      expect(event.chapters[0]).toMatchObject({start:20,description:'讨论寻找狼人及向上的路线。',editorialRevision:{policyVersion:2,previousRevision}});
      expect(verification.decision).toBe('uncertain');
      expect(await repairUnsupportedChapters(event,{source:{id:'original'}},verification,options,{directory},{})).toBe(false);
      expect(editorialRequest).toHaveBeenCalledTimes(1);
      expect(()=>parse({...proposal,description:'绕路探索'.repeat(20)})).toThrow(/Invalid factual/);
    } finally { fs.rmSync(directory,{recursive:true,force:true}); }
  });
});
