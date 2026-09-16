'use strict';
const {buildSharedLiveResponseFormat}=require('./live_output_schema');
const VERSION=1;
const TASKS=new Set(['reply-summary','comic']);

function prepareSharedLiveOutput(prompt,options) {
    if(!options.sharedOutputTask)return {prompt,options};
    const task=options.sharedOutputTask;
    if(!TASKS.has(task))throw new Error(`Unsupported shared output task: ${task}`);
    const suffix=`\n\nShared output protocol v${VERSION}. Current task is ${task}. Return exactly {"result":{"task":"${task}","payload":...}}. `
        +(task==='comic'?'payload is one string containing the complete comic script and reference JSON lines requested above, with its exact newlines. Do not generate a reply or overview.':
            'payload is the complete reply/content/evidence OBJECT required above; content remains an object with all five fields. Do not generate a comic.')
        +' This outer wrapper only changes the transport format; keep every factual, style and evidence rule above.';
    return {prompt:prompt.endsWith(suffix)?prompt:prompt+suffix,
        options:{...options,responseFormat:buildSharedLiveResponseFormat()}};
}

function unwrapSharedLiveOutput(text,task) {
    if(!task)return text;
    if(!TASKS.has(task))throw new Error(`Unsupported shared output task: ${task}`);
    const raw=JSON.parse(text);
    if(!raw || Array.isArray(raw) || Object.keys(raw).length!==1 || !raw.result || Array.isArray(raw.result)
        || raw.result.task!==task || Object.keys(raw.result).length!==2 || !Object.hasOwn(raw.result,'payload')) {
        throw new Error(`Shared output response does not match the requested task: expected=${task}, received=${String(raw?.result?.task).slice(0,32)}, rootKeys=${Object.keys(raw||{}).join(',').slice(0,100)}`);
    }
    const payload=raw.result.payload;
    if(task==='comic') {
        if(typeof payload!=='string'||!payload.trim())throw new Error('Shared comic payload is empty or not text');
        return payload;
    }
    if(!payload || typeof payload!=='object' || Array.isArray(payload) || !payload.content || typeof payload.content!=='object'
        || Array.isArray(payload.content) || !['overview','activityTypes','songs','games','topics'].every(k=>Object.hasOwn(payload.content,k))) {
        throw new Error('Shared reply payload has invalid structured content');
    }
    return JSON.stringify(payload);
}

module.exports={VERSION,prepareSharedLiveOutput,unwrapSharedLiveOutput};
