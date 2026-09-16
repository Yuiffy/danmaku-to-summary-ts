'use strict';

const { resolveStreamerRegistry, findHostStreamerId, buildParticipantSnapshot } = require('./speaker_roster_resolver');

const SOURCES = new Set(['room_title', 'dynamic', 'cover', 'frame', 'operator']);
const NON_PRESENCE = new Set(['mentioned', 'watching', 'character', 'poster', 'replay', 'absent']);
const HOUR = 3600000;

function timestamp(value) {
    if (value == null || value === '') return null;
    const result = typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(value);
    return Number.isFinite(result) ? result : null;
}

function normalized(value) {
    return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function localDay(value, offsetMinutes) {
    return new Date(value + offsetMinutes * 60000).toISOString().slice(0, 10);
}

function namesFor(entry) {
    // resolveStreamerRegistry folds ASR phonetic corrections into speakerLabels. Prefer
    // dedicated mention labels where available (e.g. 浅浅 is an ASR alias, not a guest).
    return Array.from(new Set([entry.id, entry.displayName, ...(entry.searchTags || []),
        ...(entry.mentionLabels || [...(entry.speakerLabels || []), ...(entry.aliases || [])])]
        .map(normalized).filter(Boolean)));
}

function nameIndex(registry) {
    const index = new Map();
    for (const entry of Object.values(registry)) {
        for (const name of namesFor(entry)) index.set(name, [...(index.get(name) || []), entry.id]);
    }
    return index;
}

function namePattern(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp((/^[a-z0-9_]/u.test(name) ? '(?<![a-z0-9_])' : '') + escaped
        + (/[a-z0-9_]$/u.test(name) ? '(?![a-z0-9_])' : ''), 'gu');
}

function inferTextRelation(clause, name) {
    const at = clause.indexOf(name);
    const before = clause.slice(Math.max(0, at - 25), at);
    const after = clause.slice(at + name.length, at + name.length + 25);
    if (/取消|不来|不在|缺席|没有参加|没参加|不参加|并非联动|不是联动/u.test(clause)) return 'absent';
    if (/(?:看|观看|回顾|重温|转播|回放|切片|录播)[^，。！？；\n]{0,12}$/u.test(before)
        || /^(?:的)?(?:直播|录播|切片|视频|回放)(?:回顾|鉴赏|观看)?/u.test(after)) return 'watching';
    if (/(?:角色|npc|游戏人物)[^，。！？；\n]{0,8}$/iu.test(before)
        || /^(?:这个|是个|是)?(?:游戏角色|npc|游戏人物)/iu.test(after)) return 'character';
    if (/联动|连麦|做客|嘉宾|串门|双人|多人|一起玩|一起打|一起聊|一起唱|合作直播/u.test(clause)) return 'planned';
    return 'mentioned';
}

function textObservations(text, index) {
    const body = normalized(text);
    const observations = [];
    for (const clause of body.split(/[,，。!！？?;；\n]/u)) {
        for (const [name, ids] of index) {
            // Single-character aliases and substrings in English words are unsafe discovery keys.
            if (name.length < 2 || !namePattern(name).test(clause)) continue;
            observations.push({ name, matchedStreamerIds: ids, relation: inferTextRelation(clause, name), quote: clause });
        }
        for (const match of clause.matchAll(/@([^\s,，。！？；:@]{2,40})/gu)) {
            if (!index.has(normalized(match[1]))) observations.push({ name: match[1], matchedStreamerIds: [],
                relation: inferTextRelation(clause, match[1]), quote: clause });
        }
    }
    return observations;
}

function eventDayFromText(text, anchor, offsetMinutes) {
    const value = String(text || '');
    const date = value.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/u);
    const shortDate = value.match(/(?<!\d)(\d{1,2})月(\d{1,2})日?/u);
    if (date) return `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}`;
    if (shortDate) return `${localDay(anchor, offsetMinutes).slice(0, 4)}-${shortDate[1].padStart(2, '0')}-${shortDate[2].padStart(2, '0')}`;
    if (/后天/u.test(value)) return localDay(anchor + 48 * HOUR, offsetMinutes);
    if (/明天|明晚|明早/u.test(value)) return localDay(anchor + 24 * HOUR, offsetMinutes);
    if (/昨天|昨晚|昨日/u.test(value)) return localDay(anchor - 24 * HOUR, offsetMinutes);
    if (/今天|今晚|今日|今夜/u.test(value)) return localDay(anchor, offsetMinutes);
    return null;
}

