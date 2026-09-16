"""Keep acoustic identity separate from participation and visual presence."""
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional


def validated_recording_discovery(discovery, highlight_path, room_id, context=None):
    """Accept metadata only for the adjacent recording and a known session time.

    Never read a path supplied by the sidecar until its directory and recording
    stem match the source the caller is already processing.
    """
    if not isinstance(discovery, dict) or discovery.get('version') != 1 or discovery.get('source') != 'session_participant_discovery':
        return None
    session = discovery.get('session') or {}
    if not isinstance(session, dict) or str(discovery.get('roomId')) != str(room_id) or str(session.get('roomId')) != str(room_id):
        return None
    highlight = Path(highlight_path).resolve()
    stem = highlight.stem.removesuffix('_AI_HIGHLIGHT').removesuffix('.speaker')
    session_id = session.get('sessionId')
    if not isinstance(session_id, str) or not Path(session_id).is_absolute():
        return None
    session_path = Path(session_id).resolve()
    if session_path.parent != highlight.parent or session_path.stem.removesuffix('.speaker') != stem:
        return None
    try:
        start = datetime.fromisoformat(str(session.get('startedAt') or '').replace('Z', '+00:00'))
        if start.tzinfo is None:
            return None
        expected_start = (context or {}).get('recordingStartTime')
        if expected_start and start != datetime.fromisoformat(str(expected_start).replace('Z', '+00:00')):
            return None
        binding = discovery.get('binding')
        if binding is None and not expected_start:
            return None
        if binding is not None:
            source = Path(binding['sourceMediaPath']).resolve()
            if source != session_path or source.parent != highlight.parent or source.stem != stem:
                return None
            stat = source.stat()
            if stat.st_size != binding.get('size') or abs(stat.st_mtime * 1000 - float(binding['mtimeMs'])) > 1:
                return None
    except (KeyError, OSError, TypeError, ValueError, OverflowError):
        return None
    return discovery


NON_LIVE_STATUSES = frozenset({
    'absent', 'excluded', 'not_present', 'watching', 'watched', 'watched_content',
    'playback', 'replay', 'recording', 'external_audio', 'character', 'fictional_character',
    'preview_only', 'mention_only',
})


def participant_presence(sidecar, streamer_id, participant=None, speaker=None):
    """Candidates never establish attendance; explicit non-live evidence vetoes it.

    Legacy acoustic summaries remain usable as audio evidence. A positive live
    confirmation is only taken from the recording-scoped discovery contract or
    an explicit liveInteractionConfirmed flag, never from an appeared boolean.
    """
    discovery = sidecar.get('participantDiscovery') or {}
    if not isinstance(discovery, dict):
        discovery = {}
    rows = discovery.get('participants') or []
    matching = [row for row in rows if isinstance(row, dict)
                and str(row.get('streamerId') or row.get('id') or '') == streamer_id]
    evidence_rows = [row for row in [participant, speaker, *matching] if isinstance(row, dict)]
    for row in evidence_rows:
        if row.get('appeared') is False or row.get('liveInteractionConfirmed') is False:
            return 'excluded'
        for field in ('status', 'presenceStatus', 'participationStatus', 'speechContext'):
            if str(row.get(field) or '').lower() in NON_LIVE_STATUSES:
                return 'excluded'
    confirmed = discovery.get('confirmedParticipantIds') or []
    if streamer_id in [str(value) for value in confirmed] or any(
        row.get('liveInteractionConfirmed') is True for row in evidence_rows
    ):
        return 'live_confirmed'
    # One watched frame does not prove whole-session absence: a person may join
    # later. Keep their acoustic identity while withholding a live-role claim.
    for row in discovery.get('mentions') or []:
        if isinstance(row, dict) and str(row.get('streamerId') or '') == streamer_id:
            if str(row.get('relation') or '').lower() in NON_LIVE_STATUSES:
                return 'unresolved_presence'
    if discovery.get('mode') == 'solo' and discovery.get('modeStatus') == 'confirmed':
        return 'excluded'
    return 'audio_confirmed'


