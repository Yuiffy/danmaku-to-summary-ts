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


def build_speaker_reference_prototypes(
    embeddings,
    merge_threshold=0.72,
    max_prototypes=6,
    min_support_chunks=2,
):
    """Compress one speaker's reference chunks into supported acoustic modes."""
    if embeddings is None or hasattr(embeddings, "rows"):
        return embeddings, []

    import torch

    matrix = torch.nn.functional.normalize(embeddings.to("cpu"), dim=1)
    row_count = int(matrix.shape[0])
    if row_count <= 1:
        return matrix, [row_count] if row_count else []

    clusters = [[index] for index in range(row_count)]
    threshold = max(-1.0, min(1.0, float(merge_threshold or 0.0)))
    limit = max(1, int(max_prototypes or 1))
    minimum_support = max(1, int(min_support_chunks or 1))

    def centroid(indices):
        value = matrix[indices].mean(dim=0, keepdim=True)
        return torch.nn.functional.normalize(value, dim=1)

    while len(clusters) > 1:
        centroids = [centroid(indices) for indices in clusters]
        best_pair = None
        best_score = -2.0
        for left in range(len(centroids)):
            for right in range(left + 1, len(centroids)):
                score = float(
                    torch.matmul(
                        centroids[left],
                        centroids[right].T,
                    ).item()
                )
                if score > best_score:
                    best_score = score
                    best_pair = (left, right)
        if best_pair is None:
            break
        if len(clusters) <= limit and best_score < threshold:
            break
        left, right = best_pair
        clusters[left] = clusters[left] + clusters[right]
        del clusters[right]

    supported_clusters = [
        indices for indices in clusters
        if len(indices) >= minimum_support
    ]
    if not supported_clusters:
        supported_clusters = [max(clusters, key=len)]

    prototypes = torch.cat(
        [centroid(indices) for indices in supported_clusters],
        dim=0,
    )
    return prototypes.to("cpu"), [len(indices) for indices in supported_clusters]


