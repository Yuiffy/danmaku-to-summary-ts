'use strict';
const speakerReferenceCatalog = require('./speaker_reference_catalog');
const { currentSpeakerProcessing } = require('./speaker_load_policy.ts');

function buildRuntimeSpeakerOverrides(config = {}, context = {}, helpers) {
    const { getSpeakerRequest, resolveStreamerRegistry, findHostStreamerId } = helpers;
    const policy = currentSpeakerProcessing(config, context);
    console.log(`[ASR] 说话人负载策略: ${policy.mode}, ${policy.enabled ? "保留" : "跳过"}, reason=${policy.reason}, pending=${policy.pendingJobs ?? "unknown"}, oldest_wait_s=${Math.round(policy.oldestWaitSeconds || 0)}`);
    if (!policy.enabled) return { enable_speaker: false, spk_model: null, speaker_references: [], speaker_processing_policy: policy };
    const speakerRequest = getSpeakerRequest(context);
    const registry = resolveStreamerRegistry(config);
    const roomId = context.room_id || context.roomId || context.hostRoomId || null;
    const hostStreamerId = speakerRequest?.hostStreamerId || findHostStreamerId(roomId, registry);
    const requestedParticipants = Array.isArray(speakerRequest?.participants)
        ? speakerRequest.participants
        : [];
    const hostParticipant = requestedParticipants.find(
        participant => String(participant?.streamerId || participant?.id || '') === String(hostStreamerId || '')
    );
    const hostStreamer = hostStreamerId
        ? (registry[hostStreamerId] || hostParticipant || null)
        : null;
    const hostLabels = speakerReferenceCatalog.collectSpeakerLabels(hostStreamer || {});
    const constrainedReferences = Array.isArray(speakerRequest?.constrainedSpeakerReferences)
        ? speakerRequest.constrainedSpeakerReferences
        : [];
    const constrainedHostReference = constrainedReferences.find(
        reference => hostLabels.some(
            label => speakerReferenceCatalog.normalizeLabel(label)
                === speakerReferenceCatalog.normalizeLabel(reference?.speaker)
        )
    );
    const catalogHostReference = hostStreamer
        ? speakerReferenceCatalog.getStreamerReferenceStatus(hostStreamer, config).reference
        : null;
    const hostReference = constrainedHostReference || catalogHostReference;
    const hostOverride = hostReference?.speaker
        ? { speaker_host_label: String(hostReference.speaker) }
        : {};
    hostOverride.speaker_processing_policy = policy;
    const identity = config.asr?.speaker_identity || {};
    if (identity.policy === 'row_verified' && Array.isArray(identity.room_ids) && identity.room_ids.map(String).includes(String(roomId))) {
        hostOverride.speaker_identity_policy = 'row_verified';
        hostOverride.speaker_identity_min_seconds = Number(identity.min_seconds ?? 2);
    }
    const discovery = speakerRequest?.participantDiscovery;
    if (discovery?.mode === 'multi' && ['candidate', 'planned', 'confirmed'].includes(discovery.modeStatus)) {
        // A likely collaboration warrants complete acoustic analysis, never forced names.
        hostOverride.enable_speaker = true;
        hostOverride.speaker_detection_mode = 'always';
        hostOverride.speaker_identity_policy = 'row_verified';
        hostOverride.speaker_identity_min_seconds = Number(identity.min_seconds ?? 2);
    }
    const plannedParticipantIds = Array.isArray(speakerRequest?.plannedParticipantIds)
        ? speakerRequest.plannedParticipantIds.map(value => String(value)).filter(Boolean)
        : [];
    const rosterStreamerIds = Array.isArray(speakerRequest?.rosterStreamerIds)
        ? speakerRequest.rosterStreamerIds.map(value => String(value)).filter(Boolean)
        : [];
    if (!speakerRequest) {
        return hostOverride;
    }

    // Roster data is evaluation context, not a speaker-recognition whitelist.
    // Keep every reference configured on the selected ASR backend in competition.
    return {
        ...hostOverride,
        speaker_constrain_to_references: false,
        speaker_request_mode: speakerRequest.mode || 'planned_roster',
        planned_participant_ids: plannedParticipantIds,
        roster_streamer_ids: rosterStreamerIds
    };
}

module.exports = { buildRuntimeSpeakerOverrides };
