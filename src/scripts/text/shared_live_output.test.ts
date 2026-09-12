const {prepareSharedLiveOutput,unwrapSharedLiveOutput}=require('./shared_live_output');
const {buildCombinedResponseFormat,buildSharedLiveResponseFormat}=require('./live_output_schema');
const {buildDaiYuResponsesRequest}=require('../ai_text_generator');
const {getExplicitPromptCachePlan,getPromptCacheRequestDiagnostics,parseGenerateTextOptions}=require('../text_generation_protocol');
const live=require('../live_generation_context');

test('reply and comic use an identical strict schema and reusable prefix fingerprint',()=>{
  const prefix=`${live.SHARED_PROMPT_CACHE_START}\nOriginal facts with source identity.\n${live.SHARED_PROMPT_CACHE_END}`;
  const bodies=['reply-summary','comic'].map(task=>{
    const prepared=prepareSharedLiveOutput(prefix+'\nTask '+task,{sharedOutputTask:task});
    return buildDaiYuResponsesRequest({model:'gpt-5.6-luna',prompt:prepared.prompt,maxTokens:4000,thinkingEnabled:true,reasoningEffort:'high',
      cachePlan:getExplicitPromptCachePlan(prepared.prompt,{},'gpt-5.6-luna',100),responseFormat:prepared.options.responseFormat});
  });
  expect(bodies[0].text).toEqual(bodies[1].text);
  expect(getPromptCacheRequestDiagnostics(bodies[0])).toEqual(getPromptCacheRequestDiagnostics(bodies[1]));
  const schema=buildSharedLiveResponseFormat().schema.properties.result.anyOf[0].properties.payload;
  expect(schema).toEqual(buildCombinedResponseFormat().schema);
  expect(schema.properties.content.type).toBe('object');
});

test('unwraps only the requested result and preserves exact comic text and reference lines',()=>{
  const script='分镜1：原句。\n{"kind":"reference","timestampsSeconds":[12]}';
  expect(unwrapSharedLiveOutput(JSON.stringify({result:{task:'comic',payload:script}}),'comic')).toBe(script);
  const payload={reply:'Original reply',content:{overview:'Facts',activityTypes:[],songs:[],games:[],topics:[]},evidence:[]};
  expect(JSON.parse(unwrapSharedLiveOutput(JSON.stringify({result:{task:'reply-summary',payload}}),'reply-summary'))).toEqual(payload);
  expect(()=>unwrapSharedLiveOutput(JSON.stringify({result:{task:'comic',payload:script}}),'reply-summary')).toThrow('requested task');
  expect(()=>unwrapSharedLiveOutput(JSON.stringify({result:{task:'reply-summary',payload:{...payload,content:'flattened'}}}),'reply-summary')).toThrow('structured content');
  expect(()=>unwrapSharedLiveOutput('{"result":{"task":"comic","payload":""}}','comic')).toThrow('empty');
});

test('does not change ordinary requests or append the wrapper instruction twice on provider fallback',()=>{
  const options={responseFormat:{name:'existing'}};
  expect(prepareSharedLiveOutput('original',options)).toEqual({prompt:'original',options});
  const once=prepareSharedLiveOutput('original',{sharedOutputTask:'comic'});
  expect(prepareSharedLiveOutput(once.prompt,once.options)).toEqual(once);
  expect(parseGenerateTextOptions(['--shared-output-task','comic'])).toMatchObject({sharedOutputTask:'comic'});
  expect(()=>parseGenerateTextOptions(['--shared-output-task','arbitrary'])).toThrow('must be comic');
});