def build_speaker_reference_centroids(
    spk_model_obj,
    references,
    device,
    batch_size=64,
    prototype_merge_threshold=0.72,
    max_prototypes=6,
    prototype_min_support_chunks=2,
):
    if not isinstance(references, list) or not references:
        return None

    import torch

    embeddings_by_speaker_state = {}
    batched_chunks = []
    chunk_identities = []
    chunk_counts = {}
    state_chunk_counts = {}
    default_max_chunks = 24
    for ref in references:
        if not isinstance(ref, dict):
            continue
        speaker = str(ref.get("speaker") or ref.get("label") or "").strip()
        state = str(ref.get("state") or "default").strip() or "default"
        audio_path = ref.get("audio_path") or ref.get("path")
        if not speaker or not audio_path or not os.path.exists(audio_path):
            continue
        log_progress(
            f"加载说话人参考音频: speaker={speaker}, "
            f"state={state}, path={audio_path}"
        )
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
        chunk_identities.extend([(speaker, state)] * len(chunks))
        chunk_counts[speaker] = chunk_counts.get(speaker, 0) + len(chunks)
        state_key = (speaker, state)
        state_chunk_counts[state_key] = (
            state_chunk_counts.get(state_key, 0) + len(chunks)
        )

    embeddings = _generate_speaker_embeddings(
        spk_model_obj,
        batched_chunks,
        batch_size=batch_size,
    )
    for (speaker, state), embedding in zip(chunk_identities, embeddings):
        if embedding is not None:
            embeddings_by_speaker_state.setdefault(speaker, {}).setdefault(
                state,
                [],
            ).append(embedding)

    for speaker, count in chunk_counts.items():
        valid_count = sum(
            len(state_embeddings)
            for state_embeddings in embeddings_by_speaker_state.get(
                speaker,
                {},
            ).values()
        )
        log_progress(
            f"参考说话人完成: speaker={speaker}, chunks={count}, valid_embeddings={valid_count}"
        )

    centroids = {}
    minimum_support = max(1, int(prototype_min_support_chunks or 1))
    prototype_limit = max(1, int(max_prototypes or 1))
    for speaker, embeddings_by_state in embeddings_by_speaker_state.items():
        all_speaker_embeddings = [
            embedding
            for state_embeddings in embeddings_by_state.values()
            for embedding in state_embeddings
        ]
        state_prototypes = []
        state_summaries = {}
        for state, state_embeddings in embeddings_by_state.items():
            if len(state_embeddings) < minimum_support:
                state_summaries[state] = {
                    "chunks": len(state_embeddings),
                    "prototype_sizes": [],
                    "dropped": True,
                }
                continue
            embeddings = torch.cat(state_embeddings, dim=0)
            embeddings = torch.nn.functional.normalize(embeddings, dim=1)
            prototypes, prototype_sizes = build_speaker_reference_prototypes(
                embeddings,
                merge_threshold=prototype_merge_threshold,
                max_prototypes=prototype_limit,
                min_support_chunks=minimum_support,
            )
            state_summaries[state] = {
                "chunks": len(state_embeddings),
                "prototype_sizes": prototype_sizes,
                "dropped": False,
            }
            for index, size in enumerate(prototype_sizes):
                state_prototypes.append({
                    "state": state,
                    "size": int(size),
                    "embedding": prototypes[index:index + 1],
                })

        if not state_prototypes and all_speaker_embeddings:
            embeddings = torch.cat(all_speaker_embeddings, dim=0)
            embeddings = torch.nn.functional.normalize(embeddings, dim=1)
            prototypes, prototype_sizes = build_speaker_reference_prototypes(
                embeddings,
                merge_threshold=prototype_merge_threshold,
                max_prototypes=prototype_limit,
                min_support_chunks=minimum_support,
            )
            if prototypes is not None and not prototype_sizes:
                centroids[speaker] = prototypes
                log_progress(
                    f"参考说话人聚合完成: speaker={speaker}, "
                    f"embeddings={len(all_speaker_embeddings)}, "
                    "prototypes=passthrough"
                )
                continue
            state_prototypes = [
                {
                    "state": "fallback",
                    "size": int(size),
                    "embedding": prototypes[index:index + 1],
                }
                for index, size in enumerate(prototype_sizes)
            ]

        if not state_prototypes:
            continue

        if len(state_prototypes) > prototype_limit:
            largest_per_state = {}
            for prototype in state_prototypes:
                state = prototype["state"]
                current = largest_per_state.get(state)
                if current is None or prototype["size"] > current["size"]:
                    largest_per_state[state] = prototype
            selected = sorted(
                largest_per_state.values(),
                key=lambda item: item["size"],
                reverse=True,
            )[:prototype_limit]
            selected_ids = {id(item) for item in selected}
            remaining = sorted(
                (
                    item for item in state_prototypes
                    if id(item) not in selected_ids
                ),
                key=lambda item: item["size"],
                reverse=True,
            )
            selected.extend(remaining[:prototype_limit - len(selected)])
            state_prototypes = selected

        centroids[speaker] = torch.cat(
            [item["embedding"] for item in state_prototypes],
            dim=0,
        ).to("cpu")
        log_progress(
            f"参考说话人聚合完成: speaker={speaker}, "
            f"embeddings={len(all_speaker_embeddings)}, "
            f"prototypes={len(state_prototypes)}, "
            f"states={state_summaries}"
        )
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
    max_chunk_s=8.0,
    min_chunk_s=0.8,
    boundary_intervals=None,
):
    """Build speaker chunks from ASR/VAD boundaries, splitting only overlong spans."""
    if audio is None or sample_rate <= 0:
        return []

    max_duration = max(0.0, float(max_chunk_s or 0.0))
    min_duration = max(0.0, float(min_chunk_s or 0.0))
    min_len = max(1, int(min_duration * sample_rate))
    candidates = []
    speech_offset = 0.0
    normalized_intervals = []
    for interval in intervals or []:
        if not isinstance(interval, dict):
            continue
        start = max(0.0, float(interval.get("start", 0.0) or 0.0))
        end = max(start, float(interval.get("end", start) or start))
        if end > start:
            normalized_intervals.append((start, end))

    boundary_points = []
    for interval in boundary_intervals or []:
        if not isinstance(interval, dict):
            continue
        start = max(0.0, float(interval.get("start", 0.0) or 0.0))
        end = max(start, float(interval.get("end", start) or start))
        if end > start:
            boundary_points.extend((start, end))
    boundary_points = sorted(set(boundary_points))

    for interval_start, interval_end in sorted(normalized_intervals):
        split_points = [interval_start]
        split_points.extend(
            point
            for point in boundary_points
            if interval_start + min_duration <= point <= interval_end - min_duration
        )
        split_points.append(interval_end)

        boundary_chunks = []
        for start, end in zip(split_points, split_points[1:]):
            if end - start < min_duration:
                if boundary_chunks:
                    previous_start, _previous_end = boundary_chunks[-1]
                    boundary_chunks[-1] = (previous_start, end)
                continue
            boundary_chunks.append((start, end))
        if (
            boundary_chunks
            and interval_end - boundary_chunks[-1][1] > 0
        ):
            previous_start, _previous_end = boundary_chunks[-1]
            boundary_chunks[-1] = (previous_start, interval_end)

        capped_chunks = []
        for start, end in boundary_chunks:
            duration = end - start
            part_count = (
                max(1, int(math.ceil(duration / max_duration)))
                if max_duration > 0
                else 1
            )
            part_duration = duration / part_count
            for part_index in range(part_count):
                chunk_start = start + part_index * part_duration
                chunk_end = (
                    end
                    if part_index + 1 == part_count
                    else start + (part_index + 1) * part_duration
                )
                capped_chunks.append((chunk_start, chunk_end))

        for chunk_start, chunk_end in capped_chunks:
            chunk_start_idx = max(0, int(chunk_start * sample_rate))
            chunk_end_idx = min(len(audio), int(chunk_end * sample_rate))
            if chunk_end_idx - chunk_start_idx < min_len:
                continue
            actual_start = float(chunk_start_idx) / sample_rate
            actual_end = float(chunk_end_idx) / sample_rate
            duration = actual_end - actual_start
            candidates.append({
                "index": len(candidates),
                "start": actual_start,
                "end": actual_end,
                "duration": duration,
                "speech_start": speech_offset,
                "speech_end": speech_offset + duration,
                "chunk": audio[chunk_start_idx:chunk_end_idx],
            })
            speech_offset += duration
    return candidates


