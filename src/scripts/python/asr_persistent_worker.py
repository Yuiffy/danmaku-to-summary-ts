import argparse
import gc
import json
import os
import socket
import sys
import traceback

from sensevoice_transcribe import (
    GpuThrottle,
    _apply_hotword_correction,
    coerce_bool,
    normalize_backend_name,
    transcribe_paraformer_builtin,
)


MAX_REQUEST_BYTES = 16 * 1024 * 1024


def send_json(connection, payload):
    data = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8") + b"\n"
    connection.sendall(data)


def receive_json(connection):
    chunks = []
    total = 0
    while True:
        chunk = connection.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > MAX_REQUEST_BYTES:
            raise ValueError("请求超过 16MB 限制")
        if b"\n" in chunk:
            break
    raw = b"".join(chunks).split(b"\n", 1)[0]
    if not raw:
        raise ValueError("空请求")
    return json.loads(raw.decode("utf-8"))


def release_cache(runtime_cache):
    runtime_cache.clear()
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass


def transcribe(payload, runtime_cache):
    audio_path = payload.get("audio_path")
    if not audio_path or not os.path.exists(audio_path):
        raise FileNotFoundError(audio_path or "未提供 audio_path")

    backend_name = normalize_backend_name(payload.get("backend") or "paraformer")
    if backend_name != "paraformer":
        raise ValueError(f"常驻 worker 仅支持 paraformer，收到: {backend_name}")

    device = payload.get("device", "cuda")
    if device == "cuda":
        import torch
        if not torch.cuda.is_available():
            raise RuntimeError("配置 device=cuda，但 torch.cuda.is_available() 为 False")

    throttle = GpuThrottle(payload, device)
    raw_result = transcribe_paraformer_builtin(
        payload,
        audio_path,
        device,
        throttle,
        runtime_cache=runtime_cache,
    )
    output = {
        "backend": backend_name,
        "language": payload.get("language", "auto"),
        "segments": raw_result,
        "timings": payload.get("_timings", {}),
        "speaker_processing": payload.get("_speaker_processing"),
        "emotion_analysis": payload.get("_emotion_analysis"),
    }
    hotword_config = payload.get("phoneme_correction")
    if isinstance(hotword_config, dict) and coerce_bool(hotword_config.get("enabled"), False):
        _apply_hotword_correction(output, payload)
    return output


def main():
    parser = argparse.ArgumentParser(description="Persistent Paraformer worker")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", required=True)
    args = parser.parse_args()

    runtime_cache = {}
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", args.port))
    server.listen(4)
    port = server.getsockname()[1]
    print(
        "[ASR_WORKER_READY] " + json.dumps({"port": port, "pid": os.getpid()}),
        flush=True,
    )

    running = True
    while running:
        connection, _address = server.accept()
        with connection:
            try:
                request = receive_json(connection)
                if request.get("token") != args.token:
                    send_json(connection, {"ok": False, "error": "unauthorized"})
                    continue
                request_type = request.get("type")
                if request_type == "health":
                    send_json(connection, {
                        "ok": True,
                        "pid": os.getpid(),
                        "model_loaded": bool(runtime_cache.get("paraformer")),
                        "emotion_model_loaded": bool(runtime_cache.get("emotion_model")),
                    })
                elif request_type == "shutdown":
                    release_cache(runtime_cache)
                    send_json(connection, {"ok": True, "released": True})
                    running = False
                elif request_type == "transcribe":
                    result = transcribe(request.get("payload") or {}, runtime_cache)
                    send_json(connection, {"ok": True, "result": result})
                else:
                    send_json(connection, {"ok": False, "error": f"未知请求类型: {request_type}"})
            except Exception as exc:
                send_json(connection, {
                    "ok": False,
                    "error": str(exc),
                    "detail": traceback.format_exc(),
                })

    server.close()
    release_cache(runtime_cache)


if __name__ == "__main__":
    main()
