"""Classify already ASR-protected pause windows using a locally installed VAD; no downloads."""
import contextlib
import hashlib
import json
import os
from pathlib import Path
import sys


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    model_path = Path(request.get("modelPath") or Path.home() / ".cache/modelscope/hub/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch")
    if not model_path.is_dir() or not (model_path / "model.pt").is_file():
        raise RuntimeError("Local FSMN VAD is unavailable; precision selection stays conservative")
    os.environ["OMP_NUM_THREADS"] = "2"
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        from funasr import AutoModel
        torch.set_num_threads(2)
        model = AutoModel(model=str(model_path), device="cpu", disable_update=True, disable_pbar=True)
        results = []
        for entry in request["windows"]:
            raw = Path(entry["pcmPath"]).read_bytes()
            if hashlib.sha256(raw).hexdigest() != entry["pcmSha256"]:
                raise RuntimeError("PCM evidence changed before VAD")
            stereo = np.frombuffer(raw, dtype="<i2").reshape(-1, 2).astype(np.float32) / 32768.0
            detections = []
            for channel in range(2):
                output = model.generate(input=stereo[:, channel].copy(), disable_pbar=True)
                if not isinstance(output, list) or len(output) != 1 or not isinstance(output[0].get("value"), list):
                    raise RuntimeError("VAD did not return a complete classification")
                detections.append(output[0]["value"])
            results.append({"key": entry["key"], "pcmSha256": entry["pcmSha256"], "nonSpeech": not any(detections),
                            "speechIntervalsMs": detections, "modelPath": str(model_path), "modelMtimeMs": (model_path / "model.pt").stat().st_mtime_ns / 1e6})
    print(json.dumps({"version": 1, "results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
