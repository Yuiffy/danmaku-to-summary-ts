import math
import os
import sys
import time

from sensevoice_runtime import log_progress, suppress_model_output


def load_audio_16k_mono(audio_path):
    try:
        import soundfile as sf

        audio, sample_rate = sf.read(audio_path, dtype="float32", always_2d=False)
        if getattr(audio, "ndim", 1) > 1:
            audio = audio.mean(axis=1)
        if int(sample_rate) == 16000:
            return audio, 16000
        import librosa

        return librosa.resample(audio, orig_sr=int(sample_rate), target_sr=16000), 16000
    except Exception as exc:
        print(
            f"⚠️ soundfile 读取音频失败，降级使用 librosa.load: {exc}",
            file=sys.stderr,
            flush=True,
        )
        import librosa

        return librosa.load(audio_path, sr=16000, mono=True)


def speaker_label_from_cluster(label):
    if isinstance(label, dict):
        return label.get("label") or label.get("best_label") or "UNKNOWN", label.get("score")
    if isinstance(label, str):
        return label, None
    return f"SPEAKER_{int(label):02d}", None


def dominant_speaker_for_interval(start, end, speaker_timeline):
    if not speaker_timeline:
        return None, None

    scores = {}
    score_meta = {}
    for item in speaker_timeline:
        label = item.get("speaker")
        if not label:
            continue
        overlap = min(float(end), float(item["end"])) - max(float(start), float(item["start"]))
        if overlap <= 0:
            continue
        scores[label] = scores.get(label, 0.0) + overlap
        if item.get("speaker_score") and label not in score_meta:
            score_meta[label] = item.get("speaker_score")

    if not scores:
        return None, None

    label = max(scores.items(), key=lambda kv: kv[1])[0]
    return label, score_meta.get(label)


def _split_speaker_embedding_rows(embedding):
    """Normalize CAM++ embedding outputs to one two-dimensional tensor per clip."""
    if embedding is None:
        return []

    fake_rows = getattr(embedding, "rows", None)
    if fake_rows is not None:
        try:
            return [embedding.__class__([row]) for row in fake_rows]
        except Exception:
            return [embedding]

    shape = getattr(embedding, "shape", None)
    if shape is None:
        return [embedding]
    try:
        dimensions = tuple(int(value) for value in shape)
        if not dimensions:
            return [embedding]
        if len(dimensions) == 1:
            return [embedding.reshape(1, -1)]
        flattened = embedding.reshape(-1, dimensions[-1])
        return [flattened[index:index + 1] for index in range(int(flattened.shape[0]))]
    except Exception:
        return [embedding]


def _generate_speaker_embeddings(spk_model_obj, chunks, batch_size=64):
    """Extract one embedding row per clip with one FunASR generate call."""
    if not chunks:
        return []

    import torch

    with suppress_model_output():
        results = spk_model_obj.generate(
            input=chunks,
            cache={},
            is_final=True,
            batch_size=max(1, int(batch_size or 64)),
        )
    if not isinstance(results, list):
        results = [results]

    embeddings = []
    for result in results:
        embedding = result.get("spk_embedding") if isinstance(result, dict) else None
        rows = _split_speaker_embedding_rows(embedding)
        if not rows:
            embeddings.append(None)
            continue
        for row in rows:
            embeddings.append(
                row if row is not None and torch.isfinite(row).all() else None
            )
    if len(embeddings) < len(chunks):
        embeddings.extend([None] * (len(chunks) - len(embeddings)))
    return embeddings[:len(chunks)]


