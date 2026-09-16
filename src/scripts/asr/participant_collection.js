'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { discoverParticipants } = require('./participant_discovery');
const { discoveryPath, sourceBinding, hash, loadParticipantDiscovery } = require('./participant_storage');

function recordingContext(mediaPath, roomId, options = {}) {
    const live = require('../live_generation_context');
    const base = path.join(path.dirname(mediaPath), `${path.parse(mediaPath).name}_AI_HIGHLIGHT.txt`);
    const parsed = live.parseRecordingInfo(base);
    const start = options.startedAt || parsed.recordingStartTime;
    const end = options.endedAt || (start && Number.isFinite(options.durationSeconds)
        ? new Date(Date.parse(start) + options.durationSeconds * 1000).toISOString() : null);
    return { roomId: String(roomId || parsed.roomId || ''), startedAt: start, endedAt: end,
        title: options.title || parsed.liveTitle, sessionId: path.resolve(mediaPath) };
}

async function prepareParticipantDiscovery(mediaPath, config = {}, options = {}) {
    const settings = config.asr?.participantDiscovery || {};
    if (settings.enabled === false) return null;
    const session = recordingContext(mediaPath, options.roomId, options);
    if (!session.roomId || !session.startedAt) return null;
    const binding = sourceBinding(mediaPath);
    const evidence = [...(options.evidence || [])];
    const sources = {};
    if (session.title) evidence.push({ id: 'recording-title', source: 'room_title', roomId: session.roomId,
        observedAt: session.startedAt, text: session.title, path: binding.sourceMediaPath });
    let recentDynamics = [];
    try {
        const result = await require('../live_generation_context').fetchRecentDynamics(config, session.roomId,
            session.startedAt, { fetcher: options.fetcher, recordingEndTime: session.endedAt });
        recentDynamics = result.dynamics;
        sources.dynamics = result.status;
        for (const item of recentDynamics) evidence.push({ id: `dynamic:${item.id}`, source: 'dynamic',
            roomId: session.roomId, observedAt: new Date().toISOString(), publishedAt: item.publishTime,
            text: item.content, url: `https://t.bilibili.com/${item.id}`, authorId: result.uid });
    } catch (error) { sources.dynamics = 'unavailable'; sources.dynamicsError = String(error.message); }
    if (settings.visual?.enabled === true) {
        try {
            const visual = options.collectVisual || require('./participant_visual').collectParticipantVisualEvidence;
            const result = await visual(options.visualMediaPath || mediaPath, config, { ...options, ...session });
            evidence.push(...(result.evidence || []));
            sources.visual = result.status;
            if (result.issues?.length) sources.visualIssues = result.issues;
            if (result.directory) sources.visualEvidenceDirectory = result.directory;
        } catch (error) { sources.visual = 'unavailable'; sources.visualError = String(error.message); }
    }
    const discovery = discoverParticipants({ ...session, evidence }, config);
    const payload = { ...discovery, binding, sources, recentDynamics,
        registrySha256: hash(config.ai?.streamerRegistry || {}), generatedAt: new Date().toISOString() };
    const target = discoveryPath(mediaPath);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8'); fs.renameSync(temporary, target); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    return payload;
}

function mergeDiscoveryRequest(request, discovery) {
    if (!discovery) return request;
    const participants = new Map((discovery.participants || []).map(row => [row.streamerId, row]));
    for (const row of request?.participants || []) participants.set(row.streamerId, { ...participants.get(row.streamerId), ...row });
    return { ...request, mode: request?.mode || 'automatic_discovery',
        hostStreamerId: request?.hostStreamerId || discovery.hostStreamerId,
        plannedParticipantIds: [...new Set([...(request?.plannedParticipantIds || []), ...discovery.plannedParticipantIds])],
        rosterStreamerIds: [...participants.keys()], participants: [...participants.values()],
        constrainToRoster: false, participantDiscovery: discovery };
}

async function prepareAsrSpeakerRequest(mediaPath, config, asrContext = {}, durationSeconds, manualRequest = null) {
    let discovery = null;
    try {
        discovery = await prepareParticipantDiscovery(mediaPath, config, {
            roomId: asrContext.room_id || asrContext.roomId,
            durationSeconds: durationSeconds || undefined,
            visualMediaPath: asrContext.sourceMediaPath || mediaPath
        });
    } catch (error) { console.warn(`[ASR] 参与者线索不可用，保留开放集识别: ${error.message}`); }
    return mergeDiscoveryRequest(manualRequest, discovery);
}

module.exports = { discoveryPath, recordingContext, prepareParticipantDiscovery, loadParticipantDiscovery,
    mergeDiscoveryRequest, prepareAsrSpeakerRequest };