def get_multi_reference_config(
    config: Dict[str, Any], room_id: Optional[str], highlight_path: Optional[str] = None,
    *, load_discovery, find_host,
) -> Dict[str, Any]:
    """Return global multi-reference config with room overrides applied."""
    ai_config = config.get("ai", {})
    global_config = ai_config.get("comic", {}).get("multiReferenceImages", {})
    room_config = {}
    if room_id:
        room_config = (config.get("ai", {}).get("roomSettings", {}).get(str(room_id), {}).get("multiReferenceImages", {})
                       or config.get("roomSettings", {}).get(str(room_id), {}).get("multiReferenceImages", {}))
    merged = {
        "enabled": False,
        "discoveryEnabled": False,
        "maxExtraCharacters": 2,
        "maxMentionedContextCharacters": 2,
        "minSpeakerScore": 0.64,
        "minSpeechSeconds": 8,
        "minSpeakerMaxScore": 0.80,
        "minSpeakerSecondsWhenLowScore": 900,
        "speakerThresholdOverrides": {},
        "includeUnknownSpeakers": False,
        "includeMentionedStreamers": True,
        "includeMentionedStreamerImages": True,
        "useMentionedOnlyAsContext": True,
        "filterExtraImagesByComicScript": True,
        "filterMentionedImagesByComicScript": True,
        "appendCharacterDescriptions": True,
        "imageOrder": ["host", "appeared_streamers", "cover", "screenshots", "default"],
        "requirePlannedRosterForAppearedCharacters": False,
        "mentionCharacterMode": "allowed",
    }
    if isinstance(global_config, dict):
        merged.update(global_config)
    if isinstance(room_config, dict):
        merged.update(room_config)
    if highlight_path and merged.get("discoveryEnabled") is True:
        discovery = load_discovery(highlight_path, room_id, config)
        if (discovery and discovery.get("mode") == "multi"
                and discovery.get("modeStatus") in {"candidate", "planned", "confirmed"}):
            host_id = find_host(config, room_id)
            candidate_ids = {
                str(value) for field in ("candidateStreamerIds", "plannedParticipantIds", "confirmedParticipantIds")
                for value in (discovery.get(field) or []) if isinstance(value, str) and value
            }
            candidate_ids.update(
                str(person.get("streamerId")) for person in (discovery.get("participants") or [])
                if isinstance(person, dict) and person.get("streamerId")
                and person.get("status") in {"candidate", "planned", "confirmed"}
            )
            candidate_ids.discard(host_id)
            if candidate_ids:
                merged.update({
                    "_baseEnabled": bool(merged.get("enabled")),
                    "_sessionDiscoveryActive": True,
                    "_discoveryCandidateIds": sorted(candidate_ids),
                    "_participantDiscovery": discovery,
                    "enabled": True,
                    "maxExtraCharacters": 4,
                    "maxTotalImages": max(5, int(merged.get("maxTotalImages") or 4)),
                })
    return merged


def get_speaker_acceptance_thresholds(
    multi_config: Dict[str, Any],
    streamer_id: str,
    *, number,
) -> Dict[str, float]:
    configured_overrides = multi_config.get("speakerThresholdOverrides")
    override = configured_overrides.get(streamer_id, {}) if isinstance(configured_overrides, dict) else {}
    if not isinstance(override, dict):
        override = {}

    thresholds = {}
    for key in (
        "minSpeechSeconds",
        "minSpeakerScore",
        "minSpeakerMaxScore",
        "minSpeakerSecondsWhenLowScore",
    ):
        parsed = number(override.get(key, multi_config.get(key)))
        thresholds[key] = parsed if parsed is not None else 0.0
    return thresholds


def find_sidecar_participant_for_streamer(sidecar: dict, streamer: Dict[str, Any]) -> Optional[dict]:
    participants = sidecar.get("participants", []) if isinstance(sidecar, dict) else []
    streamer_id = str(streamer.get("id") or "")
    for participant in participants:
        if not isinstance(participant, dict):
            continue
        if str(participant.get("streamerId") or "") == streamer_id:
            return participant
    return None


def find_sidecar_speaker_for_streamer(sidecar: dict, streamer: Dict[str, Any], *, normalize) -> Optional[dict]:
    speakers = sidecar.get("speakers", []) if isinstance(sidecar, dict) else []
    labels = []
    for value in [
        streamer.get("displayName"),
        *(streamer.get("speakerLabels", []) or []),
        *(streamer.get("aliases", []) or []),
    ]:
        label = str(value or "").strip()
        if label and label not in labels:
            labels.append(label)
    normalized_labels = {normalize(label) for label in labels}
    for speaker in speakers:
        if not isinstance(speaker, dict):
            continue
        speaker_label = normalize(str(speaker.get("label") or "").strip())
        if speaker_label in normalized_labels:
            return speaker
    return None


def sidecar_speaker_passes_reference_thresholds(
    speaker: Optional[dict],
    streamer: Dict[str, Any],
    multi_config: Dict[str, Any],
    *, number, thresholds_for, log,
) -> bool:
    if not isinstance(speaker, dict) or not speaker:
        return False
    if speaker.get("isUnknown") is True or speaker.get("identityVerified") is False:
        return False

    display_name = streamer.get("displayName") or streamer.get("id") or speaker.get("label") or "unknown"
    total_seconds = number(speaker.get("totalSpeechSeconds")) or 0.0
    avg_score = number(speaker.get("avgScore"))
    max_score = number(speaker.get("maxScore"))
    if avg_score is None or max_score is None or not (0 <= avg_score <= 1 and 0 <= max_score <= 1):
        log(f"[INFO]  过滤缺少有效声纹分数的额外主播参考图: {display_name}")
        return False
    thresholds = thresholds_for(multi_config, str(streamer.get("id") or ""))
    min_seconds = thresholds["minSpeechSeconds"]
    min_avg_score = thresholds["minSpeakerScore"]
    min_max_score = thresholds["minSpeakerMaxScore"]
    low_score_seconds = thresholds["minSpeakerSecondsWhenLowScore"]

    if not (0 < total_seconds < float("inf")) or total_seconds < min_seconds:
        log(f"[INFO]  过滤额外出声主播参考图: {display_name} 出声 {total_seconds:.1f}s < {min_seconds:.1f}s")
        return False
    if avg_score is not None and avg_score < min_avg_score:
        log(f"[INFO]  过滤额外出声主播参考图: {display_name} avgScore {avg_score:.4f} < {min_avg_score:.4f}")
        return False
    if max_score is not None and min_max_score > 0 and max_score < min_max_score and total_seconds < low_score_seconds:
        log(
            f"[INFO]  过滤低置信额外出声主播参考图: {display_name} "
            f"maxScore {max_score:.4f} < {min_max_score:.4f} 且出声 {total_seconds:.1f}s < {low_score_seconds:.1f}s"
        )
        return False
    return True
