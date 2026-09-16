const configLoader = require('../config-loader');
const referenceCatalog = require('./speaker_reference_catalog');

function normalizeLabel(value) {
    return String(value || '').trim().toLocaleLowerCase('zh-CN');
}

function dedupeById(participants = []) {
    const result = [];
    const seen = new Set();
    for (const participant of participants) {
        const id = String(participant?.id || '').trim();
        if (!id || seen.has(id)) continue;
        seen.add(id);
        result.push(participant);
    }
    return result;
}

function resolveStreamerRegistry(config = configLoader.getConfig()) {
    const raw = config.ai?.streamerRegistry || {};
    const registry = {};
    Object.entries(raw).forEach(([streamerId, entry]) => {
        if (!entry || typeof entry !== 'object') {
            return;
        }
        const displayName = String(entry.displayName || streamerId).trim();
        const labels = referenceCatalog.collectSpeakerLabels({
            id: streamerId,
            displayName,
            speakerLabels: entry.speakerLabels,
            aliases: entry.aliases
        });
        registry[streamerId] = {
            id: streamerId,
            ...entry,
            displayName,
            speakerLabels: labels
        };
    });
    return registry;
}

function findHostStreamerId(roomId, registry = resolveStreamerRegistry()) {
    const room = String(roomId || '').trim();
    if (!room) return null;
    for (const [streamerId, entry] of Object.entries(registry)) {
        const roomIds = Array.isArray(entry.roomIds) ? entry.roomIds.map((value) => String(value)) : [];
        if (roomIds.includes(room)) {
            return streamerId;
        }
    }
    return null;
}

function findStreamersByLabel(input, registry = resolveStreamerRegistry()) {
    const normalized = normalizeLabel(input);
    if (!normalized) {
        return [];
    }
    return Object.values(registry).filter((entry) => {
        const labels = referenceCatalog.collectSpeakerLabels(entry);
        return labels.some((label) => normalizeLabel(label) === normalized);
    });
}

function resolveStreamer(input, registry = resolveStreamerRegistry()) {
    const raw = String(input || '').trim();
    if (!raw) {
        throw new Error('参与者名称不能为空');
    }
    if (registry[raw]) {
        return registry[raw];
    }
    const matches = findStreamersByLabel(raw, registry);
    if (matches.length === 0) {
        throw new Error(`未在 streamerRegistry 中找到参与者: ${raw}`);
    }
    if (matches.length > 1) {
        throw new Error(`参与者名称不唯一: ${raw} -> ${matches.map((item) => `${item.displayName}(${item.id})`).join(', ')}`);
    }
    return matches[0];
}

function parseParticipantList(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    return String(value || '')
        .split(/[，,\n]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function buildParticipantSnapshot(streamer, role = 'participant', planned = true) {
    return {
        streamerId: streamer.id,
        displayName: streamer.displayName || streamer.id,
        role,
        planned,
        roomIds: Array.isArray(streamer.roomIds) ? streamer.roomIds.map((value) => String(value)) : [],
        speakerLabels: referenceCatalog.collectSpeakerLabels(streamer),
        aliases: Array.isArray(streamer.aliases) ? streamer.aliases.map((value) => String(value)).filter(Boolean) : [],
        mentionLabels: Array.isArray(streamer.mentionLabels) ? streamer.mentionLabels.map((value) => String(value)).filter(Boolean) : []
    };
}

function resolvePlannedRoster(options = {}, config = configLoader.getConfig()) {
    const roomId = String(options.roomId || '').trim();
    if (!roomId) {
        throw new Error('缺少 roomId，无法解析本场固定参与者');
    }
    const registry = resolveStreamerRegistry(config);
    const hostStreamerId = options.hostStreamerId || findHostStreamerId(roomId, registry);
    const host = hostStreamerId ? registry[hostStreamerId] : null;
    if (!host) {
        throw new Error(`未能从 streamerRegistry 为房间 ${roomId} 解析房主`);
    }

    const requestedParticipants = parseParticipantList(options.participants || options.plannedParticipantIds || []);
    const guests = requestedParticipants.map((input) => resolveStreamer(input, registry));
    const dedupedGuests = dedupeById(guests).filter((item) => item.id !== host.id);
    const roster = dedupeById([host, ...dedupedGuests]);
    const participantSnapshots = [
        buildParticipantSnapshot(host, 'host', true),
        ...dedupedGuests.map((guest) => buildParticipantSnapshot(guest, 'participant', true))
    ];
    const referencePreparation = referenceCatalog.getRosterReferenceStatus(roster, config);

    return {
        roomId,
        hostStreamerId: host.id,
        plannedParticipantIds: dedupedGuests.map((item) => item.id),
        rosterStreamerIds: roster.map((item) => item.id),
        participants: participantSnapshots,
        constrainToRoster: options.constrainToRoster !== false,
        referencePreparation
    };
}

module.exports = {
    normalizeLabel,
    resolveStreamerRegistry,
    findHostStreamerId,
    findStreamersByLabel,
    resolveStreamer,
    parseParticipantList,
    buildParticipantSnapshot,
    resolvePlannedRoster
};