def select_cumulative_speech_quantiles(candidates, max_chunks=256):
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


def _should_assign_from_probe_centroids(mode, evidence, max_clusters=12):
    """Use supported stable probe clusters as full-stream acoustic anchors."""
    evidence = evidence if isinstance(evidence, dict) else {}
    detected_clusters = int(evidence.get("detected_clusters", 0) or 0)
    supported_clusters = int(evidence.get("supported_clusters", 0) or 0)
    unsupported_clusters = max(0, detected_clusters - supported_clusters)
    return (
        mode == "auto"
        and evidence.get("decision") == "multiple"
        and 2 <= supported_clusters <= max(2, int(max_clusters or 2))
        and unsupported_clusters <= 1
    )


def assign_embeddings_to_probe_centroids(full_matrix, probe_embeddings, probe_labels):
    """Assign every full-stream embedding to the nearest normalized probe centroid."""
    import torch

    labels = _cluster_label_values(probe_labels)
    if len(labels) != len(probe_embeddings) or not labels:
        raise ValueError("probe embedding and label counts do not match")

    cluster_labels = list(dict.fromkeys(labels))
    if len(cluster_labels) < 2:
        raise ValueError("at least two probe clusters are required")

    probe_matrix = torch.nn.functional.normalize(
        torch.cat(probe_embeddings, dim=0).to("cpu"),
        dim=1,
    )
    centroids = []
    for cluster_label in cluster_labels:
        indices = [
            index for index, label in enumerate(labels)
            if label == cluster_label
        ]
        centroid = probe_matrix[indices].mean(dim=0, keepdim=True)
        centroids.append(torch.nn.functional.normalize(centroid, dim=1))

    normalized_full = torch.nn.functional.normalize(full_matrix.to("cpu"), dim=1)
    centroid_matrix = torch.cat(centroids, dim=0)
    assignments = torch.argmax(
        torch.matmul(normalized_full, centroid_matrix.T),
        dim=1,
    ).tolist()
    return [cluster_labels[int(index)] for index in assignments]


