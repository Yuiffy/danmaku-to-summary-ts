'use strict';

// Summarize acoustic identities separately from session discovery and roster metadata.
function summarizeAsrSpeakers(result, config = {}, context = {}, helpers) {
    const { resolveStreamerRegistry, getMultiReferenceConfig, getSpeakerRequest, isUnknownSpeakerLabel, mapSpeakerLabelToStreamerId, findHostStreamerId, getSpeakerAcceptanceThresholds, buildParticipantSummary } = helpers;
    const registry = resolveStreamerRegistry(config);
    const roomId = context.room_id || context.roomId || context.hostRoomId || null;
    const multiConfig = getMultiReferenceConfig(config, roomId);
    const speakerRequest = getSpeakerRequest(context);
    const stats = new Map();
    const segments = Array.isArray(result?.segments) ? result.segments : [];

    segments.forEach((segment) => {
        const localEvidence = segment.speakerEvidence || segment.speaker_evidence;
        const label = localEvidence
            ? (localEvidence.status === 'row_supported' && localEvidence.label ? String(localEvidence.label) : 'UNKNOWN')
            : String(segment.speaker || '').trim() || 'UNKNOWN';
        const start = Number(segment.start);
        const end = Number(segment.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            return;
        }
        const duration = end - start;
        const rawScore = segment.speaker_score;
        const score = rawScore === undefined || rawScore === null || rawScore === ''
            ? NaN
            : Number(rawScore);
        if (!stats.has(label)) {
            stats.set(label, {
                label,
                totalSpeechSeconds: 0,
                segmentCount: 0,
                scoreSum: 0,
                scoreCount: 0,
                maxScore: null,
                isUnknown: isUnknownSpeakerLabel(label)
            });
        }
        const item = stats.get(label);
        item.totalSpeechSeconds += duration;
        item.segmentCount += 1;
        if (Number.isFinite(score)) {
            item.scoreSum += score;
            item.scoreCount += 1;
            item.maxScore = item.maxScore === null ? score : Math.max(item.maxScore, score);
        }
    });

    const speakers = Array.from(stats.values())
        .map(item => ({
            label: item.label,
            totalSpeechSeconds: Number(item.totalSpeechSeconds.toFixed(3)),
            segmentCount: item.segmentCount,
            avgScore: item.scoreCount > 0 ? Number((item.scoreSum / item.scoreCount).toFixed(4)) : null,
            maxScore: item.maxScore === null ? null : Number(item.maxScore.toFixed(4)),
            isUnknown: item.isUnknown,
            streamerId: null
        }))
        .sort((a, b) => b.totalSpeechSeconds - a.totalSpeechSeconds);

    const hostStreamerId = speakerRequest?.hostStreamerId || findHostStreamerId(roomId, registry);
    const appearedStreamerIds = [];
    const speakersByStreamerId = new Map();
    speakers.forEach((speaker) => {
        const streamerId = mapSpeakerLabelToStreamerId(speaker.label, registry);
        speaker.streamerId = streamerId;
        if (!streamerId) {
            if (speaker.isUnknown) {
                console.log(`[ASR] speaker summary: 跳过未映射 speaker=${speaker.label}`);
            } else {
                console.log(`[ASR] speaker summary: speaker=${speaker.label} 未命中 streamerRegistry`);
            }
            return;
        }
        const thresholds = getSpeakerAcceptanceThresholds(multiConfig, streamerId);
        const enoughSpeech = speaker.totalSpeechSeconds >= thresholds.minSpeechSeconds;
        const scoreMissing = speaker.avgScore === null;
        const enoughScore = !scoreMissing && speaker.avgScore >= thresholds.minSpeakerScore;
        const minSpeakerMaxScore = thresholds.minSpeakerMaxScore;
        const lowScoreSeconds = thresholds.minSpeakerSecondsWhenLowScore;
        const lowMaxScore = speaker.maxScore !== null && minSpeakerMaxScore > 0 && speaker.maxScore < minSpeakerMaxScore;
        const enoughDurationForLowScore = speaker.totalSpeechSeconds >= lowScoreSeconds;
        if (!enoughSpeech) {
            console.log(`[ASR] speaker summary: 过滤 ${speaker.label} -> ${streamerId}，出声 ${speaker.totalSpeechSeconds.toFixed(1)}s < ${thresholds.minSpeechSeconds}s`);
            return;
        }
        if (!enoughScore) {
            console.log(`[ASR] speaker summary: 过滤 ${speaker.label} -> ${streamerId}，avgScore ${speaker.avgScore} < ${thresholds.minSpeakerScore}`);
            return;
        }
        if (lowMaxScore && !enoughDurationForLowScore) {
            console.log(`[ASR] speaker summary: 过滤低置信 ${speaker.label} -> ${streamerId}，maxScore ${speaker.maxScore} < ${minSpeakerMaxScore} 且出声 ${speaker.totalSpeechSeconds.toFixed(1)}s < ${lowScoreSeconds}s`);
            return;
        }
        console.log(`[ASR] speaker summary: ${speaker.label} -> ${streamerId} 通过，出声 ${speaker.totalSpeechSeconds.toFixed(1)}s, avgScore=${speaker.avgScore}`);
        if (!appearedStreamerIds.includes(streamerId)) {
            appearedStreamerIds.push(streamerId);
        }
        speakersByStreamerId.set(streamerId, speaker);
    });

    const extraAppearedStreamerIds = appearedStreamerIds
        .filter(streamerId => streamerId !== hostStreamerId)
        .slice(0, Math.max(0, Number(multiConfig.maxExtraCharacters || 0)));

    const participants = new Map((speakerRequest?.participants || []).map(person => [person.streamerId, person]));
    for (const id of [hostStreamerId, ...appearedStreamerIds].filter(Boolean)) {
        if (!participants.has(id)) participants.set(id, { streamerId: id,
            displayName: registry[id]?.displayName || id, role: id === hostStreamerId ? 'host' : 'participant', planned: false });
    }

    return {
        version: 2,
        input: context.input || context.mediaPath || null,
        sourceMediaPath: context.sourceMediaPath || context.input || context.mediaPath || null,
        backend: result?.backend || 'unknown',
        hostRoomId: roomId ? String(roomId) : null,
        hostStreamerId: hostStreamerId || null,
        plannedParticipantIds: Array.isArray(speakerRequest?.plannedParticipantIds)
            ? speakerRequest.plannedParticipantIds.map(value => String(value)).filter(Boolean)
            : [],
        rosterStreamerIds: Array.isArray(speakerRequest?.rosterStreamerIds)
            ? speakerRequest.rosterStreamerIds.map(value => String(value)).filter(Boolean)
            : [],
        constrainedToRoster: false,
        ...(speakerRequest?.participantDiscovery ? { participantDiscovery: speakerRequest.participantDiscovery } : {}),
        speakers,
        appearedStreamerIds,
        extraAppearedStreamerIds,
        participants: buildParticipantSummary([...participants.values()], appearedStreamerIds, speakersByStreamerId)
    };
}

module.exports = { summarizeAsrSpeakers };
