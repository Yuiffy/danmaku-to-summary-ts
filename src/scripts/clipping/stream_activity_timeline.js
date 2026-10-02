'use strict';
const { fileDigest } = require('./source_snapshot');
const { parseEvents, mergeEvents } = require('./stream_activity_plan');
const TIMELINE_VERSION = 1;
function timelineInstructions() {
    return `同时顺便输出 activityTimeline，只用于本场歌切/同步视听的粗定位，不必精确到音符。
通读同一份整场输入，列出每次主播实际演唱（整首或有歌词的片段）和每个完整同步观看会话；重复演唱各占一项。未知歌名也保留 name:null。BGM、影片歌声、只点歌未唱、随口音效和只聊影片不算实际活动。
观看会话包含暂停、反应和讨论，不能只列高光或把跨段的同一部电影拆成几个片段。歌曲的主歌、副歌、间奏属于同一次演唱。
start/end 是录播起点起算的数字秒数，给出大致完整起止，稍后只校准附近短音频；不猜超出输入的边界。歌名/片名必须有原文依据，不能从歌词猜名。evidenceIds 使用实际 T/D 行；titleEvidenceIds 是包含该标题的引用。没有标题依据就 name:null。
activityTimeline 格式：{"version":${TIMELINE_VERSION},"status":"complete","events":[{"kind":"song|watch","start":100,"end":300,"name":null,"performance":"full|fragment"（song）,"mediaKind":"movie|anime|video"（watch）,"startObserved":true,"endObserved":true,"evidenceIds":["T1"],"titleEvidenceIds":[]}]}
确实没有活动时 events:[]；输入不足或未检查完时 status:"incomplete"，不能把缺少时间线当成没有唱歌。其他梗概字段保持原格式。`;
}
function evidenceFromContext(payload) {
    if (!payload.evidence?.speech || !payload.evidence?.audience) throw new Error('Summary activity timeline needs timestamped source evidence');
    return [...payload.evidence.speech.map(r => ({ ...r, source: 'audio_transcript' })),
        ...payload.evidence.audience.map(r => ({ ...r, source: 'audience' }))];
}
function normalizeTimeline(raw, payload) {
    if (raw?.version !== TIMELINE_VERSION || raw.status !== 'complete' || !Array.isArray(raw.events)) throw new Error('Summary activity timeline is missing or incomplete');
    const rows = evidenceFromContext(payload), duration = Math.max(0, ...rows.map(r => r.end));
    const events = mergeEvents(parseEvents({ events: raw.events }, { index: 1, start: 0, end: duration, from: 0, to: duration, rows }, duration));
    return { version: TIMELINE_VERSION, status: 'complete', events, sourceSha256: payload.sourceSha256 };
}
function sourceInputs(srtPath, xmlPath) {
    return { srtPath, srtSha256: fileDigest(srtPath), xmlPath: xmlPath || null, xmlSha256: xmlPath ? fileDigest(xmlPath) : null };
}
module.exports = { TIMELINE_VERSION, timelineInstructions, evidenceFromContext, normalizeTimeline, sourceInputs };