def build_speaker_reference_centroids(spk_model_obj, references, device, batch_size=64):
    if not isinstance(references, list) or not references:
        return None

    import torch

    embeddings_by_speaker = {}
    batched_chunks = []
    chunk_speakers = []
    chunk_counts = {}
    default_max_chunks = 24
    for ref in references:
        if not isinstance(ref, dict):
            continue
        speaker = str(ref.get("speaker") or ref.get("label") or "").strip()
        audio_path = ref.get("audio_path") or ref.get("path")
        if not speaker or not audio_path or not os.path.exists(audio_path):
            continue
        log_progress(f"加载说话人参考音频: speaker={speaker}, path={audio_path}")
        audio, sample_rate = load_audio_16k_mono(audio_path)
        start_s = max(0.0, float(ref.get("start_s", 0) or 0))
        end_s = float(ref.get("end_s", 0) or 0)
        start_idx = min(len(audio), int(start_s * sample_rate))
        end_idx = min(len(audio), int(end_s * sample_rate)) if end_s > start_s else len(audio)
        audio = audio[start_idx:end_idx]
        chunk_s = float(ref.get("chunk_s", 8) or 8)
        max_chunks = int(ref.get("max_chunks", default_max_chunks) or default_max_chunks)
        chunk_len = max(1, int(chunk_s * sample_rate))
        chunks = []
        for idx in range(0, len(audio), chunk_len):
            chunk = audio[idx:idx + chunk_len]
            if len(chunk) < sample_rate:
                continue
            chunks.append(chunk)
            if len(chunks) >= max_chunks:
                break
        if not chunks:
            continue
        batched_chunks.extend(chunks)
        chunk_speakers.extend([speaker] * len(chunks))
        chunk_counts[speaker] = chunk_counts.get(speaker, 0) + len(chunks)

    embeddings = _generate_speaker_embeddings(
        spk_model_obj,
        batched_chunks,
        batch_size=batch_size,
    )
    for speaker, embedding in zip(chunk_speakers, embeddings):
        if embedding is not None:
            embeddings_by_speaker.setdefault(speaker, []).append(embedding)

    for speaker, count in chunk_counts.items():
        valid_count = len(embeddings_by_speaker.get(speaker, []))
        log_progress(
            f"参考说话人完成: speaker={speaker}, chunks={count}, valid_embeddings={valid_count}"
        )

    centroids = {}
    for speaker, speaker_embeddings in embeddings_by_speaker.items():
        embeddings = torch.cat(speaker_embeddings, dim=0)
        embeddings = torch.nn.functional.normalize(embeddings, dim=1)
        centroids[speaker] = embeddings.to("cpu")
        log_progress(f"参考说话人聚合完成: speaker={speaker}, embeddings={len(speaker_embeddings)}")
    return centroids or None


def classify_speaker_embeddings(spk_results, references, threshold, margin_threshold=0.0):
    if not references:
        return None

    import torch

    labels = []
    ref_items = list(references.items())
    for result in spk_results:
        embedding = torch.nn.functional.normalize(result["spk_embedding"].to("cpu"), dim=1)
        best_label = None
        second_label = None
        best_score = -1.0
        second_score = -1.0
        for label, centroid in ref_items:
            score = float(torch.matmul(embedding, centroid.T).max().item())
            if score > best_score:
                second_label = best_label
                second_score = best_score
                best_label = label
                best_score = score
            elif score > second_score:
                second_label = label
                second_score = score
        margin = best_score - second_score if second_score > -1.0 else best_score
        is_confident = best_score >= threshold and margin >= margin_threshold
        labels.append({
            "label": best_label if is_confident else "UNKNOWN",
            "score": best_score,
            "best_label": best_label,
            "second_label": second_label,
            "second_score": second_score,
            "margin": margin,
            "accepted": is_confident,
        })
    return labels


def collect_speaker_chunks_from_intervals(audio, sample_rate, intervals, min_segment_s=0.8, chunk_s=8.0, max_chunks=24):
    chunks = []
    if audio is None or sample_rate <= 0:
        return chunks

    chunk_len = max(1, int(float(chunk_s or 8.0) * sample_rate))
    min_len = max(1, int(float(min_segment_s or 0.8) * sample_rate))

    for interval in intervals:
        if not isinstance(interval, dict):
            continue
        start = max(0.0, float(interval.get("start", 0.0) or 0.0))
        end = max(start, float(interval.get("end", start) or start))
        start_idx = max(0, int(start * sample_rate))
        end_idx = min(len(audio), int(end * sample_rate))
        if end_idx <= start_idx:
            continue

        segment = audio[start_idx:end_idx]
        if len(segment) < min_len:
            continue

        for idx in range(0, len(segment), chunk_len):
            chunk = segment[idx:idx + chunk_len]
            if len(chunk) < min_len:
                continue
            chunks.append(chunk)
            if len(chunks) >= max_chunks:
                return chunks

    return chunks


