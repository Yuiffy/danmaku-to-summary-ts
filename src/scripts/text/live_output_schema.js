'use strict';

const ACTIVITY_TYPES = ['chat','singing','watch_movie','watch_anime','watch_bilibili','game','other'];
const EVIDENCE_TARGETS = ['reply','game','song'];
const ACTOR_KINDS = ['host','team','audience','uncertain','performance'];
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array = (items,maxItems,minItems=0) => ({type:'array',items,minItems,maxItems});

function buildCombinedResponseFormat(materialOptions=null) {
    const string={type:'string'};
    const sourceIds=array({type:'string',pattern:'^(?:[TD][0-9]+|P1)$'},6,1);
    const properties={
        reply:{type:'string',description:'Final natural reply within the configured character limit.'},
        content:object({overview:{type:'string',description:'A complete Chinese overview, at most 80 characters.'},
            activityTypes:array({type:'string',enum:[...ACTIVITY_TYPES]},7),songs:array(string,40),
            games:array(string,12),topics:array(string,10)}),
        evidence:array(object({target:{type:'string',enum:[...EVIDENCE_TARGETS]},value:string,sourceIds,
            actor:{type:'string',enum:[...ACTOR_KINDS]}}),24,2)
    };
    if(materialOptions)properties.moments=array(object({sourceIds:array({type:'string',pattern:'^[TD][0-9]+$'},6,1),interest:string}),materialOptions.maxMoments,4);
    return {type:'json_schema',name:materialOptions?'live_reply_summary_material':'live_reply_summary',strict:true,schema:object(properties)};
}

function buildSharedLiveResponseFormat() {
    return {type:'json_schema',name:'live_reply_comic_shared_v1',strict:true,schema:object({result:{anyOf:[
        object({task:{type:'string',enum:['reply-summary']},payload:buildCombinedResponseFormat().schema}),
        object({task:{type:'string',enum:['comic']},payload:{type:'string'}})
    ]}})};
}

module.exports={ACTIVITY_TYPES,EVIDENCE_TARGETS,ACTOR_KINDS,buildCombinedResponseFormat,buildSharedLiveResponseFormat};
