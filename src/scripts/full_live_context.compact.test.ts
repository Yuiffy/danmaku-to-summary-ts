const fs = require('fs');
const os = require('os');
const path = require('path');
const full = require('./full_live_context');
const live = require('./live_generation_context');

describe('compact full-source evidence format', () => {
  const parsed = {segments:[
    {start:1,end:3,text:'[Host 0.8] First complete thought.'},
    {start:3.2,end:5,text:'[Host 0.9] Second complete thought.'},
    {start:6,end:8,text:'[Guest 0.7] A distinct speaker speaks.'},
    {start:100,end:105,text:'[Host 0.8] The last quiet topic is preserved.'}
  ]};
  const audience = [{time:2,text:'same reaction'},{time:3,text:'same reaction'},
    {time:4,text:'a different reaction'},{time:104,text:'late audience comment'}];

  test('preserves every source segment, speaker boundary and late audience message', () => {
    const source=full.buildFullLiveSharedContext({parsed,danmaku:audience,config:{compactEvidence:true},info:{roomId:'1'}});
    expect(source.evidence.speech.flatMap((r:any)=>r.sourceIndices)).toEqual([0,1,2,3]);
    expect(source.evidence.speech.map((r:any)=>r.speaker)).toEqual(['Host','Guest','Host']);
    for(const row of parsed.segments)expect(source.sourceText).toContain(row.text.replace(/^\[[^\]]+\]\s*/u,''));
    expect(source.evidence.audience).toHaveLength(3);
    expect(source.evidence.audience[0].count).toBe(2);
    expect(source.sourceText).toContain('late audience comment');
    const sidecar=full.createFullLiveContextSidecar(source);
    expect(sidecar.counts.mergedDanmaku).toBe(3);
    expect(sidecar.evidenceVersion).toBe(2);
    expect(sidecar.roomId).toBe('1');
  });

  test('leaves the original full-source format unchanged when disabled', () => {
    const old=full.buildFullLiveSharedContext({parsed,danmaku:audience});
    const disabled=full.buildFullLiveSharedContext({parsed,danmaku:audience,config:{compactEvidence:false}});
    expect(full.createFullLiveContextSidecar(disabled)).toEqual(full.createFullLiveContextSidecar(old));
    expect(old.evidence).toBeUndefined();
    expect(old.subtitleLines[0]).toBe('00:00:01-00:00:03 [Host 0.8] First complete thought.');
  });

  test('falls back to original full input rather than dropping malformed-timing speech', () => {
    const source=full.buildFullLiveSharedContext({parsed:{segments:[{start:1,end:1,text:'Do not silently delete this sentence.'}]},
      danmaku:audience,config:{compactEvidence:true}});
    expect(source.evidence).toBeUndefined();
    expect(source.sourceText).toContain('Do not silently delete this sentence.');
  });

  test('rejects tampered evidence snapshots', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'compact-context-test-'));
    try {
      const source=full.buildFullLiveSharedContext({parsed,danmaku:audience,config:{compactEvidence:true}});
      const saved=full.saveFullLiveContextSidecar(path.join(dir,'test_AI_HIGHLIGHT.txt'),source);
      saved.payload.evidence.speech[0].text='Changed evidence';
      fs.writeFileSync(saved.outputPath,JSON.stringify(saved.payload));
      expect(()=>full.loadFullLiveContextSidecar(saved.outputPath)).toThrow('evidence hash mismatch');
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });

  test('does not apply new policy hints to reference rooms or disabled parent experiments', () => {
    const config={ai:{roomSettings:{'1':{contentHints:['Keep my original hint'],fullLiveContextExperiment:{enabled:false,replySummary:{enabled:true}}},
      '2':{fullLiveContextExperiment:{enabled:true,replySummary:{enabled:true}}},'3':{}}}};
    expect(live.getContentHints(config,'1')).toEqual(['Keep my original hint']);
    expect(live.getContentHints(config,'2').length).toBeGreaterThan(1);
    expect(live.getContentHints(config,'3')).toEqual([]);
  });
});