def build_speaker_chunk_candidates(
    audio,
    sample_rate,
    intervals,
    chunk_s=4.0,
    min_chunk_s=1.0,
):
    """Build chronological, non-overlapping chunks with cumulative-speech offsets."""
    if audio is None or sample_rate <= 0:
        return []

    chunk_len = max(1, int(float(chunk_s or 4.0) * sample_rate))
    min_len = max(1, int(float(min_chunk_s or 1.0) * sample_rate))
    candidates = []
    speech_offset = 0.0
    normalized_intervals = []
    for interval in intervals or []:
        if not isinstance(interval, dict):
            continue
        start = max(0.0, float(interval.get("start", 0.0) or 0.0))
        end = max(start, float(interval.get("end", start) or start))
        normalized_intervals.append((start, end))

    for start, end in sorted(normalized_intervals):
        start_idx = max(0, int(start * sample_rate))
        end_idx = min(len(audio), int(end * sample_rate))
        for chunk_start_idx in range(start_idx, end_idx, chunk_len):
            chunk_end_idx = min(end_idx, chunk_start_idx + chunk_len)
            if chunk_end_idx - chunk_start_idx < min_len:
                continue
            chunk_start = float(chunk_start_idx) / sample_rate
            chunk_end = float(chunk_end_idx) / sample_rate
            duration = chunk_end - chunk_start
            candidates.append({
                "index": len(candidates),
                "start": chunk_start,
                "end": chunk_end,
                "duration": duration,
                "speech_start": speech_offset,
                "speech_end": speech_offset + duration,
                "chunk": audio[chunk_start_idx:chunk_end_idx],
            })
            speech_offset += duration
    return candidates


def select_cumulative_speech_quantiles(candidates, max_chunks=2000):
    """Select deterministic quantiles over cumulative usable speech, not wall time."""
    candidates = list(candidates or [])
    limit = max(0, int(max_chunks or 0))
    if not candidates or limit <= 0:
        return []
    if len(candidates) <= limit:
        return candidates

    total_speech = float(candidates[-1].get("speech_end", 0.0) or 0.0)
    if total_speech <= 0:
        indices = [int(math.floor((rank + 0.5) * len(candidates) / limit)) for rank in range(limit)]
    else:
        indices = []
        candidate_index = 0
        for rank in range(limit):
            target = (rank + 0.5) * total_speech / limit
            while (
                candidate_index + 1 < len(candidates)
                and float(candidates[candidate_index].get("speech_end", 0.0)) < target
            ):
                candidate_index += 1
            indices.append(candidate_index)

    selected = []
    previous_index = -1
    for rank, index in enumerate(indices):
        minimum_index = previous_index + 1
        maximum_index = len(candidates) - (limit - rank)
        index = min(maximum_index, max(minimum_index, index))
        selected.append(candidates[index])
        previous_index = index
    return selected


def _cluster_label_values(labels):
    if labels is None:
        return []
    if hasattr(labels, "tolist"):
        labels = labels.tolist()
    values = []
    for label in labels:
        if isinstance(label, dict):
            label = label.get("label", label.get("spk", label.get("cluster")))
        if hasattr(label, "item"):
            label = label.item()
        values.append(label)
    return values


def _cluster_embeddings(clusterer, embeddings, merge_threshold):
    """Invoke a supplied backend without ever providing an oracle speaker count."""
    try:
        return clusterer(embeddings, merge_thr=merge_threshold, oracle_num=None)
    except TypeError:
        try:
            return clusterer(embeddings, oracle_num=None)
        except TypeError:
            return clusterer(embeddings)


def _cluster_partition_agreement(left_labels, right_labels):
    """Compare cluster partitions without depending on backend label numbering."""
    left = _cluster_label_values(left_labels)
    right = _cluster_label_values(right_labels)
    if len(left) != len(right) or not left:
        return 0.0
    pair_count = 0
    matching_pairs = 0
    for left_index in range(len(left)):
        for right_index in range(left_index + 1, len(left)):
            pair_count += 1
            if (left[left_index] == left[right_index]) == (
                right[left_index] == right[right_index]
            ):
                matching_pairs += 1
    return 1.0 if pair_count == 0 else matching_pairs / pair_count