def refine_embeddings_from_probe_centroids(
    full_matrix,
    probe_embeddings,
    probe_labels,
    max_iterations=8,
):
    """Refine a probe partition over the full stream with fixed-K spherical k-means."""
    import torch

    labels = _cluster_label_values(probe_labels)
    if len(labels) != len(probe_embeddings) or not labels:
        raise ValueError("probe embedding and label counts do not match")

    cluster_labels = list(dict.fromkeys(labels))
    if len(cluster_labels) < 2:
        raise ValueError("at least two probe clusters are required")

    probe_matrix = torch.nn.functional.normalize(
        torch.cat(probe_embeddings, dim=0).to("cpu"),
        dim=1,
    )
    normalized_full = torch.nn.functional.normalize(full_matrix.to("cpu"), dim=1)
    centroids = []
    for cluster_label in cluster_labels:
        indices = [
            index for index, label in enumerate(labels)
            if label == cluster_label
        ]
        centroid = probe_matrix[indices].mean(dim=0, keepdim=True)
        centroids.append(torch.nn.functional.normalize(centroid, dim=1))
    centroid_matrix = torch.cat(centroids, dim=0)

    assignments = torch.argmax(
        torch.matmul(normalized_full, centroid_matrix.T),
        dim=1,
    )
    iterations = 0
    for iterations in range(1, max(1, int(max_iterations or 1)) + 1):
        updated_centroids = []
        for cluster_index in range(len(cluster_labels)):
            members = normalized_full[assignments == cluster_index]
            if int(members.shape[0]) == 0:
                updated_centroids.append(
                    centroid_matrix[cluster_index:cluster_index + 1]
                )
                continue
            centroid = members.mean(dim=0, keepdim=True)
            updated_centroids.append(
                torch.nn.functional.normalize(centroid, dim=1)
            )
        next_centroids = torch.cat(updated_centroids, dim=0)
        next_assignments = torch.argmax(
            torch.matmul(normalized_full, next_centroids.T),
            dim=1,
        )
        centroid_matrix = next_centroids
        if torch.equal(next_assignments, assignments):
            assignments = next_assignments
            break
        assignments = next_assignments

    assigned_labels = [
        cluster_labels[int(index)]
        for index in assignments.tolist()
    ]
    return assigned_labels, {
        "iterations": iterations,
        "clusters": len(cluster_labels),
    }


def merge_speaker_clusters_by_centroid_similarity(
    embeddings,
    labels,
    merge_threshold,
):
    """Merge refined clusters only when their full-stream centroids are close."""
    import torch

    values = _cluster_label_values(labels)
    if embeddings is None or len(values) != int(embeddings.shape[0]):
        raise ValueError("embedding and label counts do not match")
    if not values:
        return values, {
            "clusters_before": 0,
            "clusters_after": 0,
            "merges": [],
        }

    matrix = torch.nn.functional.normalize(embeddings.to("cpu"), dim=1)
    threshold = max(-1.0, min(1.0, float(merge_threshold)))
    merged_labels = list(values)
    clusters_before = len(set(merged_labels))
    merges = []

    while True:
        cluster_labels = list(dict.fromkeys(merged_labels))
        if len(cluster_labels) < 2:
            break
        centroids = {}
        for cluster_label in cluster_labels:
            indices = [
                index for index, label in enumerate(merged_labels)
                if label == cluster_label
            ]
            centroid = matrix[indices].mean(dim=0, keepdim=True)
            centroids[cluster_label] = torch.nn.functional.normalize(
                centroid,
                dim=1,
            )

        best_pair = None
        best_score = -2.0
        for left_index, left_label in enumerate(cluster_labels):
            for right_label in cluster_labels[left_index + 1:]:
                score = float(
                    torch.matmul(
                        centroids[left_label],
                        centroids[right_label].T,
                    ).item()
                )
                if score > best_score:
                    best_score = score
                    best_pair = (left_label, right_label)
        if best_pair is None or best_score < threshold:
            break

        left_label, right_label = best_pair
        merged_labels = [
            left_label if label == right_label else label
            for label in merged_labels
        ]
        merges.append({
            "kept": left_label,
            "merged": right_label,
            "score": best_score,
        })

    return merged_labels, {
        "clusters_before": clusters_before,
        "clusters_after": len(set(merged_labels)),
        "merges": merges,
    }