function bindEvidence(raw, session, settings) {
    if (!session.roomId) return 'room_missing';
    if (!SOURCES.has(raw.source)) return 'unknown_source';
    if (String(raw.roomId || '') !== session.roomId) return 'room_mismatch';
    if (raw.sessionId && session.sessionId && String(raw.sessionId) !== session.sessionId) return 'session_mismatch';
    if (session.startedAtMs == null) return 'session_time_missing';
    const observed = timestamp(raw.observedAt) ?? (raw.source === 'frame' && Number.isFinite(raw.offsetSeconds)
        ? session.startedAtMs + raw.offsetSeconds * 1000 : null);
    if (observed == null) return 'observation_time_missing';
    const lower = session.startedAtMs - settings.observationToleranceMinutes * 60000;
    const upper = session.endedAtMs + settings.observationToleranceMinutes * 60000;
    // Dynamics may be fetched later, but their original publication/event times must match.
    if (raw.source !== 'dynamic' && (observed < lower || observed > upper)) return 'observation_outside_session';
    const published = timestamp(raw.publishedAt);
    if (raw.source === 'dynamic' && published == null) return 'publication_time_missing';
    if (raw.source === 'dynamic' && (published < session.startedAtMs - settings.dynamicLookbackHours * HOUR || published > upper)) {
        return 'publication_outside_session';
    }
    const scheduled = timestamp(raw.scheduledAt);
    if (raw.scheduledAt != null && scheduled == null) return 'event_time_invalid';
    if (scheduled != null && (scheduled < session.startedAtMs - 6 * HOUR || scheduled > session.endedAtMs)) {
        return 'event_outside_session';
    }
    const anchor = published ?? observed;
    const inferredDay = eventDayFromText(raw.text, anchor, settings.utcOffsetMinutes);
    const sessionDay = localDay(session.startedAtMs, settings.utcOffsetMinutes);
    // An unknown end time (or a stream crossing midnight) cannot bind tomorrow's
    // announcement to tonight. Explicit scheduledAt can identify a midnight event.
    if (inferredDay && inferredDay !== sessionDay && scheduled == null) return 'event_day_mismatch';
    if (inferredDay && scheduled != null && inferredDay !== localDay(scheduled, settings.utcOffsetMinutes)) return 'conflicting_event_time';
    if (scheduled == null && /下周|下个月|下月|下次|改天|过几天|上周|上个月|上月|上次|之前的联动|上回/u.test(String(raw.text || ''))) {
        return 'event_time_unbound';
    }
    if (raw.source === 'dynamic' && !inferredDay && scheduled == null
        && localDay(published, settings.utcOffsetMinutes) !== sessionDay) return 'dynamic_event_time_unbound';
    if (raw.targetRoomId != null && String(raw.targetRoomId) !== session.roomId) return 'target_room_mismatch';
    const linkedRooms = Array.from(String(raw.text || '').matchAll(/live\.bilibili\.com\/(\d+)/gu), match => match[1]);
    if (linkedRooms.length && !linkedRooms.includes(session.roomId)) return 'linked_room_mismatch';
    return null;
}