def decide_adaptive_speaker_mode(
    primary_labels,
    confirmation_labels=None,
    chunk_durations=None,
    min_valid_chunks=6,
    min_speech_s=20.0,
    min_cluster_chunks=2,
    min_cluster_s=6.0,
    min_cohesion=0.7,
):
    """Return single/multiple/inconclusive from stable, supported evidence."""
    primary = _cluster_label_values(primary_labels)
    confirmation = _cluster_label_values(confirmation_labels)
    durations = [max(0.0, float(value or 0.0)) for value in (chunk_durations or [])]
    if len(durations) < len(primary):
        durations.extend([0.0] * (len(primary) - len(durations)))
    if not primary:
        return {
            "decision": "inconclusive",
            "reason": "no_valid_probe_embeddings",
            "speaker_count": None,
            "detected_clusters": 0,
            "supported_clusters": 0,
            "cluster_sizes": [],
            "cohesion": 0.0,
        }

    def evidence(labels):
        counts = {}
        speech = {}
        for index, label in enumerate(labels):
            counts[label] = counts.get(label, 0) + 1
            speech[label] = speech.get(label, 0.0) + durations[index]
        supported = [
            label for label, count in counts.items()
            if count >= max(1, int(min_cluster_chunks or 1))
            and speech.get(label, 0.0) >= max(0.0, float(min_cluster_s or 0.0))
        ]
        return counts, speech, supported

    primary_counts, primary_speech, primary_supported = evidence(primary)
    total_speech = sum(durations[:len(primary)])
    cluster_sizes = sorted(primary_counts.values(), reverse=True)
    cluster_speech = sorted(primary_speech.values(), reverse=True)
    common = {
        "detected_clusters": len(primary_counts),
        "supported_clusters": len(primary_supported),
        "cluster_sizes": cluster_sizes,
        "cluster_speech_s": cluster_speech,
    }

    if len(primary_counts) == 1 and len(set(confirmation)) == 1:
        if len(primary) < max(1, int(min_valid_chunks or 1)):
            return dict(common, decision="inconclusive", reason="insufficient_valid_chunks",
                        speaker_count=None, cohesion=1.0)
        if total_speech < max(0.0, float(min_speech_s or 0.0)):
            return dict(common, decision="inconclusive", reason="insufficient_sampled_speech",
                        speaker_count=None, cohesion=1.0)
        return dict(common, decision="single", reason="confident_single_speaker",
                    speaker_count=1, cohesion=1.0)

    confirmation_counts, _confirmation_speech, confirmation_supported = evidence(confirmation)
    cohesion = _cluster_partition_agreement(primary, confirmation)
    if (
        len(primary_supported) >= 2
        and len(confirmation_supported) >= 2
        and cohesion >= max(0.0, min(1.0, float(min_cohesion or 0.0)))
    ):
        return dict(
            common,
            decision="multiple",
            reason="stable_multi_speaker_evidence",
            speaker_count=len(primary_supported),
            cohesion=cohesion,
            confirmation_cluster_sizes=sorted(confirmation_counts.values(), reverse=True),
        )
    return dict(
        common,
        decision="inconclusive",
        reason="multi_speaker_evidence_not_stable",
        speaker_count=None,
        cohesion=cohesion,
        confirmation_cluster_sizes=sorted(confirmation_counts.values(), reverse=True),
    )


def _timeline_from_chunk_labels(candidates, labels, reference_matches=None):
    timeline = []
    matches = reference_matches or {}
    for candidate, raw_label in zip(candidates, _cluster_label_values(labels)):
        cluster_label = f"SPEAKER_{int(raw_label):02d}" if str(raw_label).isdigit() else str(raw_label)
        match = matches.get(cluster_label, {})
        speaker = match.get("label", cluster_label)
        timeline.append({
            "start": candidate["start"],
            "end": candidate["end"],
            "speaker": speaker,
            "speaker_score": match.get("score"),
            "speaker_cluster": cluster_label,
            "speaker_best_label": match.get("best_label"),
            "speaker_best_score": match.get("score"),
        })
    return timeline


