'use strict';
const { fileDigest } = require('./source_snapshot');
const { parseEvents, mergeEvents } = require('./stream_activity_plan');
const TIMELINE_VERSION = 1;
function timelineInstructions() {
    return `同时顺便输出 activityTimeline，只用于本场歌切/同步视听的粗定位，不必精确到音符。
通读同一份整场输入，列出每次主播实际演唱（整首或有歌词的片段）和每个完整同步观看会话；重复演唱各占一项。未知歌名也保留 name:null。BGM、影片歌声、只点歌未唱、随口音效和只聊影片不算实际活动。
先区分实际播放、只讨论/推荐、未来计划和拒绝/取消。查资源、认角色、试画质、预告和拉片解说不能当作对应正片的观看会话；若确实观看了视频/解说，使用 mediaKind:video 并描述实际播放的内容。结合主播后续决定，“下次看”“不看”“困了不看”不能生成该影片的 watch 事件；孤立的“看一眼”也不能证明持续观影。
为以后观影试播开头或拖进度条检查资源/清晰度，即使顺便讨论剧情也属于准备，不能新增 movie 或 video 观看会话。核对后文“到时候看这个”“还没决定什么时候看”等安排，只保留本场已经选定并持续同步观看的活动。
观看会话包含暂停、反应和讨论，不能只列高光或把跨段的同一部电影拆成几个片段。歌曲的主歌、副歌、间奏属于同一次演唱。
每个事件的 evidenceIds 和 titleEvidenceIds 只引用该事件 start 前 180 秒至 end 后 180 秒内的行；逐项核对引用行自己的时间，不要把同名歌曲或影片在其他时段的提及混入本次活动。titleEvidenceIds 必须同时包含在 evidenceIds 中。
start/end 是录播起点起算的数字秒数，给出大致完整起止，稍后只校准附近短音频；不猜超出输入的边界。歌名/片名必须有原文依据，不能从歌词猜名。evidenceIds 使用证明实际活动的 T/D 行，并核对相邻上下文，不能仅引用片名提及、计划或观众推荐；titleEvidenceIds 是包含该标题的引用，标题依据不等于播放依据。没有标题依据就 name:null。
watch 的 name 是实际播放的影片/剧集/视频名称，不能用“电影同看”“同步视听”替代。若 overview 已明确《片名》，同时回查实际会话的标题引文并填写 name 和 titleEvidenceIds；“雷神三”和“雷神3”等序号写法可以对应，不必因此漏掉片名。仅提到另一部电影仍不能当作当前观看作品。
watch 另附 publicName：可一眼联想到作品的搞笑剧情/人物特征化名，禁用原片名、系列名及其缩写，不是简单谐音或换字。name 仍保留有证据的真实作品身份，publicName 只用于公开包装。例如卷毛医生在线画圈、宇宙蹦迪天团。未知真实片名时 publicName:null；不要为了化名补造观看内容。不要另加一次命名请求。
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
