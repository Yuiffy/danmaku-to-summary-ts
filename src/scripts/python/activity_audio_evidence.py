"""Independent, bounded multilingual evidence from original activity audio.

No source subtitles, correction rules, proposed titles or detector decisions enter
either decoder. SenseVoice tags are fallible observations, never singer identity.
"""
import hashlib
import json
import re
import sys
from pathlib import Path


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def windows(duration, seconds=8):
    if not 0 < duration <= 1200 or not 2 <= seconds <= 16:
        raise ValueError("invalid local activity audio budget")
    return [(start, min(duration, start + seconds))
            for start in range(0, int(duration) + 1, seconds) if start < duration]


def packet_windows(duration, seconds=8):
    """Partition an already budget-checked packet without enlarging decoder blocks."""
    windows(min(duration, 1200), seconds)
    block_seconds = (1200 // seconds) * seconds
    result = []
    for offset in range(0, int(duration) + 1, block_seconds):
        if offset < duration:
            result.extend((offset + start, offset + end)
                          for start, end in windows(min(duration - offset, block_seconds), seconds))
    return result


def language_hint(raw):
    match = re.search(r"<\|(zh|en|ja|ko|yue)\|>", raw)
    return match.group(1) if match else None


def analyze(payload):
    import numpy as np
    import soundfile as sf
    import librosa
    import torch
    from funasr import AutoModel
    from faster_whisper import WhisperModel
    from sensevoice_text import resolve_cached_model_name, clean_text

    settings = payload["settings"]
    device = settings.get("device", "cuda")
    torch.set_num_threads(4)
    rows, arrays = [], []
    for index, audio in enumerate(payload["audio"], 1):
        if digest(audio["path"]) != audio["sha256"]:
            raise ValueError("original activity audio changed")
        samples, rate = sf.read(audio["path"], dtype="float32")
        if samples.ndim != 1:
            raise ValueError("independent audio must be mono")
        duration = audio["end"] - audio["start"]
        if abs(len(samples) / rate - duration) > .25:
            raise ValueError("original activity audio duration changed")
        samples = librosa.resample(samples, orig_sr=rate, target_sr=16000).astype(np.float32)
        arrays.append(samples)
        rows.append({"index": index, "start": audio["start"], "end": audio["end"],
                     "sha256": audio["sha256"], "chunks": [], "transcript": []})
    model = AutoModel(model=resolve_cached_model_name(settings["sensevoiceModel"]),
                      device=device, disable_update=True, disable_pbar=True, disable_log=True)
    for row, samples in zip(rows, arrays):
        for index, (start, end) in enumerate(packet_windows(row["end"] - row["start"], settings["chunkSeconds"]), 1):
            raw = model.generate(input=samples[int(start * 16000):int(end * 16000)],
                                 language="auto", use_itn=False, disable_pbar=True)[0]["text"]
            row["chunks"].append({"index": index, "start": start, "end": end,
                                  "raw": raw, "text": clean_text(raw),
                                  "language": language_hint(raw), "tags": re.findall(r"<\|([^|]+)\|>", raw)})
    del model
    if device == "cuda":
        torch.cuda.empty_cache()
    model = WhisperModel(settings["whisperModel"], device=device,
                         compute_type="float16" if device == "cuda" else "int8", local_files_only=True)
    for row, samples in zip(rows, arrays):
        for chunk in row["chunks"]:
            # Small independent blocks avoid forcing English lyrics to Chinese,
            # or forcing the subsequent Chinese conversation to English.
            if "nospeech" in chunk["tags"]:
                continue
            start, end = chunk["start"], chunk["end"]
            language = chunk["language"] if chunk["language"] in ("en", "zh", "ja", "ko") else None
            segments, _ = model.transcribe(samples[int(start * 16000):int(end * 16000)],
                                           language=language, beam_size=3,
                                           condition_on_previous_text=False, word_timestamps=False)
            for segment in segments:
                if segment.text.strip() and segment.no_speech_prob < .6 and min(end, start + segment.end) > max(start, start + segment.start):
                    row["transcript"].append({"chunkIndex": chunk["index"],
                        "start": max(start, start + segment.start), "end": min(end, start + segment.end),
                        "text": segment.text.strip()})
    return {"version": 1, "method": "independent_local_asr", "source": payload["source"],
            "settings": settings, "audio": rows}


def main():
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8-sig"))
    if not payload.get("audio") or len(payload["audio"]) > 16:
        raise ValueError("local activity evidence requires a bounded audio packet")
    if sum(a["end"] - a["start"] for a in payload["audio"]) > payload["maxAudioSeconds"]:
        raise ValueError("local activity evidence exceeds the batch budget")
    output = Path(sys.argv[2])
    result = analyze(payload)
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("ACTIVITY_LOCAL_EVIDENCE: " + str(output), flush=True)


if __name__ == "__main__":
    main()