def run_adaptive_speaker_engine(
    spk_model_obj,
    audio,
    sample_rate,
    intervals,
    payload=None,
    references=None,
    clusterer=None,
):
    """Run adaptive speaker clustering and return timeline plus processing metadata."""
    payload = payload if isinstance(payload, dict) else {}
    mode = str(payload.get("speaker_detection_mode", "auto") or "auto").lower()
    if mode not in {"auto", "always"}:
        mode = "auto"
    fail_open = bool(payload.get("speaker_probe_fail_open", True))
    started = time.perf_counter()
    timings = {
        "probe_embedding_s": 0.0,
        "probe_clustering_s": 0.0,
        "full_embedding_s": 0.0,
        "full_clustering_s": 0.0,
        "reference_matching_s": 0.0,
        "total_s": 0.0,
    }
    processing = {
        "mode": mode,
        "status": "pending",
        "decision": "not_probed" if mode == "always" else "inconclusive",
        "reason": "always_mode" if mode == "always" else "not_started",
        "full_run": False,
        "fail_open": fail_open,
        "sampledChunks": 0,
        "validChunks": 0,
        "detectedClusters": 0,
        "supportedClusters": 0,
        "sampledSpeechSeconds": 0.0,
        "probe_embeddings_reused": 0,
        "timings": timings,
    }

    def finish(timeline, reference_matches):
        processing.update({
            "sampled_chunks": processing["sampledChunks"],
            "valid_chunks": processing["validChunks"],
            "detected_clusters": processing["detectedClusters"],
            "supported_clusters": processing["supportedClusters"],
            "sampled_speech_s": processing["sampledSpeechSeconds"],
            "sampled_speech_seconds": processing["sampledSpeechSeconds"],
        })
        timings["total_s"] = time.perf_counter() - started
        return {
            "timeline": timeline,
            "reference_matches": reference_matches,
            "processing": processing,
        }

    def mark_failed(exc, reason):
        processing.update({
            "status": "failed",
            "reason": reason,
            "full_run": bool(processing["full_run"]),
            "error": {"type": type(exc).__name__, "message": str(exc)},
        })

    try:
        candidates = build_speaker_chunk_candidates(
            audio,
            sample_rate,
            intervals,
            chunk_s=float(payload.get("speaker_probe_chunk_s", 4.0) or 4.0),
            min_chunk_s=1.0,
        )
    except Exception as exc:
        mark_failed(exc, "candidate_generation_failed")
        return finish([], {})
    if not candidates:
        processing.update({
            "status": "skipped_single_speaker",
            "decision": "single",
            "reason": "no_usable_speech",
        })
        return finish([], {})

    import torch

    if clusterer is None:
        from funasr.models.campplus.cluster_backend import ClusterBackend

        cluster_device = payload.get("speaker_cluster_device", "cpu")

        def clusterer(embeddings, merge_thr, oracle_num=None):
            backend = ClusterBackend(merge_thr=merge_thr).to(cluster_device)
            return backend(embeddings, oracle_num=None)

    merge_threshold = float(payload.get("speaker_merge_threshold", 0.78) or 0.78)
    separation_margin = abs(float(
        payload.get("speaker_probe_separation_margin", 0.03) or 0.03
    ))
    probe_by_index = {}
    should_run_full = mode == "always"

    if mode == "auto":
        probe_candidates = select_cumulative_speech_quantiles(
            candidates,
            max_chunks=int(payload.get("speaker_probe_max_chunks", 2000) or 2000),
        )
        processing["sampledChunks"] = len(probe_candidates)
        processing["sampledSpeechSeconds"] = sum(
            candidate["duration"] for candidate in probe_candidates
        )
        try:
            stage_started = time.perf_counter()
            probe_embeddings = _generate_speaker_embeddings(
                spk_model_obj,
                [candidate["chunk"] for candidate in probe_candidates],
                batch_size=int(payload.get("speaker_embedding_batch_size", 64) or 64),
            )
            timings["probe_embedding_s"] = time.perf_counter() - stage_started
            valid_probe = [
                (candidate, embedding)
                for candidate, embedding in zip(probe_candidates, probe_embeddings)
                if embedding is not None
            ]
            probe_by_index = {
                candidate["index"]: embedding for candidate, embedding in valid_probe
            }
            processing["validChunks"] = len(valid_probe)
            if not valid_probe:
                raise RuntimeError("speaker probe embeddings are all invalid")

            probe_matrix = torch.cat(
                [embedding for _candidate, embedding in valid_probe], dim=0
            )
            if hasattr(probe_matrix, "to"):
                probe_matrix = probe_matrix.to("cpu")
            stage_started = time.perf_counter()
            primary_labels = _cluster_embeddings(
                clusterer, probe_matrix, merge_threshold
            )
            confirmation_labels = _cluster_embeddings(
                clusterer,
                probe_matrix,
                max(0.0, merge_threshold - separation_margin),
            )
            timings["probe_clustering_s"] = time.perf_counter() - stage_started
            evidence = decide_adaptive_speaker_mode(
                primary_labels,
                confirmation_labels,
                chunk_durations=[candidate["duration"] for candidate, _ in valid_probe],
                min_valid_chunks=int(
                    payload.get("speaker_probe_min_valid_chunks", 6) or 6
                ),
                min_speech_s=float(
                    payload.get("speaker_probe_min_speech_s", 20.0) or 20.0
                ),
                min_cluster_chunks=int(
                    payload.get("speaker_probe_min_cluster_chunks", 2) or 2
                ),
                min_cluster_s=float(
                    payload.get("speaker_probe_min_cluster_s", 6.0) or 6.0
                ),
                min_cohesion=float(
                    payload.get("speaker_probe_min_cohesion", 0.7) or 0.7
                ),
            )
            processing.update({
                "decision": evidence["decision"],
                "reason": evidence["reason"],
                "detectedClusters": evidence["detected_clusters"],
                "supportedClusters": evidence["supported_clusters"],
                "cohesion": evidence["cohesion"],
                "cluster_sizes": evidence["cluster_sizes"],
                "cluster_speech_s": evidence["cluster_speech_s"],
            })
            if evidence["decision"] == "single":
                processing["status"] = "skipped_single_speaker"
                return finish([], {})
            should_run_full = True
        except Exception as exc:
            processing.update({
                "decision": "inconclusive",
                "reason": "probe_failed_fail_open" if fail_open else "probe_failed",
                "probe_error": {"type": type(exc).__name__, "message": str(exc)},
            })
            if not fail_open:
                mark_failed(exc, "probe_failed")
                return finish([], {})
            should_run_full = True

    if not should_run_full:
        processing["status"] = "failed"
        processing["reason"] = "full_run_not_selected"
        return finish([], {})

    processing["full_run"] = True
    remaining_candidates = [
        candidate for candidate in candidates
        if candidate["index"] not in probe_by_index
    ]
    try:
        stage_started = time.perf_counter()
        remaining_embeddings = _generate_speaker_embeddings(
            spk_model_obj,
            [candidate["chunk"] for candidate in remaining_candidates],
            batch_size=int(payload.get("speaker_embedding_batch_size", 64) or 64),
        )
        timings["full_embedding_s"] = time.perf_counter() - stage_started
        embedding_by_index = dict(probe_by_index)
        for candidate, embedding in zip(remaining_candidates, remaining_embeddings):
            if embedding is not None:
                embedding_by_index[candidate["index"]] = embedding
        valid_full = [
            (candidate, embedding_by_index[candidate["index"]])
            for candidate in candidates
            if candidate["index"] in embedding_by_index
        ]
        processing["probe_embeddings_reused"] = len(probe_by_index)
        processing["full_valid_chunks"] = len(valid_full)
        if not valid_full:
            raise RuntimeError("speaker full embeddings are all invalid")

        full_matrix = torch.cat(
            [embedding for _candidate, embedding in valid_full], dim=0
        )
        if hasattr(full_matrix, "to"):
            full_matrix = full_matrix.to("cpu")
        stage_started = time.perf_counter()
        full_labels = _cluster_label_values(
            _cluster_embeddings(clusterer, full_matrix, merge_threshold)
        )
        timings["full_clustering_s"] = time.perf_counter() - stage_started
        if len(full_labels) != len(valid_full):
            raise RuntimeError("speaker clustering label count mismatch")

        grouped = {}
        for raw_label, (_candidate, embedding) in zip(full_labels, valid_full):
            cluster_label = (
                f"SPEAKER_{int(raw_label):02d}"
                if str(raw_label).isdigit()
                else str(raw_label)
            )
            grouped.setdefault(cluster_label, []).append(embedding)
        cluster_embeddings = {
            label: torch.nn.functional.normalize(
                torch.cat(embeddings, dim=0).to("cpu"),
                dim=1,
            )
            for label, embeddings in grouped.items()
        }
        reference_matches = {}
        if references:
            stage_started = time.perf_counter()
            try:
                resolved_references = references() if callable(references) else references
                if resolved_references:
                    reference_matches = classify_speaker_clusters(
                        cluster_embeddings,
                        resolved_references,
                        float(payload.get("speaker_reference_threshold", 0.45) or 0.45),
                        float(payload.get("speaker_reference_margin", 0.0) or 0.0),
                        bool(payload.get("speaker_constrain_to_references", False)),
                    )
            except Exception as exc:
                processing["reference_error"] = {
                    "type": type(exc).__name__, "message": str(exc)
                }
            finally:
                timings["reference_matching_s"] = time.perf_counter() - stage_started
        timeline = _timeline_from_chunk_labels(
            [candidate for candidate, _embedding in valid_full],
            full_labels,
            reference_matches,
        )
        processing["status"] = "full_completed"
        if mode == "always":
            processing.update({
                "decision": "always",
                "reason": "always_mode_full_clustering",
                "detectedClusters": len(grouped),
                "supportedClusters": len(grouped),
            })
        return finish(timeline, reference_matches)
    except Exception as exc:
        mark_failed(exc, "full_clustering_failed")
        return finish([], {})


