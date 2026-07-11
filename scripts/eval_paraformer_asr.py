"""Run baseline or tuned Paraformer inference on one audio/video file."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from funasr import AutoModel


def normalize_segments(result):
    if isinstance(result, list) and result:
        result = result[0]
    sentences = result.get("sentence_info") or []
    if sentences:
        normalized = []
        for item in sentences:
            start = item.get("start", 0)
            end = item.get("end", start)
            text = (item.get("text") or "").strip()
            if not text:
                continue
            normalized.append({
                "start_ms": start,
                "end_ms": end,
                "text": text,
            })
        return normalized
    text = (result.get("text") or "").strip()
    return [{"start_ms": 0, "end_ms": 0, "text": text}] if text else []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="paraformer-zh")
    parser.add_argument("--model-dir")
    parser.add_argument("--punc-model", default="ct-punc")
    parser.add_argument("--vad-model", default="fsmn-vad")
    parser.add_argument("--disable-punc", action="store_true")
    parser.add_argument("--disable-vad", action="store_true")
    args = parser.parse_args()

    model_kwargs = {
        "model": args.model_dir or args.model,
        "device": "cuda:0",
    }
    if not args.disable_punc:
        model_kwargs["punc_model"] = args.punc_model
    if not args.disable_vad:
        model_kwargs["vad_model"] = args.vad_model

    model = AutoModel(**model_kwargs)
    result = model.generate(input=args.audio, batch_size_s=30)
    segments = normalize_segments(result)

    payload = {
        "audio": str(Path(args.audio)),
        "model": args.model_dir or args.model,
        "segments": segments,
        "full_text": "".join(seg["text"] for seg in segments),
    }
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
