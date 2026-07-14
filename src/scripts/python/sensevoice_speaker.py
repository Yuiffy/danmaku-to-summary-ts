import os
import sys

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


def build_speaker_reference_centroids(spk_model_obj, references, device):
    if not isinstance(references, list) or not references:
        return None

    import torch

    embeddings_by_speaker = {}
    max_chunks = 24
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
        max_chunks = int(ref.get("max_chunks", max_chunks) or max_chunks)
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
        with suppress_model_output():
            results = spk_model_obj.generate(input=chunks, cache={}, is_final=True)
        valid_embeddings = [
            result["spk_embedding"]
            for result in results
            if result.get("spk_embedding") is not None and torch.isfinite(result["spk_embedding"]).all()
        ]
        if not valid_embeddings:
            continue
        embeddings_by_speaker.setdefault(speaker, []).extend(valid_embeddings)
        log_progress(f"参考说话人完成: speaker={speaker}, chunks={len(chunks)}")

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
        best_score = -1.0
        second_score = -1.0
        for label, centroid in ref_items:
            score = float(torch.matmul(embedding, centroid.T).max().item())
            if score > best_score:
                second_score = best_score
                best_label = label
                best_score = score
            elif score > second_score:
                second_score = score
        margin = best_score - second_score if second_score > -1.0 else best_score
        is_confident = best_score >= threshold and margin >= margin_threshold
        labels.append({
            "label": best_label if is_confident else "UNKNOWN",
            "score": best_score,
            "best_label": best_label,
            "margin": margin,
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
        with suppress_model_output():
            results = spk_model_obj.generate(input=chunks, cache={}, is_final=True)
        valid_embeddings = [
            result["spk_embedding"]
            for result in results
            if result.get("spk_embedding") is not None and torch.isfinite(result["spk_embedding"]).all()
        ]
        if not valid_embeddings:
            continue
        embeddings = torch.cat(valid_embeddings, dim=0)
        embeddings = torch.nn.functional.normalize(embeddings, dim=1)
        cluster_embeddings[cluster_label] = embeddings.to("cpu")
        log_progress(f"  簇 embedding 完成: cluster={cluster_label}, chunks={len(chunks)}")

    return cluster_embeddings


def classify_speaker_clusters(cluster_embeddings, references, threshold, margin_threshold=0.0, constrain_to_references=False):
    if not cluster_embeddings or not references:
        return {}

    import torch

    matches = {}
    for cluster_label, embeddings in cluster_embeddings.items():
        best_label = None
        best_score = -1.0
        second_score = -1.0
        for label, centroid in references.items():
            score = float(torch.matmul(embeddings, centroid.T).max().item())
            if score > best_score:
                second_score = best_score
                best_label = label
                best_score = score
            elif score > second_score:
                second_score = score
        margin = best_score - second_score if second_score > -1.0 else best_score
        if best_label and best_score >= threshold and margin >= margin_threshold:
            matches[cluster_label] = {
                "label": best_label,
                "score": best_score,
                "margin": margin,
            }
        else:
            matches[cluster_label] = {
                "label": "UNKNOWN" if constrain_to_references else cluster_label,
                "score": best_score,
                "margin": margin,
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