def build_cluster_embeddings_from_sentence_info(spk_model_obj, audio, sample_rate, sentence_info, payload, device):
    import torch

    min_segment_s = float(payload.get("speaker_min_segment_s", 0.8) or 0.8)
    chunk_s = float(payload.get("speaker_max_segment_s", 8) or 8)
    max_chunks = int(payload.get("speaker_cluster_max_chunks", 24) or 24)

    clusters = {}
    cluster_order = []
    for sent in sentence_info or []:
        spk = sent.get("spk")
        if spk is None:
            continue
        cluster_label = f"SPEAKER_{int(spk):02d}" if str(spk).isdigit() else str(spk)
        if cluster_label not in clusters:
            clusters[cluster_label] = []
            cluster_order.append(cluster_label)
        normalized_interval = dict(sent)
        normalized_interval["start"] = float(sent.get("start", 0.0) or 0.0) / 1000.0
        normalized_interval["end"] = float(sent.get("end", sent.get("start", 0.0)) or 0.0) / 1000.0
        clusters[cluster_label].append(normalized_interval)

    cluster_embeddings = {}
    batched_chunks = []
    chunk_clusters = []
    chunk_counts = {}
    for cluster_label in cluster_order:
        chunks = collect_speaker_chunks_from_intervals(
            audio,
            sample_rate,
            clusters.get(cluster_label, []),
            min_segment_s=min_segment_s,
            chunk_s=chunk_s,
            max_chunks=max_chunks,
        )
        if not chunks:
            continue
        batched_chunks.extend(chunks)
        chunk_clusters.extend([cluster_label] * len(chunks))
        chunk_counts[cluster_label] = len(chunks)

    grouped_embeddings = {}
    embeddings = _generate_speaker_embeddings(
        spk_model_obj,
        batched_chunks,
        batch_size=int(payload.get("speaker_embedding_batch_size", 64) or 64),
    )
    for cluster_label, embedding in zip(chunk_clusters, embeddings):
        if embedding is not None:
            grouped_embeddings.setdefault(cluster_label, []).append(embedding)

    for cluster_label in cluster_order:
        valid_embeddings = grouped_embeddings.get(cluster_label, [])
        if not valid_embeddings:
            continue
        embeddings = torch.cat(valid_embeddings, dim=0)
        embeddings = torch.nn.functional.normalize(embeddings, dim=1)
        cluster_embeddings[cluster_label] = embeddings.to("cpu")
        log_progress(
            f"  簇 embedding 完成: cluster={cluster_label}, "
            f"chunks={chunk_counts.get(cluster_label, 0)}, valid_embeddings={len(valid_embeddings)}"
        )

    return cluster_embeddings