def classify_speaker_rows(
    embeddings,
    references,
    threshold,
    margin_threshold=0.0,
    top_k=3,
):
    """Classify individual acoustic rows using robust top-k reference similarity."""
    if embeddings is None or not references:
        return []

    import torch

    matrix = torch.nn.functional.normalize(embeddings.to("cpu"), dim=1)
    labels = list(references)
    if not labels:
        return []
    per_label_scores = []
    requested_top_k = max(1, int(top_k or 1))
    for label in labels:
        reference_rows = torch.nn.functional.normalize(
            references[label].to("cpu"),
            dim=1,
        )
        similarities = torch.matmul(matrix, reference_rows.T)
        score_k = min(requested_top_k, int(reference_rows.shape[0]))
        per_label_scores.append(
            torch.topk(similarities, k=score_k, dim=1).values.mean(dim=1)
        )
    score_matrix = torch.stack(per_label_scores, dim=1)
    best_scores, best_indices = torch.max(score_matrix, dim=1)
    if len(labels) > 1:
        second_scores = torch.topk(score_matrix, k=2, dim=1).values[:, 1]
    else:
        second_scores = torch.full_like(best_scores, -1.0)

    results = []
    for row_index in range(int(matrix.shape[0])):
        label_index = int(best_indices[row_index].item())
        best_label = labels[label_index]
        best_score = float(best_scores[row_index].item())
        second_score = float(second_scores[row_index].item())
        margin = (
            best_score - second_score
            if len(labels) > 1
            else best_score
        )
        accepted = bool(
            best_score >= float(threshold)
            and margin >= float(margin_threshold)
        )
        results.append({
            "label": best_label if accepted else "UNKNOWN",
            "best_label": best_label,
            "score": best_score,
            "second_score": second_score,
            "margin": margin,
            "accepted": accepted,
            "scoring_strategy": f"row_top_{requested_top_k}_reference_mean",
        })
    return results


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
        "supported_cluster_labels": list(primary_supported),
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


def _timeline_from_chunk_labels(
    candidates,
    labels,
    reference_matches=None,
    row_reference_matches=None,
    strict_row_reference_labels=None,
    row_reference_cluster_min_support_chunks=2,
    row_reference_cluster_inherit_threshold=0.45,
):
    timeline = []
    matches = reference_matches or {}
    row_matches = list(row_reference_matches or [])
    strict_labels = {
        str(label)
        for label in (strict_row_reference_labels or [])
        if str(label)
    }
    for index, (candidate, raw_label) in enumerate(
        zip(candidates, _cluster_label_values(labels))
    ):
        cluster_label = f"SPEAKER_{int(raw_label):02d}" if str(raw_label).isdigit() else str(raw_label)
        match = matches.get(cluster_label, {})
        row_match = row_matches[index] if index < len(row_matches) else {}
        direct_match = row_match if row_match.get("accepted") else {}
        direct_match_rejected = False
        direct_label = str(direct_match.get("label") or "")
        direct_support = (
            match.get("reference_support", {}).get(direct_label, {})
            if direct_label
            else {}
        )
        if (
            direct_match
            and direct_label in strict_labels
            and int(direct_support.get("support_count", 0) or 0)
            < max(1, int(row_reference_cluster_min_support_chunks or 1))
        ):
            direct_match = {}
            direct_match_rejected = True
        cluster_match_label = match.get("label", cluster_label)
        cluster_has_reference_identity = bool(
            match.get("accepted")
            and str(cluster_match_label) in strict_labels
        )
        if (
            direct_match
            and cluster_has_reference_identity
            and str(direct_match.get("label")) != str(cluster_match_label)
        ):
            direct_match = {}
            direct_match_rejected = True
        requires_row_match = str(cluster_match_label) in strict_labels
        cluster_row_match = bool(
            cluster_has_reference_identity
            and str(row_match.get("best_label") or "") == str(cluster_match_label)
            and float(row_match.get("score", -1.0) or -1.0)
            >= float(row_reference_cluster_inherit_threshold)
        )
        speaker = (
            direct_match.get("label")
            or (cluster_match_label if cluster_row_match else None)
            or (cluster_label if requires_row_match else cluster_match_label)
        )
        speaker_score = (
            direct_match.get("score")
            if direct_match
            else row_match.get("score")
            if cluster_row_match
            else row_match.get("score")
            if requires_row_match
            else match.get("score")
        )
        timeline.append({
            "start": candidate["start"],
            "end": candidate["end"],
            "speaker": speaker,
            "speaker_score": speaker_score,
            "speaker_cluster": cluster_label,
            "speaker_best_label": (
                direct_match.get("best_label")
                or (
                    row_match.get("best_label")
                    if requires_row_match
                    else None
                )
                or match.get("best_label")
            ),
            "speaker_best_score": speaker_score,
            "speaker_match_scope": (
                "row"
                if direct_match
                else "cluster_with_row_corroboration"
                if cluster_row_match
                else "cluster_rejected_by_row"
                if requires_row_match or direct_match_rejected
                else "cluster"
            ),
        })
    return timeline


