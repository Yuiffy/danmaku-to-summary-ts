"""Speaker identity decisions and acoustic provenance, independent of model IO."""
import math


def timeline_from_chunk_labels(candidates, labels, reference_matches=None,
        row_reference_matches=None, strict_row_reference_labels=None,
        row_reference_cluster_min_support_chunks=2,
        row_reference_cluster_inherit_threshold=0.45,
        identity_policy="legacy", min_identity_seconds=2.0):
    if identity_policy not in {"legacy", "row_verified"}:
        raise ValueError(f"Unknown speaker identity policy: {identity_policy}")
    timeline = []
    matches = reference_matches or {}
    rows = list(row_reference_matches or [])
    strict_labels = {str(label) for label in (strict_row_reference_labels or []) if label}
    minimum_support = max(1, int(row_reference_cluster_min_support_chunks or 1))
    for index, (candidate, raw_label) in enumerate(zip(candidates, labels)):
        cluster_id = f"SPEAKER_{int(raw_label):02d}" if str(raw_label).isdigit() else str(raw_label)
        cluster = matches.get(cluster_id, {})
        row = rows[index] if index < len(rows) else {}
        cluster_label = cluster.get("label", cluster_id)
        known_cluster = bool(cluster.get("accepted") and cluster_label in strict_labels)
        direct = row if row.get("accepted") else {}
        rejected = False
        support = cluster.get("reference_support", {}).get(str(direct.get("label") or ""), {})
        if direct and direct.get("label") in strict_labels and int(support.get("support_count", 0) or 0) < minimum_support:
            direct, rejected = {}, True
        if direct and known_cluster and direct.get("label") != cluster_label and int(support.get("support_count", 0) or 0) < minimum_support:
            direct, rejected = {}, True
        default_cluster = bool(known_cluster and cluster.get("cluster_label_by_default") is True)
        requires_row = cluster_label in strict_labels and not default_cluster
        corroborated = bool(known_cluster and row.get("best_label") == cluster_label
            and float(row.get("score", -1.0) or -1.0) >= float(row_reference_cluster_inherit_threshold))
        label = (direct.get("label") or (cluster_label if default_cluster or corroborated else None)
            or (cluster_id if requires_row else cluster_label))
        score = (direct.get("score") if direct else cluster.get("score") if default_cluster
            else row.get("score") if corroborated or requires_row else cluster.get("score"))
        scope = ("row" if direct else "cluster_high_confidence" if default_cluster
            else "cluster_with_row_corroboration" if corroborated
            else "cluster_rejected_by_row" if requires_row or rejected else "cluster")
        if identity_policy == "row_verified":
            # A cluster's majority cannot override a rejected or conflicting acoustic row.
            usable = (row.get("accepted") is True and row.get("label") in strict_labels
                and candidate["end"] - candidate["start"] >= min_identity_seconds)
            label = row.get("label") if usable else "UNKNOWN"
            score = row.get("score") if usable else None
            scope = "row" if usable else "row_rejected"
        best_from_row = bool(row and (identity_policy == "row_verified" or direct or requires_row or default_cluster))
        timeline.append({
            "start": candidate["start"], "end": candidate["end"],
            "speaker": label, "speaker_score": score, "speaker_cluster": cluster_id,
            "speaker_best_label": row.get("best_label") if best_from_row else cluster.get("best_label"),
            "speaker_best_score": row.get("score") if best_from_row else cluster.get("score"),
            "speaker_match_scope": scope, "speaker_identity_policy": identity_policy,
            "speaker_row": {"label": row.get("label"), "bestLabel": row.get("best_label"),
                "score": row.get("score"), "margin": row.get("margin"), "accepted": row.get("accepted") is True,
                "threshold": row.get("threshold"), "marginThreshold": row.get("margin_threshold"),
                "referenceSamples": row.get("reference_samples"), "scoringStrategy": row.get("scoring_strategy")},
            "speaker_cluster_match": {"id": cluster_id, "label": cluster_label,
                "score": cluster.get("score"), "accepted": cluster.get("accepted") is True,
                "supportRatio": cluster.get("support_ratio")},
        })
    return timeline


def interval_speaker_evidence(start, end, timeline):
    start, end = float(start), float(end)
    observations = []
    for row in timeline or []:
        if min(end, float(row["end"])) <= max(start, float(row["start"])):
            continue
        observations.append({"start": float(row["start"]), "end": float(row["end"]),
            "label": row.get("speaker"), "scope": row.get("speaker_match_scope", "legacy"),
            "row": row.get("speaker_row"), "cluster": row.get("speaker_cluster_match"),
            "policy": row.get("speaker_identity_policy", "legacy"),
            "smoothed": bool(row.get("speaker_smooth_reason"))})
    observations.sort(key=lambda row: (row["start"], row["end"]))
    coverage, cursor = 0.0, start
    for row in observations:
        left, right = max(start, row["start"]), min(end, row["end"])
        coverage += max(0.0, right - max(cursor, left))
        cursor = max(cursor, right)
    ratio = min(1.0, coverage / (end - start)) if end > start else 0.0
    labels = {row["label"] for row in observations}
    row_supported = bool(observations and ratio >= 0.8 and len(labels) == 1 and all(
        row["scope"] == "row" and not row["smoothed"] and (row["row"] or {}).get("accepted") is True
        and row["label"] not in {None, "UNKNOWN"} and not str(row["label"]).startswith("SPEAKER_")
        for row in observations))
    # These are acoustic-window observations, never invented word-level labels.
    return {"version": 1, "status": "row_supported" if row_supported else "mixed" if len(labels) > 1
        else "unknown" if observations else "missing", "label": next(iter(labels)) if row_supported else None,
        "coverage": round(ratio, 4), "timingPrecision": "acoustic_window", "identityVerified": False,
        "observations": observations}


def attach_speaker_evidence(segment, timeline, identity_policy="legacy"):
    evidence = interval_speaker_evidence(segment.get("start", 0), segment.get("end", 0), timeline)
    segment["speaker_evidence"] = evidence
    if identity_policy == "row_verified":
        segment["speaker"] = evidence["label"] or "UNKNOWN"
        scores = [(row.get("row") or {}).get("score") for row in evidence["observations"]]
        segment["speaker_score"] = min(scores) if evidence["label"] and scores and all(
            isinstance(score, (int, float)) and math.isfinite(score) for score in scores) else None
    return segment
