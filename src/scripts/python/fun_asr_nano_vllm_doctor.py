import importlib
import importlib.util
import json
import os
import platform
import sys
from pathlib import Path


MODEL_ALIASES = {
    "FunAudioLLM/Fun-ASR-Nano-2512": [
        Path.home() / ".cache" / "modelscope" / "hub" / "models" / "FunAudioLLM" / "Fun-ASR-Nano-2512",
        Path.home() / ".cache" / "modelscope" / "hub" / "models" / "fun-audio-llm" / "Fun-ASR-Nano-2512",
    ],
    "fsmn-vad": [
        Path.home() / ".cache" / "modelscope" / "hub" / "models" / "iic" / "speech_fsmn_vad_zh-cn-16k-common-pytorch",
    ],
    "cam++": [
        Path.home() / ".cache" / "modelscope" / "hub" / "models" / "iic" / "speech_campplus_sv_zh-cn_16k-common",
    ],
}


def check_module(name, import_name=None, required=True):
    module_name = import_name or name
    result = {
        "name": name,
        "module": module_name,
        "ok": importlib.util.find_spec(module_name) is not None,
        "required": required,
    }
    if result["ok"]:
        try:
            module = importlib.import_module(module_name)
            result["version"] = getattr(module, "__version__", None)
            result["file"] = getattr(module, "__file__", None)
        except Exception as exc:
            result["ok"] = False
            result["error"] = f"import failed: {exc}"
    else:
        result["error"] = "not installed"
    return result


def check_torch_cuda():
    result = check_module("torch")
    if not result["ok"]:
        return result
    try:
        import torch
        result["cuda_available"] = bool(torch.cuda.is_available())
        result["torch_cuda"] = getattr(torch.version, "cuda", None)
        if torch.cuda.is_available():
            result["device_count"] = torch.cuda.device_count()
            result["device_name"] = torch.cuda.get_device_name(0)
            result["capability"] = ".".join(map(str, torch.cuda.get_device_capability(0)))
            result["arch_list"] = torch.cuda.get_arch_list()
        else:
            result["ok"] = False
            result["error"] = "torch.cuda.is_available() is False"
    except Exception as exc:
        result["ok"] = False
        result["error"] = str(exc)
    return result


def check_model_cache(model_name):
    candidates = MODEL_ALIASES.get(model_name, [])
    existing = [str(path) for path in candidates if path.exists()]
    return {
        "name": model_name,
        "ok": bool(existing),
        "existing": existing,
        "candidates": [str(path) for path in candidates],
        "required": model_name == "FunAudioLLM/Fun-ASR-Nano-2512",
    }


def check_funasr_vllm_symbols():
    checks = []
    checks.append(check_module("funasr"))
    checks.append(check_module("AutoModelVLLM module", "funasr.auto.auto_model_vllm"))
    checks.append(check_module(
        "FunASRNanoVLLMPipeline",
        "funasr.models.fun_asr_nano.inference_vllm_pipeline",
    ))
    return checks


def build_report():
    report = {
        "python": {
            "executable": sys.executable,
            "version": sys.version.replace("\n", " "),
            "platform": platform.platform(),
            "is_windows": os.name == "nt",
        },
        "checks": [],
        "model_cache": [],
        "warnings": [],
        "errors": [],
        "recommendations": [],
    }

    report["checks"].append(check_torch_cuda())
    report["checks"].append(check_module("modelscope"))
    report["checks"].append(check_module("vllm"))
    report["checks"].extend(check_funasr_vllm_symbols())

    for model_name in ("FunAudioLLM/Fun-ASR-Nano-2512", "fsmn-vad", "cam++"):
        report["model_cache"].append(check_model_cache(model_name))

    if report["python"]["is_windows"]:
        report["warnings"].append(
            "当前是 Windows Python 环境；vLLM 官方主要面向 Linux/CUDA，pip 可能需要源码构建。"
        )
        report["recommendations"].append(
            "建议把 fun_asr_nano_vllm.python_executable 指向 WSL/Linux/独立 CUDA 环境中的 Python，并配置 python_path_map。"
        )

    for item in report["checks"]:
        if item.get("required", True) and not item.get("ok"):
            report["errors"].append(f"{item['name']}: {item.get('error', 'failed')}")
            if item["name"] == "vllm":
                report["recommendations"].append(
                    "当前 Python 无法 import vllm；vLLM 官方不原生支持 Windows，优先使用 WSL/Ubuntu 或 Linux CUDA 环境安装。"
                )
    for item in report["model_cache"]:
        if item.get("required") and not item.get("ok"):
            report["warnings"].append(
                f"未发现本地模型缓存 {item['name']}；首次运行会下载或解析模型，启动会更慢。"
            )

    report["ok"] = len(report["errors"]) == 0
    return report


def print_text(report):
    status = "OK" if report["ok"] else "NOT READY"
    print(f"Fun-ASR-Nano vLLM doctor: {status}")
    print(f"Python: {report['python']['executable']}")
    print(f"Platform: {report['python']['platform']}")
    print("")
    print("Checks:")
    for item in report["checks"]:
        marker = "OK" if item.get("ok") else "FAIL"
        detail = item.get("version") or item.get("error") or item.get("file") or ""
        print(f"  [{marker}] {item['name']} {detail}")
        if item["name"] == "torch" and item.get("cuda_available"):
            print(f"       cuda={item.get('torch_cuda')}, gpu={item.get('device_name')}, capability={item.get('capability')}")
    print("")
    print("Model cache:")
    for item in report["model_cache"]:
        marker = "OK" if item.get("ok") else "MISS"
        location = item["existing"][0] if item.get("existing") else item["candidates"][0]
        print(f"  [{marker}] {item['name']} -> {location}")
    if report["warnings"]:
        print("")
        print("Warnings:")
        for warning in report["warnings"]:
            print(f"  - {warning}")
    if report["recommendations"]:
        print("")
        print("Recommendations:")
        for recommendation in report["recommendations"]:
            print(f"  - {recommendation}")
    if report["errors"]:
        print("")
        print("Errors:")
        for error in report["errors"]:
            print(f"  - {error}")


def main():
    json_output = "--json" in sys.argv
    report = build_report()
    if json_output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print_text(report)
    raise SystemExit(0 if report["ok"] else 1)


if __name__ == "__main__":
    main()