def _is_anonymous_speaker_label(label):
    value = str(label or "").strip()
    return (
        not value
        or value.upper() in {"UNKNOWN", "-1"}
        or (value.upper().startswith("SPEAKER_") and value[8:].isdigit())
    )


def apply_single_host_speaker_fallback(timeline, reference_matches, processing, payload):
    """Merge weak anonymous clusters into a confirmed host-only stream.

    This is intentionally gated by the caller. A confirmed non-host reference
    match always wins and prevents the fallback from hiding a real guest.
    """
    payload = payload if isinstance(payload, dict) else {}
    if not bool(payload.get("speaker_single_host_fallback", False)):
        return timeline

    host_label = str(payload.get("speaker_host_label") or "").strip()
    if not host_label or not isinstance(reference_matches, dict):
        return timeline

    matches = [
        match for match in reference_matches.values()
        if isinstance(match, dict)
    ]
    accepted_host = any(
        match.get("accepted") is True
        and str(match.get("label") or match.get("best_label") or "").strip() == host_label
        for match in matches
    )
    accepted_non_host = any(
        match.get("accepted") is True
        and str(match.get("label") or match.get("best_label") or "").strip() != host_label
        for match in matches
    )
    if not accepted_host or accepted_non_host:
        return timeline

    changed = 0
    for item in timeline or []:
        if not _is_anonymous_speaker_label(item.get("speaker")):
            continue
        item["speaker"] = host_label
        item["speaker_fallback_reason"] = "confirmed_single_host"
        changed += 1

    if changed:
        processing["singleHostFallback"] = {
            "applied": True,
            "hostLabel": host_label,
            "changedIntervals": changed,
            "reason": "confirmed_host_only",
        }
    return timeline


