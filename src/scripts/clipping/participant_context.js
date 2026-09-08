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
    const registry = rootConfig.ai?.streamerRegistry || {};
    const people = buildPersonEvidenceContext(rootConfig, info?.roomId).map(person => {
        const entry = registry[person.id] || {};
        const referenceHints = settings?.entityReferences?.enabled === true ? referenceHintsFor(entry, rootConfig, person.names) : [];
        const matches = nameMatcher(referenceNames({ ...person, referenceHints }));
        const speakerLabels = new Set([person.label, ...(entry.speakerLabels || [])].map(String));
        const voiceRows = (parsed.segments || []).filter(row => row.speakerEvidence?.status === 'row_supported'
            && speakerLabels.has(row.speakerEvidence.label));
        const voiceObservations = Array.from(new Map(voiceRows.flatMap(row => row.speakerEvidence.observations || [])
            .filter(row => row.scope === 'row' && speakerLabels.has(row.label))
            .map(row => [`${row.start}:${row.end}:${row.label}`, row])).values());
        const voiceSeconds = voiceObservations.reduce((sum, row) => sum + Math.max(0, row.end - row.start), 0);
        const qualifiedVoice = voiceObservations.length >= 2 && voiceSeconds >= 8;
        const speechMentions = (parsed.segments || []).filter(row => matches(row.text));
        const audienceMentions = danmaku.filter(row => matches(row.text));
        return { ...person, ...(referenceHints.length ? { referenceHints } : {}), preferredName: preferredName(entry) || person.label,
            presence: person.sourceHost ? 'source_host' : planned.has(person.id) ? 'planned'
                : qualifiedVoice ? 'voice_matched' : 'mentioned_only',
            voiceRows: voiceObservations.length, voiceSeconds, speechMentions: speechMentions.length, audienceMentions: audienceMentions.length };
    }).filter(person => person.sourceHost || planned.has(person.id) || person.presence === 'voice_matched' || person.speechMentions || person.audienceMentions);
    return { version: 1, people, rosterSource: metadata.source || 'none',
        ...(settings?.entityReferences?.enabled === true ? { entityReferencesEnabled: true } : {}),
        issues: [...(metadata.issues || []), ...[...planned].filter(id => !registry[id]).map(id => `unknown_participant:${id}`)] };
}

function participantPromptLines(context) {
    if (!context?.people?.length) return [];
    return [
        '本场人物背景：名单或房主身份不是逐句说话人证据；mentioned_only只表示被提到，不证明在场。',
        ...context.people.map(person => JSON.stringify({ id: person.id, name: person.label, copyName: person.preferredName,
            names: person.names, presence: person.presence,
            ...(person.referenceHints?.length ? { referenceHints: person.referenceHints, hintsAreCandidatesOnly: true } : {}) })),
        '声纹V标记是局部音频窗口匹配，分数/间隔不是概率，不是逐词标注；?或mixed保留未知，不能用房主身份补全。',
        '逐项区分当前讲述者、转述内的说话人、动作执行者和对象；第一人称我不能默认归给房主，提到谁不代表谁执行动作。',
        '不同人说的提问、回应和反问不得合并成同一个人的连续动作。身份不确定就写中性事件并注明待核。',
        '标题涉及已确认嘉宾的动作时，正文显式用其copyName，不用连麦对象或代词代替；不确定时不得硬套人名。'
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
