export {};
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const cache = require('./live_cache_continuation');
const live = require('../live_generation_context');
const config = {ai:{text:{sharedPromptCache:{enabled:true,continuationEnabled:true},daiYu:{baseUrl:'https://example.invalid'}}}};
const prefix = `${live.SHARED_PROMPT_CACHE_START}\nAll original evidence [T1].\n${live.SHARED_PROMPT_CACHE_END}`;
const makeBody = (task = 'reply') => ({model:'gpt-5.6-luna',instructions:'Stable source policy',reasoning:{effort:'high'},
    store:false,stream:false,prompt_cache_key:'same-stream',input:[{role:'user',content:[
        {type:'input_text',text:prefix},{type:'input_text',text:task}]}]});
const response = () => ({status:'completed',model:'gpt-5.6-luna',output:[{type:'reasoning',id:'reasoning'},
    {type:'message',role:'assistant',status:'completed',id:'actual-message',content:[{type:'output_text',text:'Actual accepted response',annotations:[]}]}]});
let directory: string;
beforeEach(() => {directory=fs.mkdtempSync(path.join(os.tmpdir(),'live-cache-test-'));});
afterEach(() => {fs.rmSync(directory,{recursive:true,force:true});});

test('only explicitly accepted original responses become reusable; current task remains user data',()=>{
    const first=makeBody(),next=makeBody('comic; current reviewed facts');
    const seed=cache.captureSeed(first,response(),config);
    expect(cache.prepareContinuation(next,config,{directory})).toBe(next);
    expect(cache.acceptSeed(seed,config,{directory})).toBe(true);
    const continued=cache.prepareContinuation(next,config,{directory});
    expect(continued.input[0]).toEqual(first.input[0]);
    expect(continued.input[1]).toEqual(response().output[1]);
    expect(continued.input[2].role).toBe('user');
    expect(continued.input[2].content[0].text).toContain('NOT original evidence');
    expect(continued.input[2].content[1].text).toBe('comic; current reviewed facts');
    expect(continued.instructions).toBe(next.instructions);
    expect(next.input).toHaveLength(1);
    expect(cache.captureSeed(continued,response(),config)).toBeNull();
});

test.each(['model','reasoning','instructions','text','prompt_cache_key','source','endpoint'])(
    'does not reuse cached history across changed %s',field=>{
        cache.acceptSeed(cache.captureSeed(makeBody(),response(),config),config,{directory});
        const body:any=makeBody('comic'),cfg=structuredClone(config);
        if(field==='source')body.input[0].content[0].text=prefix.replace('T1','T2');
        else if(field==='endpoint')cfg.ai.text.daiYu.baseUrl='https://different.invalid';
        else body[field]=field==='reasoning'?{effort:'medium'}:field==='text'?{format:{type:'json_schema'}}:'different';
        expect(cache.prepareContinuation(body,cfg,{directory})).toBe(body);
    });

test('expiration, future timestamps and corrupt files fall back to the exact full request',()=>{
    const seed=cache.captureSeed(makeBody(),response(),config),body=makeBody('comic');
    cache.acceptSeed(seed,config,{directory});
    expect(cache.prepareContinuation(body,config,{directory,now:seed.createdAt+cache.TTL_MS})).toBe(body);
    expect(cache.prepareContinuation(body,config,{directory,now:seed.createdAt-1})).toBe(body);
    const file=path.join(directory,`${seed.key}.json`);
    fs.writeFileSync(file,'{broken');
    expect(cache.prepareContinuation(body,config,{directory})).toBe(body);
    fs.writeFileSync(file,JSON.stringify({...seed,messages:response().output}));
    expect(cache.prepareContinuation(body,config,{directory})).toBe(body);
});

test('skips disabled caching, incomplete responses, unexpected models, images and tools',()=>{
    const body:any=makeBody(),data:any=response();
    expect(cache.captureSeed(body,data,{})).toBeNull();
    expect(cache.prepareContinuation(body,{}, {directory})).toBe(body);
    for(const changed of [{...data,status:'incomplete'},{...data,model:'gpt-5.6-sol'},{...data,output:[]}]) {
        expect(cache.captureSeed(body,changed,config)).toBeNull();
    }
    expect(cache.captureSeed({...body,tools:[]},data,config)).toBeNull();
    body.input[0].content.push({type:'input_image',image_url:'data:image/png;base64,AAAA'});
    expect(cache.captureSeed(body,data,config)).toBeNull();
});

test('cache IO failure cannot turn a successful output into another model request',()=>{
    const seed=cache.captureSeed(makeBody(),response(),config);
    const file=path.join(directory,'not-a-directory');fs.writeFileSync(file,'owned');
    expect(cache.acceptSeed(seed,config,{directory:file})).toBe(false);
});