def classify_speaker_clusters(cluster_embeddings, references, threshold, margin_threshold=0.0, constrain_to_references=False):
    if not cluster_embeddings or not references:
        return {}

    import torch

    matches = {}
    for cluster_label, embeddings in cluster_embeddings.items():
        best_label = None
        second_label = None
        best_score = -1.0
        second_score = -1.0
        for label, centroid in references.items():
            score = float(torch.matmul(embeddings, centroid.T).max().item())
            if score > best_score:
                second_label = best_label
                second_score = best_score
                best_label = label
                best_score = score
            elif score > second_score:
                second_label = label
                second_score = score
        margin = best_score - second_score if second_score > -1.0 else best_score
        is_confident = bool(
            best_label and best_score >= threshold and margin >= margin_threshold
        )
        matches[cluster_label] = {
            "label": (
                best_label
                if is_confident
                else ("UNKNOWN" if constrain_to_references else cluster_label)
            ),
            "score": best_score,
            "best_label": best_label,
            "second_label": second_label,
            "second_score": second_score,
            "margin": margin,
            "accepted": is_confident,
        }
    return matches


def smooth_speaker_timeline(speaker_timeline, fill_gap_s, max_unknown_duration_s):
    if not speaker_timeline:
        return speaker_timeline

    items = sorted(speaker_timeline, key=lambda item: (float(item.get("start", 0.0)), float(item.get("end", 0.0))))

    def nearest_known_left(index):
        for left in range(index - 1, -1, -1):
            if items[left].get("speaker") and items[left].get("speaker") != "UNKNOWN":
                return items[left]
        return None

    def nearest_known_right(index):
        for right in range(index + 1, len(items)):
            if items[right].get("speaker") and items[right].get("speaker") != "UNKNOWN":
                return items[right]
        return None

    for index, item in enumerate(items):
        if item.get("speaker") != "UNKNOWN":
            continue

        start = float(item.get("start", 0.0))
        end = float(item.get("end", start))
        duration = max(0.0, end - start)
        best_label = item.get("speaker_best_label")
        best_score = item.get("speaker_best_score")
        prev_item = nearest_known_left(index)
        next_item = nearest_known_right(index)

        if prev_item and next_item and prev_item.get("speaker") == next_item.get("speaker"):
            left_gap = max(0.0, start - float(prev_item.get("end", start)))
            right_gap = max(0.0, float(next_item.get("start", end)) - end)
            if duration <= max_unknown_duration_s and left_gap <= fill_gap_s and right_gap <= fill_gap_s:
                item["speaker"] = prev_item.get("speaker")
                item["speaker_score"] = max(
                    float(prev_item.get("speaker_score") or 0.0),
                    float(next_item.get("speaker_score") or 0.0),
                )
                item["speaker_smooth_reason"] = "between_same_speaker"
                continue

        if best_label and best_label != "UNKNOWN" and best_score is not None and duration <= max_unknown_duration_s:
            best_score = float(best_score)
            if prev_item and prev_item.get("speaker") == best_label:
                left_gap = max(0.0, start - float(prev_item.get("end", start)))
                if left_gap <= fill_gap_s and best_score >= 0.30:
                    item["speaker"] = best_label
                    item["speaker_score"] = best_score
                    item["speaker_smooth_reason"] = "left_neighbor_vote"
                    continue
            if next_item and next_item.get("speaker") == best_label:
                right_gap = max(0.0, float(next_item.get("start", end)) - end)
                if right_gap <= fill_gap_s and best_score >= 0.30:
                    item["speaker"] = best_label
                    item["speaker_score"] = best_score
                    item["speaker_smooth_reason"] = "right_neighbor_vote"
                    continue

    return items