function provenance(raw, index) {
    return { id: String(raw.id || `${raw.source || 'unknown'}:${index}`), source: raw.source,
        roomId: String(raw.roomId || ''), ...(raw.sessionId ? { sessionId: String(raw.sessionId) } : {}),
        observedAt: raw.observedAt || null, ...(raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
        ...(raw.scheduledAt ? { scheduledAt: raw.scheduledAt } : {}),
        ...(Number.isFinite(raw.offsetSeconds) ? { offsetSeconds: raw.offsetSeconds } : {}),
        ...(raw.url || raw.sourceUrl ? { url: raw.url || raw.sourceUrl } : {}),
        ...(raw.path || raw.sourcePath ? { path: raw.path || raw.sourcePath } : {}),
        ...(raw.sha256 ? { sha256: raw.sha256 } : {}), ...(raw.authorId ? { authorId: String(raw.authorId) } : {}),
        ...(raw.text ? { text: String(raw.text) } : {}),
        ...(raw.parentText ? { parentText: raw.parentText, clauseIndex: raw.clauseIndex } : {}) };
}

function splitScheduledEvidence(raw) {
    if (!raw || !['dynamic', 'room_title'].includes(raw.source) || !raw.text || raw.observations?.length) return [raw];
    const clauses = String(raw.text).split(/[,，;；。\n]/u).map(text => text.trim()).filter(Boolean);
    const timeMarker = /今天|今晚|今日|今夜|明天|明晚|后天|昨天|昨晚|昨日|下周|上周|下次|上次|下个月|上个月|\d{1,2}月\d{1,2}|20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}/u;
    if (clauses.filter(text => timeMarker.test(text)).length < 2) return [raw];
    const groups = [];
    let group = '';
    for (const clause of clauses) {
        if (group && timeMarker.test(clause)) { groups.push(group); group = ''; }
        group += (group ? '，' : '') + clause;
    }
    if (group) groups.push(group);
    return groups.map((text, clauseIndex) => ({ ...raw, text, parentText: String(raw.text), clauseIndex }));
}

function observationStatus(raw, observation) {
    if (raw.source === 'cover' && observation.relation === 'poster') return 'candidate';
    if (NON_PRESENCE.has(observation.relation)) return null;
    if (observation.relation === 'planned') return 'planned';
    if (observation.relation !== 'present' && observation.relation !== 'candidate') return 'candidate';
    if (observation.relation === 'present' && raw.source === 'operator') return 'confirmed';
    // A poster, avatar resemblance, caption or model suggestion never verifies live presence.
    return 'candidate';
}

function eligibleVisualPresence(raw, observation) {
    return raw.source === 'frame' && observation.relation === 'present'
        && observation.kind === 'live_participant' && Number.isFinite(observation.confidence)
        && observation.confidence >= 0.9 && observation.confidence <= 1
        && observation.identityBasis === 'visible_name_label'
        && raw.sceneContext === 'live' && raw.replay !== true;
}

/**
 * Discover session participants without converting metadata into speaker identity.
 *
 * Input: {roomId, sessionId?, startedAt, endedAt?, hostStreamerId?, evidence: [
 *   {id?, source: room_title|dynamic|cover|frame|operator, roomId, observedAt,
 *    publishedAt?, scheduledAt?, text?, url?, path?, sha256?, sceneContext?: 'live',
 *    observations?: [{name?, streamerId?, relation: planned|present|candidate|mentioned|
 *      watching|character|poster|replay|absent, kind?, identityBasis?, confidence?, quote?}],
 *    mode?: solo|multi, modeBasis?: explicit_statement|operator_confirmation}
 * ]}. All times use ISO with a timezone or epoch seconds/milliseconds. Frame observations
 * may substitute offsetSeconds for observedAt. Dynamic publication time is mandatory.
 *
 * Output modeStatus preserves the distinction between a plan and observed participation.
 * Only confirmedParticipantIds are presence evidence. They still do not label any speech.
 * rosterStreamerIds are candidates for voice comparison, never an exhaustive roster.
 */
