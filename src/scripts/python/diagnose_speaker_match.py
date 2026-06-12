"""
Diagnostic script: Test speaker reference matching against existing ASR results.
Loads reference audio, extracts embeddings, and prints similarity scores.
"""
import json
import os
import sys
import time

# Add project root to path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, "..", "..", ".."))

def log(msg):
    print(f"[DIAG] {msg}", file=sys.stderr, flush=True)

def main():
    import torch
    import soundfile as sf
    import numpy as np
    from funasr import AutoModel

    device = "cuda:0"
    
    # Step 1: Load reference audio and build centroids
    refs_config = [
        {"speaker": "岁己SUI", "audio_path": os.path.join(PROJECT_ROOT, "data", "asr_speaker_refs", "sui.wav")},
        {"speaker": "栞栞", "audio_path": os.path.join(PROJECT_ROOT, "data", "asr_speaker_refs", "shiori.wav")},
        {"speaker": "瑞娅", "audio_path": os.path.join(PROJECT_ROOT, "data", "asr_speaker_refs", "rhea.wav")},
    ]
    
    log("Loading CAM++ speaker model...")
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
        log(f"Loading ref audio: {speaker} <- {path}")
        audio, sr = sf.read(path, dtype="float32", always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != 16000:
            import librosa
            audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
            sr = 16000
        
        # Split into 8s chunks
        chunk_len = 8 * sr
        chunks = []
        for i in range(0, len(audio), chunk_len):
            chunk = audio[i:i+chunk_len]
            if len(chunk) < sr:
                continue
            chunks.append(chunk)
            if len(chunks) >= 20:
                break
        
        log(f"  {speaker}: {len(chunks)} chunks from {len(audio)/sr:.1f}s audio")
        
        with torch.no_grad():
            results = spk_model.generate(input=chunks, cache={}, is_final=True)
        
        embeddings = []
        for r in results:
            emb = r.get("spk_embedding")
            if emb is not None and torch.isfinite(emb).all():
                embeddings.append(emb)
        
        if embeddings:
            embs = torch.cat(embeddings, dim=0)
            embs = torch.nn.functional.normalize(embs, dim=1)
            centroids[speaker] = embs.to("cpu")
            log(f"  {speaker}: {len(embeddings)} embeddings, shape={embs.shape}")
        else:
            log(f"  {speaker}: NO valid embeddings!")
    
    # Step 2: Cross-reference: compute pairwise similarities between centroids
    log("\n=== Cross-reference similarity matrix ===")
    speakers = list(centroids.keys())
    for i, s1 in enumerate(speakers):
        for j, s2 in enumerate(speakers):
            if i >= j:
                continue
            # Max cosine similarity between any chunk pair
            scores = torch.matmul(centroids[s1], centroids[s2].T)
            max_score = scores.max().item()
            mean_score = scores.mean().item()
            log(f"  {s1} vs {s2}: max={max_score:.4f}, mean={mean_score:.4f}")
    
    # Step 3: Test with some actual audio from the flv
    # Extract a few sample segments using ffmpeg
    import subprocess
    import tempfile
    
    flv_path = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_04\录制-25788785-20260604-201111-833-高手小岁和臭栞栞玩五子棋_merged.flv"
    
    # Extract segments at known timestamps (from the highlight file)
    # [1m] Should be 岁己 talking (opening)
    # [40m] Game selection discussion - both speakers
    # [74m] 扫雷 section - 岁己 learning
    test_segments = [
        {"label": "01:00", "start": 60, "duration": 10},
        {"label": "01:30", "start": 90, "duration": 10},
        {"label": "05:00", "start": 300, "duration": 10},
        {"label": "40:00", "start": 2400, "duration": 10},
        {"label": "74:00", "start": 4440, "duration": 10},
        {"label": "75:00", "start": 4500, "duration": 10},
        {"label": "95:00", "start": 5700, "duration": 10},
        {"label": "126:00", "start": 7560, "duration": 10},
    ]
    
    log(f"\n=== Testing segments from FLV ===")
    tmpdir = tempfile.mkdtemp(prefix="asr_diag_")
    
    for seg in test_segments:
        tmp_wav = os.path.join(tmpdir, f"seg_{seg['label'].replace(':','')}.wav")
        cmd = [
            "ffmpeg", "-y", "-ss", str(seg["start"]), "-t", str(seg["duration"]),
            "-i", flv_path, "-vn", "-ac", "1", "-ar", "16000",
            "-f", "wav", tmp_wav, "-nostdin", "-loglevel", "error"
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0 or not os.path.exists(tmp_wav):
            log(f"  {seg['label']}: ffmpeg failed: {result.stderr[:200]}")
            continue
        
        audio, sr = sf.read(tmp_wav, dtype="float32", always_2d=False)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        
        chunk_len = 8 * sr
        chunks = []
        for i in range(0, len(audio), chunk_len):
            chunk = audio[i:i+chunk_len]
            if len(chunk) < sr:
                continue
            chunks.append(chunk)
        
        if not chunks:
            log(f"  {seg['label']}: no valid chunks")
            continue
        
        with torch.no_grad():
            results = spk_model.generate(input=chunks, cache={}, is_final=True)
        
        log(f"\n  Segment @{seg['label']} ({len(chunks)} chunks):")
        for ci, r in enumerate(results):
            emb = r.get("spk_embedding")
            if emb is None or not torch.isfinite(emb).all():
                log(f"    chunk {ci}: invalid embedding")
                continue
            emb = torch.nn.functional.normalize(emb.to("cpu"), dim=1)
            scores = {}
            for speaker, centroid in centroids.items():
                score = float(torch.matmul(emb, centroid.T).max().item())
                scores[speaker] = score
            
            best_speaker = max(scores, key=scores.get)
            best_score = scores[best_speaker]
            sorted_scores = sorted(scores.values(), reverse=True)
            margin = sorted_scores[0] - sorted_scores[1] if len(sorted_scores) > 1 else best_score
            
            # Check threshold matching at different levels
            for threshold in [0.45, 0.35, 0.30, 0.25]:
                for margin_thresh in [0.06, 0.03, 0.0]:
                    matched = best_score >= threshold and margin >= margin_thresh
                    if matched:
                        log(f"    chunk {ci}: BEST={best_speaker}({best_score:.4f}) margin={margin:.4f} -> MATCH@t={threshold},m={margin_thresh}")
                        break
                else:
                    continue
                break
            else:
                log(f"    chunk {ci}: BEST={best_speaker}({best_score:.4f}) margin={margin:.4f} -> NO MATCH (all={', '.join(f'{k}={v:.4f}' for k,v in sorted(scores.items()))})")
    
    # Cleanup
    import shutil
    shutil.rmtree(tmpdir, ignore_errors=True)
    log("\nDiagnostic complete.")

if __name__ == "__main__":
    main()
