const fs = require('fs');
const os = require('os');
const path = require('path');
const workflow = require('./full_reply_workflow');
const full = require('./full_live_context');
const summary = require('./live_content_summary');
const loader = require('./config-loader');
const combined = require('./full_reply_summary');
const review = require('./reply_summary_review');
const live = require('./live_generation_context');

describe('combined reply/summary publication workflow', () => {
  let dir: string;
  let highlight: string;
  let config: any;
  let payload: any;
  const reply = 'Wow! The team defeated the boss after a careful practice round. The coffee break joke made everyone laugh, and the whole evening felt welcoming. Rest well after the stream!';
  const draft = () => ({ reply, content: { overview:'Team practice and Chess.',activityTypes:['game'],songs:[],games:['Chess'],topics:['Team practice'] }, evidence:[
    {target:'reply',value:'The team defeated the boss',sourceIds:['T1'],actor:'team'},
    {target:'game',value:'Chess',sourceIds:['T3'],actor:'host'}
  ]});
  const result = (text: string, id: string) => ({ text,meta:{provider:'daiYu',model:'gpt-5.6-luna',attempts:[{
    provider:'daiYu',model:'gpt-5.6-luna',status:'success',requestStarted:true,responseId:id,requestId:`req-${id}`,
    promptTokens:1000,cachedTokens:0,completionTokens:100,reasoningTokens:50,totalTokens:1100
  }]}});
  beforeEach(() => {
    dir=fs.mkdtempSync(path.join(os.tmpdir(),'paired-reply-test-'));
    highlight=path.join(dir,'stream_AI_HIGHLIGHT.txt');
    fs.writeFileSync(highlight,'Original highlight content');
    config={ai:{defaultWordLimit:250,roomSettings:{'1':{anchorName:'Host',fanName:'Fans',wordLimit:250,
      fullLiveContextExperiment:{enabled:true,tasks:['goodnight','comic','summary'],replySummary:{enabled:true}}}}}};
    jest.spyOn(loader,'getNames').mockReturnValue({anchor:'Host',fan:'Fans'});
    jest.spyOn(loader,'getWordLimit').mockReturnValue(250);
    const source=full.buildFullLiveSharedContext({parsed:{segments:[
      {start:10,end:15,text:'[Guest 0.8] The team defeated the boss after a careful practice round.'},
      {start:17,end:20,text:'[Host 0.9] The coffee break joke made everyone laugh.'},
      {start:30,end:35,text:'[Host 0.9] We are playing Chess now.'}
    ]},danmaku:[{time:31,text:'Chess was fun today'}],config:{compactEvidence:true},info:{roomId:'1',streamTitle:'Test'}});
    payload=full.saveFullLiveContextSidecar(highlight,source).payload;
  });
  afterEach(() => { jest.restoreAllMocks();fs.rmSync(dir,{recursive:true,force:true}); });

  test('publishes two compatible artifacts after review, with one canonical usage ledger', async () => {
    const generate=jest.fn().mockResolvedValueOnce(result(JSON.stringify(draft()),'draft')).mockResolvedValueOnce(result('{"verdict":"pass","issues":[]}','review'));
    const got=await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate});
    expect(got.handled).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][1].responseFormat).toMatchObject({type:'json_schema',strict:true,
      schema:{properties:{content:{type:'object'}}}});
    expect(generate.mock.calls[1][1]).not.toHaveProperty('responseFormat');
    const files=workflow.pathsFor(highlight);
    const state=JSON.parse(fs.readFileSync(files.artifact,'utf8'));
    expect(state.status).toBe('success');
    expect(state.attempts.map((a:any)=>a.responseId)).toEqual(['draft','review']);
    expect(fs.readFileSync(files.reply,'utf8')).toContain(reply);
    const overview=summary.readReusableSummary(files.summary,payload.sourceSha256,payload.sharedPrefixSha256);
    expect(overview.content.games).toEqual(['Chess']);
    expect(overview.generation.attempts).toEqual([]);
    expect(overview.generation.sharedUsagePath).toBe(path.basename(files.artifact));
    expect(fs.readdirSync(dir).some((n:string)=>n.endsWith('.lock')||n.endsWith('.tmp'))).toBe(false);
  });

  test('keeps accepted replies when optional material is invalid and requests complete-source fallback', async () => {
    config.ai.roomSettings['1'].fullLiveContextExperiment.replySummary.sharedMaterial = { enabled: true };
    const generate = jest.fn().mockResolvedValueOnce(result(JSON.stringify(draft()), 'draft'))
      .mockResolvedValueOnce(result('{"verdict":"pass","issues":[]}', 'review'));
    const got = await workflow.tryGenerateCombinedReply(highlight, '1', { config, generateText: generate });
    expect(got.handled).toBe(true);
    const state = JSON.parse(fs.readFileSync(workflow.pathsFor(highlight).artifact, 'utf8'));
    expect(state.sharedMaterial.status).toBe('fallback');
    expect(state.output.reply).toBe(reply);
    expect(state.attempts).toHaveLength(2);
    expect(generate.mock.calls[0][0]).toContain('Shared source selection');
    expect(generate.mock.calls[0][1].responseFormat.schema.required).toContain('moments');
  });

  test('still refuses malformed content from a nonconforming gateway and retains its charged attempt', async () => {
    const malformed = {...draft(),content:'Team practice and Chess.'};
    const generate = jest.fn().mockResolvedValue(result(JSON.stringify(malformed),'bad-content'));
    expect((await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).handled).toBe(false);
    const files=workflow.pathsFor(highlight);
    const saved=JSON.parse(fs.readFileSync(files.artifact,'utf8'));
    expect(saved.error).toContain('Invalid content: expected an object');
    expect(saved.attempts[0]).toMatchObject({responseId:'bad-content',promptTokens:1000,completionTokens:100});
    expect(fs.existsSync(files.reply)).toBe(false);
    expect(fs.existsSync(files.summary)).toBe(false);
    expect((await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).reason).toBe('reuse-terminal-fallback');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('recovers a missing reply from the committed artifact without another model call', async () => {
    const generate=jest.fn().mockResolvedValueOnce(result(JSON.stringify(draft()),'draft')).mockResolvedValueOnce(result('{"verdict":"pass","issues":[]}','review'));
    await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate});
    fs.unlinkSync(workflow.pathsFor(highlight).reply);
    const second=await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate});
    expect(second.handled).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  test('carries the same post through generation and evidence review without changing the shared live source', async () => {
    const context = { schemaVersion: live.SCHEMA_VERSION, roomId: '1', replyDynamic: {
      id: 'post-1', publishTime: '2026-08-01T15:15:00.000Z', content: 'Going to eat noodles before bed.'
    } };
    fs.writeFileSync(live.getLiveContextPath(highlight), JSON.stringify(context));
    const withPost = draft();
    withPost.reply += ' Enjoy your noodles!';
    withPost.evidence.push({ target: 'reply', value: 'Enjoy your noodles', sourceIds: ['P1'], actor: 'host' });
    const generate = jest.fn().mockResolvedValueOnce(result(JSON.stringify(withPost), 'draft'))
      .mockResolvedValueOnce(result('{"verdict":"pass","issues":[]}', 'review'));
    expect((await workflow.tryGenerateCombinedReply(highlight, '1', { config, generateText: generate })).handled).toBe(true);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0].startsWith(payload.sharedPrefix)).toBe(true);
    expect(payload.sharedPrefix).not.toContain(context.replyDynamic.content);
    expect(generate.mock.calls[0][0]).toContain(context.replyDynamic.content);
    expect(generate.mock.calls[1][0]).toContain(context.replyDynamic.content);
    expect(generate.mock.calls[1][0]).toContain('do not delete it merely because it was not spoken on stream');
    expect(generate.mock.calls[1][0]).not.toContain('NaN');
    const state = JSON.parse(fs.readFileSync(workflow.pathsFor(highlight).artifact, 'utf8'));
    expect(state.replyDynamic).toEqual(context.replyDynamic);
    expect(state.output.reply).toBe(withPost.reply);
    expect(state.output.content.games).toEqual(['Chess']);

    const source = combined.evidenceContext(payload.evidence.speech, [], '1', config, payload.evidence, context);
    const packet = review.buildReviewPacket(state.output, source);
    expect(packet.byId.has('P1')).toBe(true);
    const repaired = review.applyReview(JSON.stringify({ verdict: 'corrected',
      issues: [{ target: 'reply', reason: 'Post says noodles before bed.', sourceIds: ['P1'] }], corrected: withPost
    }), state.output, packet, source, '1', 250);
    expect(repaired.output.reply).toBe(withPost.reply);

    context.replyDynamic.content = 'A different post arrived after generation.';
    fs.writeFileSync(live.getLiveContextPath(highlight), JSON.stringify(context));
    expect((await workflow.tryGenerateCombinedReply(highlight, '1', { config, generateText: generate })).reason)
      .toBe('existing-artifacts');
    expect(generate).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(workflow.pathsFor(highlight).reply, 'utf8')).toContain(withPost.reply);
  });

  test('preserves existing human or legacy output and does not spend a combined request', async () => {
    const files=workflow.pathsFor(highlight);fs.writeFileSync(files.reply,'Existing reply');
    const generate=jest.fn();
    expect((await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).handled).toBe(false);
    expect(generate).not.toHaveBeenCalled();expect(fs.readFileSync(files.reply,'utf8')).toBe('Existing reply');
  });

  test('retains terminal validation failure and selects fallback without regenerating combined text', async () => {
    const generate=jest.fn().mockResolvedValue(result('{"reply":"bad"}','bad'));
    expect((await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).handled).toBe(false);
    expect((await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).reason).toBe('reuse-terminal-fallback');
    expect(generate).toHaveBeenCalledTimes(1);
    const files=workflow.pathsFor(highlight);expect(fs.existsSync(files.reply)).toBe(false);expect(fs.existsSync(files.summary)).toBe(false);
    expect(JSON.parse(fs.readFileSync(files.artifact,'utf8')).attempts).toHaveLength(1);
  });

  test.each(['queued','transport','malformed-200'])('halts the remaining AI workflow on %s uncertainty', async kind => {
    const error=Object.assign(new Error('unresolved'),{attempts:[{status:'failure',requestStarted:true,
      ...(kind==='queued'?{finishReason:'queued',usageFinal:false}:kind==='malformed-200'?{httpStatus:200}:{}),usageUnknown:true}]});
    const generate=jest.fn().mockRejectedValue(error);
    await expect(workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).rejects.toMatchObject({stopPostStreamGeneration:true});
    await expect(workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).rejects.toMatchObject({stopPostStreamGeneration:true});
    expect(generate).toHaveBeenCalledTimes(1);
    const files=workflow.pathsFor(highlight);expect(JSON.parse(fs.readFileSync(files.artifact,'utf8')).status).toBe('outcome_unknown');
    expect(fs.existsSync(files.reply)).toBe(false);
  });

  test('does not submit while the standalone summary owns its lock', async () => {
    const files=workflow.pathsFor(highlight);fs.writeFileSync(files.summary+'.lock','busy');
    const generate=jest.fn();
    await expect(workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).rejects.toMatchObject({code:'REPLY_SUMMARY_PENDING'});
    expect(generate).not.toHaveBeenCalled();expect(fs.readFileSync(files.summary+'.lock','utf8')).toBe('busy');
    expect(fs.existsSync(files.reply+'.lock')).toBe(false);
  });

  test('keeps all other rooms and disabled experiments unchanged', async () => {
    const generate=jest.fn();
    expect((await workflow.tryGenerateCombinedReply(highlight,'2',{config,generateText:generate})).handled).toBe(false);
    config.ai.roomSettings['1'].fullLiveContextExperiment.replySummary.enabled=false;
    expect((await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).handled).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  test('honors the global text switch and a different provider', async () => {
    const generate=jest.fn();config.ai.text={enabled:false,provider:'daiYu'};
    expect((await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).handled).toBe(false);
    config.ai.text={enabled:true,provider:'tuZi'};
    expect((await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).handled).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });

  test('production enables the recipe only in the two requested rooms', () => {
    const production=require('./workflow-runtime').loadWorkflow('config/layers').loadConfigLayers({env:{NODE_ENV:'production'}});
    expect(Object.entries(production.ai.roomSettings).filter(([,r]:any)=>r.fullLiveContextExperiment?.replySummary?.enabled)
      .map(([id])=>id).sort()).toEqual(['30655190','31368705']);
    expect(production.ai.roomSettings['26966466'].wordLimit).toBe(250);
    expect(production.ai.roomSettings['25788785'].wordLimit).toBe(800);
  });

  test('does not materialize a corrupted success cache', async () => {
    const generate=jest.fn().mockResolvedValueOnce(result(JSON.stringify(draft()),'draft')).mockResolvedValueOnce(result('{"verdict":"pass","issues":[]}','review'));
    await workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate});
    const files=workflow.pathsFor(highlight);fs.unlinkSync(files.reply);
    const state=JSON.parse(fs.readFileSync(files.artifact,'utf8'));state.output.reply='Tampered';fs.writeFileSync(files.artifact,JSON.stringify(state));
    await expect(workflow.tryGenerateCombinedReply(highlight,'1',{config,generateText:generate})).rejects.toThrow('integrity');
    expect(generate).toHaveBeenCalledTimes(2);expect(fs.existsSync(files.reply)).toBe(false);
  });

  test('rejects an unseen repair citation and preserves pass output verbatim', () => {
    const source=combined.evidenceContext(payload.evidence.speech,[], '1',config,payload.evidence);
    const output=combined.validateCombinedResult(JSON.stringify(draft()),source,'1',250);
    const packet=review.buildReviewPacket(output,source);
    expect(review.applyReview('{"verdict":"pass","issues":[]}',output,packet,source,'1',250).output).toBe(output);
    expect(()=>review.applyReview(JSON.stringify({verdict:'corrected',issues:[{reason:'wrong',sourceIds:['T9999']}],corrected:draft()}),output,packet,source,'1',250)).toThrow('unseen');
  });
});