def run_adaptive_speaker_engine(
    spk_model_obj,
    audio,
    sample_rate,
    intervals,
    boundary_intervals=None,
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
        "fullClusteringStrategy": "not_run",
        "intervalSource": str(
            payload.get("speaker_interval_source") or "asr_intervals"
        ),
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
            "full_clustering_strategy": processing["fullClusteringStrategy"],
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
            max_chunk_s=float(
                payload.get("speaker_max_segment_s", 8.0) or 8.0
            ),
            min_chunk_s=float(
                payload.get("speaker_min_segment_s", 0.8) or 0.8
            ),
            boundary_intervals=boundary_intervals,
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
    probe_assignment_embeddings = []
    probe_assignment_labels = []
    should_run_full = mode == "always"

    if mode == "auto":
        probe_candidates = select_cumulative_speech_quantiles(
            candidates,
            max_chunks=int(payload.get("speaker_probe_max_chunks", 256) or 256),
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
            if _should_assign_from_probe_centroids(
                mode,
                evidence,
                max_clusters=int(
                    payload.get("speaker_probe_max_assignment_clusters", 12) or 12
                ),
            ):
                supported_labels = set(
                    evidence.get("supported_cluster_labels") or []
                )
                primary_label_values = _cluster_label_values(primary_labels)
                supported_probe_rows = [
                    (embedding, label)
                    for (_candidate, embedding), label in zip(
                        valid_probe,
                        primary_label_values,
                    )
                    if label in supported_labels
                ]
                probe_assignment_embeddings = [
                    embedding for embedding, _label in supported_probe_rows
                ]
                probe_assignment_labels = [
                    label for _embedding, label in supported_probe_rows
                ]
                processing["ignoredUnsupportedProbeClusters"] = max(
                    0,
                    int(evidence.get("detected_clusters", 0) or 0)
                    - int(evidence.get("supported_clusters", 0) or 0),
                )
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
        if probe_assignment_labels:
            try:
                if bool(payload.get("speaker_full_refine_enabled", True)):
                    full_labels, refinement = (
                        refine_embeddings_from_probe_centroids(
                            full_matrix,
                            probe_assignment_embeddings,
                            probe_assignment_labels,
                            max_iterations=int(
                                payload.get(
                                    "speaker_full_refine_iterations",
                                    8,
                                )
                                or 8
                            ),
                        )
                    )
                    processing["fullClusteringStrategy"] = (
                        "probe_spherical_kmeans"
                    )
                    full_labels, post_merge = (
                        merge_speaker_clusters_by_centroid_similarity(
                            full_matrix,
                            full_labels,
                            merge_threshold,
                        )
                    )
                    refinement["post_merge"] = post_merge
                    processing["fullRefinement"] = refinement
                else:
                    full_labels = assign_embeddings_to_probe_centroids(
                        full_matrix,
                        probe_assignment_embeddings,
                        probe_assignment_labels,
                    )
                    processing["fullClusteringStrategy"] = (
                        "probe_centroid_assignment"
                    )
                processing["probeAssignmentClusters"] = len(
                    set(probe_assignment_labels)
                )
            except Exception as exc:
                processing["probe_assignment_error"] = {
                    "type": type(exc).__name__, "message": str(exc)
                }
                full_labels = _cluster_label_values(
                    _cluster_embeddings(clusterer, full_matrix, merge_threshold)
                )
                processing["fullClusteringStrategy"] = "full_clustering_fallback"
        else:
            full_labels = _cluster_label_values(
                _cluster_embeddings(clusterer, full_matrix, merge_threshold)
            )
            processing["fullClusteringStrategy"] = "full_clustering"
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
        row_reference_matches = []
        strict_reference_labels = []
        if references:
            stage_started = time.perf_counter()
            try:
                resolved_references = references() if callable(references) else references
                if resolved_references:
                    host_label = str(
                        payload.get("speaker_host_label") or ""
                    ).strip()
                    constrain_to_references = bool(
                        payload.get("speaker_constrain_to_references", False)
                    )
                    reference_matches = classify_speaker_clusters(
                        cluster_embeddings,
                        resolved_references,
                        float(payload.get("speaker_reference_threshold", 0.45) or 0.45),
                        float(payload.get("speaker_reference_margin", 0.0) or 0.0),
                        constrain_to_references,
                        max_sample_chunks=int(
                            payload.get("speaker_reference_max_sample_chunks", 24) or 24
                        ),
                        min_support_chunks=int(
                            payload.get("speaker_reference_min_support_chunks", 2) or 2
                        ),
                        min_support_ratio=float(
                            payload.get(
                                "speaker_reference_min_support_ratio",
                                0.0,
                            )
                            or 0.0
                        ),
                    )
                    processing["referenceMatches"] = reference_matches
                    processing["reference_matches"] = reference_matches
                    strict_reference_labels = list(resolved_references)
                    processing["referenceLabels"] = strict_reference_labels
                    row_reference_matches = classify_speaker_rows(
                        full_matrix,
                        resolved_references,
                        float(
                            payload.get(
                                "speaker_row_reference_threshold",
                                0.55,
                            )
                            or 0.55
                        ),
                        float(
                            payload.get(
                                "speaker_row_reference_margin",
                                0.08,
                            )
                            or 0.08
                        ),
                        top_k=int(
                            payload.get(
                                "speaker_row_reference_top_k",
                                2,
                            )
                            or 2
                        ),
                    )
                    processing["rowReferenceMatches"] = {
                        label: sum(
                            1
                            for match in row_reference_matches
                            if match.get("accepted")
                            and match.get("label") == label
                        )
                        for label in strict_reference_labels
                    }
                    if host_label and host_label in resolved_references:
                        processing["hostLabel"] = host_label
                        processing["hostRowMatches"] = sum(
                            1
                            for match in row_reference_matches
                            if match.get("accepted")
                            and match.get("label") == host_label
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
            row_reference_matches,
            strict_row_reference_labels=strict_reference_labels,
            row_reference_cluster_min_support_chunks=int(
                payload.get("speaker_reference_min_support_chunks", 2) or 2
            ),
            row_reference_cluster_inherit_threshold=float(
                payload.get("speaker_reference_threshold", 0.45) or 0.45
            ),
        )
        processing["status"] = "full_completed"
        if mode == "always":
            processing.update({
                "decision": "always",
                "reason": "always_mode_full_clustering",
                "detectedClusters": len(grouped),
                "supportedClusters": len(grouped),
            })
        timeline = apply_single_host_speaker_fallback(
            timeline,
            reference_matches,
            processing,
            payload,
        )
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


def _sample_embedding_rows(embeddings, max_chunks):
    """Select deterministic quantiles so match confidence is independent of stream length."""
    import torch

    row_count = int(embeddings.shape[0])
    limit = max(1, int(max_chunks or 1))
    if row_count <= limit:
        return embeddings
    indices = [
        min(row_count - 1, int((rank + 0.5) * row_count / limit))
        for rank in range(limit)
    ]
    return embeddings[torch.tensor(indices, dtype=torch.long)]


def classify_speaker_clusters(
    cluster_embeddings,
    references,
    threshold,
    margin_threshold=0.0,
    constrain_to_references=False,
    max_sample_chunks=24,
    min_support_chunks=2,
    min_support_ratio=0.0,
):
    if not cluster_embeddings or not references:
        return {}

    import torch

    matches = {}
    for cluster_label, embeddings in cluster_embeddings.items():
        sampled = _sample_embedding_rows(embeddings, max_sample_chunks)
        labels = list(references)
        per_label_scores = []
        for label in labels:
            similarities = torch.matmul(sampled, references[label].T)
            per_label_scores.append(torch.max(similarities, dim=1).values)
        score_matrix = torch.stack(per_label_scores, dim=1)
        row_best_scores, row_best_indices = torch.max(score_matrix, dim=1)

        if len(labels) > 1:
            top_two = torch.topk(score_matrix, k=2, dim=1)
            row_second_scores = top_two.values[:, 1]
        else:
            row_second_scores = torch.full_like(row_best_scores, -1.0)

        candidates = []
        eligible_rows = row_best_scores >= float(threshold)
        for label_index, label in enumerate(labels):
            support_mask = eligible_rows & (row_best_indices == label_index)
            support_count = int(support_mask.sum().item())
            if support_count:
                winning_scores = row_best_scores[support_mask]
                winning_second_scores = row_second_scores[support_mask]
                score = float(winning_scores.max().item())
                support_mean_score = float(winning_scores.mean().item())
                if len(labels) > 1:
                    margin = float(
                        (winning_scores - winning_second_scores).mean().item()
                    )
                else:
                    margin = support_mean_score
            else:
                score = float(score_matrix[:, label_index].max().item())
                support_mean_score = -1.0
                margin = -1.0
            candidates.append({
                "label": label,
                "support_count": support_count,
                "score": score,
                "support_mean_score": support_mean_score,
                "margin": margin,
            })

        candidates.sort(
            key=lambda item: (
                item["support_count"],
                item["support_mean_score"],
                item["margin"],
                item["score"],
            ),
            reverse=True,
        )
        best = candidates[0]
        second = candidates[1] if len(candidates) > 1 else None
        best_label = best["label"]
        second_label = second["label"] if second else None
        best_score = best["score"]
        second_score = second["score"] if second else -1.0
        margin = best["margin"]
        required_support = max(1, int(min_support_chunks or 1))
        required_support_ratio = max(
            0.0,
            min(1.0, float(min_support_ratio or 0.0)),
        )
        support_ratio = (
            best["support_count"] / int(sampled.shape[0])
            if int(sampled.shape[0]) > 0
            else 0.0
        )
        is_confident = bool(
            best_label
            and best["support_count"] >= required_support
            and support_ratio >= required_support_ratio
            and best["support_mean_score"] >= threshold
            and margin >= margin_threshold
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
            "support_chunks": best["support_count"],
            "required_support_chunks": required_support,
            "required_support_ratio": required_support_ratio,
            "sampled_chunks": int(sampled.shape[0]),
            "support_mean_score": best["support_mean_score"],
            "support_ratio": support_ratio,
            "scoring_strategy": "bounded_repeated_chunk_votes",
            "reference_support": {
                candidate["label"]: {
                    "support_count": candidate["support_count"],
                    "support_mean_score": candidate["support_mean_score"],
                    "margin": candidate["margin"],
                    "score": candidate["score"],
                }
                for candidate in candidates
            },
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