function discoverParticipants(options = {}, config = {}) {
    const registry = resolveStreamerRegistry(config);
    const index = nameIndex(registry);
    const startedAtMs = timestamp(options.startedAt);
    const endedAtMs = timestamp(options.endedAt) ?? (startedAtMs == null ? null : startedAtMs + 16 * HOUR);
    const session = { roomId: String(options.roomId || ''), sessionId: options.sessionId ? String(options.sessionId) : null,
        startedAtMs, endedAtMs };
    const settings = { utcOffsetMinutes: 480, observationToleranceMinutes: 10, dynamicLookbackHours: 36,
        ...(options.settings || {}) };
    const hostStreamerId = options.hostStreamerId || findHostStreamerId(session.roomId, registry);
    const participants = new Map();
    const mentions = [];
    const unresolved = [];
    const rejectedEvidence = [];
    const acceptedEvidence = [];
    const modeEvidence = [];
    const issues = [];
    const statusRank = { candidate: 1, planned: 2, confirmed: 3 };
    if (!session.roomId) issues.push('room_missing');
    if (startedAtMs == null) issues.push('session_time_missing');
    if (endedAtMs < startedAtMs) issues.push('session_time_invalid');
    if (hostStreamerId && registry[hostStreamerId]) participants.set(hostStreamerId, {
        ...buildParticipantSnapshot(registry[hostStreamerId], 'host', false), status: 'candidate',
        presence: 'source_host', evidence: []
    });
    else issues.push('host_unknown');
    const evidence = (Array.isArray(options.evidence) ? options.evidence : []).flatMap(splitScheduledEvidence);
    evidence.forEach((raw, evidenceIndex) => {
        if (!raw || typeof raw !== 'object') return;
        const source = provenance(raw, evidenceIndex);
        const rejection = endedAtMs < startedAtMs ? 'session_time_invalid' : bindEvidence(raw, session, settings);
        if (rejection) {
            rejectedEvidence.push({ ...source, reason: rejection });
            return;
        }
        acceptedEvidence.push(source);
        const body = normalized(raw.text);
        const nonPresenceScene = NON_PRESENCE.has(raw.sceneContext) || raw.replay === true;
        const explicitSolo = !/不是单播|非单播|不单播/u.test(body)
            && /(?:今天|今晚|本场|本次)?(?:单播|单人直播|自己播|一个人播|无联动|不联动|没有联动|不是联动)/u.test(body);
        if (!nonPresenceScene && (explicitSolo || raw.mode === 'solo' || raw.mode === 'multi')) {
            const mode = explicitSolo ? 'solo' : raw.mode;
            const status = raw.source === 'operator' && raw.modeBasis === 'operator_confirmation' ? 'confirmed'
                : raw.source === 'room_title' || raw.source === 'dynamic' || raw.modeBasis === 'explicit_statement' ? 'planned' : 'candidate';
            modeEvidence.push({ mode, status, evidence: source });
        }
        const viewingCollab = /(?:看|观看|回顾|重温|转播|回放|切片|录播).{0,30}(?:联动|连麦)|(?:联动|连麦).{0,8}(?:回顾|回放|切片|录播)/u.test(body);
        if (!nonPresenceScene && !explicitSolo && !viewingCollab && /联动|连麦|双人|多人/u.test(body)) {
            modeEvidence.push({ mode: 'multi', status: 'planned', evidence: source });
        }
        const observations = [...textObservations(raw.text, index), ...(Array.isArray(raw.observations) ? raw.observations : [])];
        const visiblePeople = (raw.observations || []).filter(item => item && ['avatar', 'live_participant'].includes(item.kind)
            && ['present', 'candidate'].includes(item.relation) && Number.isFinite(item.confidence) && item.confidence >= 0.5 && item.confidence <= 1);
        if (raw.source === 'frame' && raw.sceneContext === 'live' && raw.replay !== true
            && new Set(visiblePeople.map(item => String(item.quote || '').trim()).filter(Boolean)).size >= 2) {
            modeEvidence.push({ mode: 'multi', status: 'candidate', basis: 'multiple_visible_live_avatars', evidence: source });
        }
        const seen = new Set();
        for (const observation of observations) {
            if (!observation || typeof observation !== 'object') continue;
            const matchName = String(observation.streamerId || observation.name || '').trim();
            const ids = observation.matchedStreamerIds || (Object.hasOwn(registry, observation.streamerId) ? [observation.streamerId]
                : index.get(normalized(matchName)) || []);
            const relation = NON_PRESENCE.has(observation.relation) ? observation.relation
                : NON_PRESENCE.has(raw.sceneContext) ? raw.sceneContext
                : raw.replay === true ? 'replay' : observation.relation || 'candidate';
            const boundObservation = { ...observation, relation };
            const key = `${ids.join(',')}:${normalized(matchName)}:${relation}:${observation.kind || ''}:${observation.quote || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const item = { ...source, relation, name: matchName,
                ...(observation.quote ? { quote: observation.quote } : {}),
                ...(observation.kind ? { kind: observation.kind } : {}),
                ...(observation.identityBasis ? { identityBasis: observation.identityBasis } : {}),
                ...(Number.isFinite(observation.confidence) ? { confidence: observation.confidence } : {}) };
            if (observation.confidence != null && (!Number.isFinite(observation.confidence)
                || observation.confidence < 0 || observation.confidence > 1)) {
                issues.push(`invalid_observation_confidence:${source.id}`);
                continue;
            }
            if (ids.length !== 1) {
                if (matchName || observation.kind) unresolved.push({ ...item, reason: ids.length ? 'ambiguous_name'
                    : matchName ? 'unknown_name' : 'unknown_identity', matchedStreamerIds: ids });
                continue;
            }
            const streamerId = ids[0];
            const status = observationStatus(raw, boundObservation);
            if (!status) {
                mentions.push({ ...item, streamerId });
                continue;
            }
            if (!participants.has(streamerId)) participants.set(streamerId, {
                ...buildParticipantSnapshot(registry[streamerId], streamerId === hostStreamerId ? 'host' : 'participant', false),
                status, presence: 'discovered', evidence: []
            });
            const participant = participants.get(streamerId);
            const visualTime = timestamp(raw.observedAt) ?? (Number.isFinite(raw.offsetSeconds)
                ? session.startedAtMs + raw.offsetSeconds * 1000 : null);
            participant.evidence.push({ ...item, status,
                ...(eligibleVisualPresence(raw, boundObservation) ? { visualPresenceSupported: true, observedAtMs: visualTime } : {}) });
            if (statusRank[status] > statusRank[participant.status]) participant.status = status;
            participant.planned = participant.status === 'planned';
        }
    });
    const people = Array.from(participants.values());
    for (const person of people) {
        const frames = person.evidence.filter(item => item.visualPresenceSupported);
        // Repeating one frame or one source ID cannot corroborate a visual guess.
        const repeated = frames.some((first, i) => frames.slice(i + 1).some(second => first.id !== second.id
            && Math.abs(first.observedAtMs - second.observedAtMs) >= 5000
            && (!first.sha256 || !second.sha256 || first.sha256 !== second.sha256)));
        if (repeated) {
            person.status = 'confirmed';
            person.presence = 'repeated_visual_presence';
            person.planned = false;
        }
    }
    const confirmed = people.filter(person => person.status === 'confirmed').map(person => person.streamerId);
    const confirmedGuests = confirmed.filter(id => id !== hostStreamerId);
    const planned = people.filter(person => person.status === 'planned' && person.streamerId !== hostStreamerId).map(person => person.streamerId);
    if (confirmed.length >= 2 || confirmedGuests.length && hostStreamerId) modeEvidence.push({ mode: 'multi', status: 'confirmed',
        basis: 'confirmed_guest_in_host_session', streamerIds: confirmed });
    if (planned.length) modeEvidence.push({ mode: 'multi', status: 'planned', basis: 'planned_guest', streamerIds: planned });
    const strongest = modeEvidence.reduce((rank, item) => Math.max(rank, statusRank[item.status]), 0);
    const strongestModes = new Set(modeEvidence.filter(item => statusRank[item.status] === strongest).map(item => item.mode));
    const mode = strongestModes.size === 1 ? [...strongestModes][0] : 'unknown';
    if (strongestModes.size > 1) issues.push('conflicting_mode_evidence');
    if (mode === 'multi' && modeEvidence.some(item => item.mode === 'solo')) issues.push('solo_claim_with_guest_evidence');
    const outputSession = { roomId: session.roomId, sessionId: session.sessionId,
        startedAt: startedAtMs == null ? null : new Date(startedAtMs).toISOString(),
        endedAt: endedAtMs == null ? null : new Date(endedAtMs).toISOString() };
    return { version: 1, source: 'session_participant_discovery', session: outputSession, roomId: session.roomId,
        hostStreamerId: hostStreamerId || null, mode, modeStatus: mode === 'unknown' ? 'unknown'
            : Object.keys(statusRank).find(status => statusRank[status] === strongest),
        participants: people, candidateStreamerIds: people.filter(person => person.status === 'candidate').map(person => person.streamerId),
        plannedParticipantIds: planned, confirmedParticipantIds: confirmed,
        rosterStreamerIds: people.map(person => person.streamerId), constrainToRoster: false,
        speakerIdentityVerified: false, modeEvidence, evidence: acceptedEvidence,
        mentions, unresolved, rejectedEvidence, issues };
}

module.exports = { discoverParticipants, textObservations, eventDayFromText };
