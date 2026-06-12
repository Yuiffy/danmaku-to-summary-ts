"""
Full ASR re-run with speaker matching fix.
Uses paraformer built-in pipeline + separate CAM++ for speaker ID with iic/ prefix.
Outputs JSON to stdout (like the original script).
"""
import json
import os
import sys
import time
import contextlib
import subprocess
import tempfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "..", ".."))

def log(msg):
    print(f"[ASR-RERUN] {msg}", file=sys.stderr, flush=True)

def suppress():
    return contextlib.redirect_stdout(open(os.devnull, "w"))

def load_audio_16k_mono(path):
    import soundfile as sf
    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        import librosa
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
        sr = 16000
    return audio, sr

def main():
    import torch
    from funasr import AutoModel

    device = "cuda:0"
    
    # Config
    flv_path = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_04\录制-25788785-20260604-201111-833-高手小岁和臭栞栞玩五子棋_merged.flv"
    
    refs_config = [
        {"speaker": "岁己SUI", "audio_path": os.path.join(PROJECT_ROOT, "data", "asr_speaker_refs", "sui.wav"), "chunk_s": 8, "max_chunks": 20},
        {"speaker": "栞栞", "audio_path": os.path.join(PROJECT_ROOT, "data", "asr_speaker_refs", "shiori.wav"), "chunk_s": 8, "max_chunks": 20},
        {"speaker": "瑞娅", "audio_path": os.path.join(PROJECT_ROOT, "data", "asr_speaker_refs", "rhea.wav"), "chunk_s": 8, "max_chunks": 20},
    ]
    
    # Speaker matching thresholds - lowered from defaults
    SPEAKER_THRESHOLD = 0.35
    SPEAKER_MARGIN = 0.03
    
    # Step 1: Build reference centroids
    log("Loading CAM++ speaker model (with iic/ prefix)...")
    with suppress():
        spk_model = AutoModel(
            model="iic/speech_campplus_sv_zh-cn_16k-common",
            device=device,
            disable_update=True,
        )
    log("CAM++ model loaded.")
    
    centroids = {}
    for ref in refs_config:
        speaker = ref["speaker"]
        path = ref["audio_path"]
        if not os.path.exists(path):
            log(f"  WARNING: ref audio not found: {path}")
            continue
        log(f"Loading ref: {speaker} <- {path}")
        audio, sr = load_audio_16k_mono(path)
        
        chunk_len = int(ref.get("chunk_s", 8) * sr)
        max_chunks = int(ref.get("max_chunks", 20))
        chunks = []
        for i in range(0, len(audio), chunk_len):
            chunk = audio[i:i+chunk_len]
            if len(chunk) < sr:
                continue
            chunks.append(chunk)
            if len(chunks) >= max_chunks:
                break
        
        with suppress():
            results = spk_model.generate(input=chunks, cache={}, is_final=True)
        
        embeddings = [r["spk_embedding"] for r in results if r.get("spk_embedding") is not None and torch.isfinite(r["spk_embedding"]).all()]
        if embeddings:
            embs = torch.cat(embeddings, dim=0)
            embs = torch.nn.functional.normalize(embs, dim=1)
            centroids[speaker] = embs.to("cpu")
            log(f"  {speaker}: {len(embeddings)} embeddings OK")
    
    # Step 2: Load paraformer pipeline
    log("Loading paraformer pipeline...")
    
    # Resolve model names with iic/ prefix
    def resolve_model(name):
        cache_dir = os.path.join(os.path.expanduser("~"), ".cache", "modelscope", "hub", "models", "iic")
        aliases = {
            "paraformer-zh": "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
            "fsmn-vad": "speech_fsmn_vad_zh-cn-16k-common-pytorch",
            "ct-punc": "punc_ct-transformer_cn-en-common-vocab471067-large",
        }
        if name in aliases:
            candidate = os.path.join(cache_dir, aliases[name])
            if os.path.exists(candidate):
                return candidate
        return name
    
    model_kwargs = {
        "model": resolve_model("paraformer-zh"),
        "device": device,
        "disable_update": True,
        "vad_model": resolve_model("fsmn-vad"),
        "vad_kwargs": {"max_single_segment_time": 60000},
        "punc_model": resolve_model("ct-punc"),
        "spk_model": "iic/speech_campplus_sv_zh-cn_16k-common",
        "spk_kwargs": {"cb_kwargs": {"merge_thr": 0.78}},
    }
    
    with suppress():
        model = AutoModel(**model_kwargs)
    log("paraformer pipeline loaded.")
    
    # Step 2.5: Extract audio from FLV to WAV (soundfile can't read FLV)
    tmp_wav = os.path.join(tempfile.gettempdir(), "asr_rerun_audio.wav")
    if not os.path.exists(tmp_wav) or os.path.getsize(tmp_wav) < 1000000:
        log(f"Extracting audio from FLV to {tmp_wav}...")
        cmd = [
            "ffmpeg", "-y", "-i", flv_path,
            "-vn", "-ac", "1", "-ar", "16000",
            "-f", "wav", tmp_wav, "-nostdin", "-loglevel", "error"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            log(f"ffmpeg failed: {result.stderr[:500]}")
            sys.exit(1)
        log(f"Audio extracted: {os.path.getsize(tmp_wav)/1e9:.2f} GB")
    else:
        log(f"Reusing existing WAV: {tmp_wav}")
    audio_path_for_asr = tmp_wav

    # Step 3: Run transcription
    log("Starting transcription (this will take a while for 3.5h audio)...")
    t0 = time.time()
    with suppress():
        results = model.generate(
            input=audio_path_for_asr,
            batch_size_s=300,
            batch_size_threshold_s=60,
        )
    elapsed = time.time() - t0
    log(f"Transcription complete in {elapsed:.0f}s")
    
    if not results or not isinstance(results, list):
        log("ERROR: No results from transcription")
        sys.exit(1)
    
    r = results[0]
    sentence_info = r.get("sentence_info", [])
    log(f"sentence_info: {len(sentence_info)} sentences")
    
    if not sentence_info:
        log("ERROR: No sentence_info in results")
        sys.exit(1)
    
    # Step 4: Check if spk_embedding is available
    has_spk_emb = any(s.get("spk_embedding") is not None for s in sentence_info[:20])
    log(f"spk_embedding in sentence_info: {has_spk_emb}")
    
    # Step 5: If no spk_embedding, re-extract using spk_model
    if not has_spk_emb:
        log("Re-extracting speaker embeddings per sentence...")
        audio_data, sr = load_audio_16k_mono(audio_path_for_asr)
        log(f"Audio loaded: {len(audio_data)/sr:.1f}s")
        
        extracted = 0
        for i, sent in enumerate(sentence_info):
            start_ms = float(sent.get("start", 0))
            end_ms = float(sent.get("end", start_ms + 1000))
            start_idx = max(0, int(start_ms / 1000.0 * sr))
            end_idx = min(len(audio_data), int(end_ms / 1000.0 * sr))
            if end_idx - start_idx < sr:
                continue
            chunk = audio_data[start_idx:end_idx]
            with suppress():
                emb_results = spk_model.generate(input=[chunk], cache={}, is_final=True)
            if emb_results and emb_results[0].get("spk_embedding") is not None:
                sent["spk_embedding"] = emb_results[0]["spk_embedding"]
                extracted += 1
            if (i + 1) % 500 == 0:
                log(f"  Re-extraction progress: {i+1}/{len(sentence_info)} ({extracted} extracted)")
        log(f"Re-extraction complete: {extracted}/{len(sentence_info)} have embeddings")
        del audio_data  # Free memory
    
    # Step 6: Match speakers against reference centroids
    log("Matching speakers against reference centroids...")
    threshold = SPEAKER_THRESHOLD
    margin_threshold = SPEAKER_MARGIN
    
    matched_count = 0
    unknown_count = 0
    speaker_stats = {}
    
    segments = []
    for sent in sentence_info:
        text = sent.get("text", "").strip()
        if not text:
            continue
        
        start_ms = float(sent.get("start", 0))
        end_ms = float(sent.get("end", 0))
        start_s = round(start_ms / 1000.0, 3)
        end_s = round(max(end_ms, start_ms + 100) / 1000.0, 3)
        
        spk = sent.get("spk")
        speaker_label = None
        speaker_score = None
        
        if spk is not None:
            spk_emb = sent.get("spk_embedding")
            if spk_emb is not None and torch.is_tensor(spk_emb) and centroids:
                emb = torch.nn.functional.normalize(spk_emb.to("cpu"), dim=1)
                best_label = None
                best_score = -1.0
                scores_by_speaker = {}
                for label, centroid in centroids.items():
                    score = float(torch.matmul(emb, centroid.T).max().item())
                    scores_by_speaker[label] = score
                    if score > best_score:
                        best_label = label
                        best_score = score
                
                sorted_scores = sorted(scores_by_speaker.values(), reverse=True)
                margin = sorted_scores[0] - sorted_scores[1] if len(sorted_scores) > 1 else best_score
                
                if best_score >= threshold and margin >= margin_threshold:
                    speaker_label = best_label
                    speaker_score = round(best_score, 4)
                    matched_count += 1
                else:
                    speaker_label = f"SPEAKER_{int(spk):02d}"
                    speaker_score = round(best_score, 4)
                    unknown_count += 1
            else:
                speaker_label = f"SPEAKER_{int(spk):02d}"
                unknown_count += 1
        
        speaker_stats[speaker_label] = speaker_stats.get(speaker_label, 0) + 1
        
        segments.append({
            "start": start_s,
            "end": end_s,
            "text": text,
            "time_unit": "seconds",
            "speaker": speaker_label,
            "speaker_score": speaker_score,
        })
    
    log(f"Speaker matching: matched={matched_count}, unknown={unknown_count}")
    log(f"Speaker distribution: {json.dumps(speaker_stats, ensure_ascii=False)}")
    
    # Step 7: Apply smoothing - fill UNKNOWN gaps between same-speaker segments
    log("Applying speaker smoothing...")
    fill_gap_s = 10.0
    max_unknown_duration_s = 12.0
    
    items = sorted(segments, key=lambda s: s["start"])
    for i, item in enumerate(items):
        if item.get("speaker", "").startswith("SPEAKER_"):
            # Check neighbors
            prev_item = None
            for left in range(i - 1, -1, -1):
                if items[left].get("speaker") and not items[left]["speaker"].startswith("SPEAKER_"):
                    prev_item = items[left]
                    break
            next_item = None
            for right in range(i + 1, len(items)):
                if items[right].get("speaker") and not items[right]["speaker"].startswith("SPEAKER_"):
                    next_item = items[right]
                    break
            
            if prev_item and next_item and prev_item["speaker"] == next_item["speaker"]:
                start = item["start"]
                end = item["end"]
                duration = end - start
                left_gap = start - prev_item["end"]
                right_gap = next_item["start"] - end
                if duration <= max_unknown_duration_s and left_gap <= fill_gap_s and right_gap <= fill_gap_s:
                    item["speaker"] = prev_item["speaker"]
                    item["speaker_score"] = max(item.get("speaker_score") or 0, prev_item.get("speaker_score") or 0)
    
    # Recount
    final_stats = {}
    for s in segments:
        final_stats[s["speaker"]] = final_stats.get(s["speaker"], 0) + 1
    log(f"After smoothing: {json.dumps(final_stats, ensure_ascii=False)}")
    
    # Step 8: Output to file directly (avoid PowerShell encoding issues)
    output = {
        "backend": "paraformer",
        "language": "auto",
        "segments": segments,
    }
    
    output_path = os.path.join(os.path.dirname(flv_path), "rerun_asr_output.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, default=str)
    log(f"Output written to {output_path} ({os.path.getsize(output_path)/1e6:.1f} MB)")
    log("Done!")

if __name__ == "__main__":
    main()
