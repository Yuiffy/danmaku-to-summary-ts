'use strict';
const { loadRecordingParticipants } = require('../asr/recording_roster');
const { buildPersonEvidenceContext, nameMatcher } = require('./person_evidence');
const { preferredName } = require('../ai_clip_metadata');
const { referenceHintsFor, referenceNames } = require('./entity_context');

function attributionEnabled(config = {}, roomId) {
    const settings = config.attribution || {};
    return settings.enabled === true && Array.isArray(settings.roomIds)
        && settings.roomIds.map(String).includes(String(roomId));
}

function buildParticipantContext(rootConfig, info, parsed, danmaku, metadata = {}, settings = rootConfig.ownStreamClips?.attribution) {
    const planned = new Set(metadata.plannedParticipantIds || []);
    const discovery = metadata.participantDiscovery;
    const discovered = new Set(discovery?.rosterStreamerIds || []);
    const registry = rootConfig.ai?.streamerRegistry || {};
    const people = buildPersonEvidenceContext(rootConfig, info?.roomId).map(person => {
        const entry = registry[person.id] || {};
        const referenceHints = settings?.entityReferences?.enabled === true ? referenceHintsFor(entry, rootConfig, person.names) : [];
        const matches = nameMatcher(referenceNames({ ...person, referenceHints }));
        const speakerLabels = new Set([person.label, ...(entry.speakerLabels || [])].map(String));
        const voiceRows = (parsed.segments || []).filter(row => require('../workflow-runtime').loadWorkflow('clipping/speakerIdentity').publicSpeakerIdentity(row.speakerEvidence)
            && speakerLabels.has(row.speakerEvidence.label));
        const voiceObservations = Array.from(new Map(voiceRows.flatMap(row => row.speakerEvidence.observations || [])
            .filter(row => row.scope === 'row' && speakerLabels.has(row.label))
            .map(row => [`${row.start}:${row.end}:${row.label}`, row])).values());
        const voiceSeconds = voiceObservations.reduce((sum, row) => sum + Math.max(0, row.end - row.start), 0);
        const qualifiedVoice = voiceObservations.length >= 2 && voiceSeconds >= 8;
        const speechMentions = (parsed.segments || []).filter(row => matches(row.text));
        const audienceMentions = danmaku.filter(row => matches(row.text));
        return { ...person, ...(referenceHints.length ? { referenceHints } : {}), preferredName: preferredName(entry) || person.label,
            presence: person.sourceHost ? 'source_host' : qualifiedVoice ? 'voice_matched'
                : planned.has(person.id) ? 'planned' : discovered.has(person.id) ? 'candidate' : 'mentioned_only',
            voiceRows: voiceObservations.length, voiceSeconds, speechMentions: speechMentions.length, audienceMentions: audienceMentions.length };
    }).filter(person => person.sourceHost || planned.has(person.id) || discovered.has(person.id) || person.presence === 'voice_matched' || person.speechMentions || person.audienceMentions);
    return { version: 1, people, rosterSource: metadata.source || 'none',
        ...(discovery ? { participantDiscovery: discovery } : {}),
        ...(settings?.entityReferences?.enabled === true ? { entityReferencesEnabled: true } : {}),
        issues: [...(metadata.issues || []), ...[...planned].filter(id => !registry[id]).map(id => `unknown_participant:${id}`)] };
}

function participantPromptLines(context) {
    if (!context?.people?.length) return [];
    return [
        require('../workflow-runtime').loadWorkflow('clipping/speakerIdentity').SPEAKER_IDENTITY_RULE,
        '本场人物背景：名单或房主身份不是逐句说话人证据；mentioned_only只表示被提到，不证明在场。',
        ...context.people.map(person => JSON.stringify({ id: person.id, name: person.label, copyName: person.preferredName,
            names: person.names, sourceHost: Boolean(person.sourceHost), presence: person.presence,
            ...(person.referenceHints?.length ? { referenceHints: person.referenceHints, hintsAreCandidatesOnly: true } : {}) })),
        '声纹V标记是局部音频窗口匹配，分数/间隔不是概率，不是逐词标注；?或mixed保留未知，不能用房主身份补全。',
        'candidate只表示标题、动态、封面或画面发现的候选；名单/画面不能给某句语音署名。voice_matched只证明音轨里匹配到声音，被观看视频也可能有该声音；实际互动仍须同时间的对话/画面支持。',
        '逐项区分当前讲述者、转述内的说话人、动作执行者和对象；联动、连麦、播放或音源不明时，第一人称我不能默认归给房主，提到谁不代表谁执行动作。普通单人自述没有其他说话音源时，以sourceHost为叙事主体；标题已有统一发布前缀或语境清楚时默认省略主播主语，直接写事情，不固定以copyName或“主播”开头。简介或消歧确需主语时才用copyName或“主播”，不因没有逐句报姓名而写成“讲述者”。人物名单本身仍不构成逐句声纹或动作证据。',
        '不同人说的提问、回应和反问不得合并成同一个人的连续动作。身份不确定就写中性事件并注明待核。',
        '事件中已确认的执行者或对象，无论现场嘉宾、仅被提及的人还是转述对象，公开文案优先使用其copyName，不因缺少现场声纹把已确认人名改成对方、有人或朋友。主体已清楚的主播本人可省略主语，不因内部已实名而补进标题。',
        '称呼对应与动作归属分开核验：片内姓名及连续指代已成立才写名字；同字段已交代姓名后可自然用代词，真正泛指或身份不确定时不得硬套人名。'
    ];
}

function identityDanmaku(danmaku, window, context, limit = 4) {
    if (!context?.people?.length || limit <= 0) return [];
    const people = context.people.map(person => ({ person, matches: nameMatcher(referenceNames(person)) }));
    const selected = [];
    const rows = danmaku.filter(row => row.time >= window.start && row.time < window.end);
    for (const { person, matches } of people.sort((a, b) => Number(a.person.sourceHost) - Number(b.person.sourceHost))) {
        const hits = rows.filter(row => matches(row.text));
        for (const row of [hits[0], hits.at(-1)]) {
            if (row && !selected.includes(row) && selected.length < limit) selected.push(row);
        }
        if (selected.length >= limit) break;
    }
    return selected.sort((a, b) => a.time - b.time);
}

module.exports = { attributionEnabled, loadRecordingParticipants, buildParticipantContext, participantPromptLines, identityDanmaku };
