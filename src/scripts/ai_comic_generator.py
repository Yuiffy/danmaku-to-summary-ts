#!/usr/bin/env python3
"""
AI漫画生成模块
使用Google图像生成API生成直播总结漫画
支持Google Imagen等图像生成模型
"""

import os
import sys
import io
import re

# 禁用输出缓冲，确保日志实时输出到Node.js
# 保存原始的stdout/stderr，以便在包装失败时使用
_original_stdout = sys.stdout
_original_stderr = sys.stderr

# 创建安全的打印函数，确保日志能够输出
def safe_print(*args, **kwargs):
    """安全的打印函数，尝试多种方式输出日志"""
    message = ' '.join(str(arg) for arg in args)
    
    # 尝试1: 使用原始stdout
    try:
        if not _original_stdout.closed:
            _original_stdout.write(message + '\n')
            _original_stdout.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试2: 使用内置print
    try:
        __builtins__.print(*args, **kwargs)
        return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试3: 直接写入sys.stdout
    try:
        if hasattr(sys.stdout, 'write') and not sys.stdout.closed:
            sys.stdout.write(message + '\n')
            sys.stdout.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass
    
    # 尝试4: 写入stderr作为最后手段
    try:
        if hasattr(sys.stderr, 'write') and not sys.stderr.closed:
            sys.stderr.write(message + '\n')
            sys.stderr.flush()
            return
    except (ValueError, OSError, AttributeError):
        pass

# 创建安全的traceback打印函数
def safe_print_exc():
    """安全的traceback打印函数"""
    import traceback as tb
    try:
        tb.print_exc(file=_original_stderr)
    except (ValueError, OSError, AttributeError):
        # 尝试使用原始stderr
        try:
            _original_stderr.write(str(tb.format_exc()) + '\n')
            _original_stderr.flush()
        except:
            pass

# 全局替换内置print函数
print = safe_print

import json
import time
import base64
import hashlib
import requests
import importlib.util
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
import traceback as tb
import subprocess
import shutil

COMIC_SCRIPT_POLICY_VERSION = 4

LAST_COMIC_SCRIPT_META = {
    "provider": None,
    "model": None,
    "fallback": False,
    "status": "not_started",
    "reason": None,
}


def reset_comic_script_meta():
    LAST_COMIC_SCRIPT_META.clear()
    LAST_COMIC_SCRIPT_META.update({
        "provider": None,
        "model": None,
        "fallback": False,
        "status": "not_started",
        "reason": None,
    })

def set_comic_script_meta(provider=None, model=None, fallback=False, status="unknown", reason=None):
    LAST_COMIC_SCRIPT_META.update({
        "provider": provider,
        "model": model,
        "fallback": bool(fallback),
        "status": status,
        "reason": reason,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    })

def get_comic_script_meta():
    return dict(LAST_COMIC_SCRIPT_META)

# 导入统一配置加载器
from config_loader import (
    get_config,
    is_gemini_configured,
    get_gemini_api_key,
    get_room_names,
    get_project_root
)

# 导入tuZi API封装
from tuzi_chat_completions import (
    call_daiyu_chat_completions,
    call_tuzi_chat_completions,
    call_tuzi_chat_completions_for_image,
    call_tuzi_images_generations,
    annotate_last_image_generation_meta,
    get_last_image_generation_meta,
    reset_last_image_generation_meta,
)

# 尝试导入 Google GenAI（可选依赖）
try:
    from google import genai
    from google.genai import types as genai_types
    HAS_GOOGLE_GENAI = True
except ImportError:
    genai = None
    genai_types = None
    HAS_GOOGLE_GENAI = False
    print("[WARNING] google-genai 库未安装，Gemini 文本生成功能将不可用")
    print("   安装方法: pip install google-genai")

def load_config() -> Dict[str, Any]:
    """加载配置文件（使用统一配置加载器）"""
    config = get_config()
    
    # 为了向后兼容，构建 aiServices 结构
    # 注意：aiServices.gemini 来自 ai.text.gemini（文本生成）
    #       aiServices.tuZi 来自 ai.comic.tuZi（图像生成）
    #       aiServices.googleImage 来自 ai.comic.googleImage（图像生成）
    legacy_config = {
        "aiServices": {
            "gemini": config.get('ai', {}).get('text', {}).get('gemini', {}),
            "tuZi": config.get('ai', {}).get('comic', {}).get('tuZi', {}),
            "googleImage": config.get('ai', {}).get('comic', {}).get('googleImage', {}),
            "defaultReferenceImage": config.get('ai', {}).get('defaultReferenceImage', ''),
            "defaultCharacterDescription": config.get('ai', {}).get('defaultCharacterDescription', ''),
            "defaultNames": config.get('ai', {}).get('defaultNames', {})
        },
        "ai": config.get('ai', {}),
        "asr": config.get('asr', {}),
        "roomSettings": config.get('ai', {}).get('roomSettings', {}),
        "timeouts": config.get('timeouts', {})
    }
    
    return legacy_config

def is_huggingface_configured() -> bool:
    """检查Hugging Face配置是否有效（已禁用）"""
    return False

def is_googleimage_configured() -> bool:
    """检查Google图像生成配置是否有效（已禁用）"""
    return False

def _get_nested_provider_options(provider_config: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize provider shapes like {options:{...}} or {openai:{options:{...}}}."""
    if not isinstance(provider_config, dict):
        return {}

    candidate = provider_config
    if isinstance(candidate.get("openai"), dict):
        candidate = candidate.get("openai", {})

    options = candidate.get("options") if isinstance(candidate.get("options"), dict) else {}
    merged = dict(candidate)
    merged.update(options)
    return merged

def _resolve_image_provider_config(config: Dict[str, Any], provider_name: str) -> Dict[str, Any]:
    providers = config.get("ai", {}).get("providers", {}) or {}
    raw_provider = providers.get(provider_name) or providers.get(str(provider_name).lower()) or {}

    legacy_tuzi = {}
    if str(provider_name).lower() in ("tuzi", "tu-zi", "tu_zi"):
        legacy_tuzi = dict(config.get("aiServices", {}).get("tuZi", {}) or {})

    provider_options = _get_nested_provider_options(raw_provider)
    merged = dict(legacy_tuzi)
    merged.update({k: v for k, v in provider_options.items() if v is not None and v != ""})

    base_url = (
        merged.get("baseUrl")
        or merged.get("baseURL")
        or merged.get("url")
        or merged.get("endpoint")
        or ""
    )
    api_key = merged.get("apiKey") or merged.get("key") or ""
    provider_type = merged.get("type") or merged.get("provider") or "openai"

    return {
        "name": provider_name,
        "displayName": merged.get("displayName") or provider_name,
        "type": provider_type,
        "baseUrl": base_url,
        "apiKey": api_key,
        "proxy": merged.get("proxy") or "",
    }

def _int_config(value: Any, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(value))
    except (TypeError, ValueError):
        return default

def _route_timeout_seconds(route: Dict[str, Any], default_timeout_sec: float) -> float:
    if route.get("timeoutMs") is not None:
        return _int_config(route.get("timeoutMs"), int(default_timeout_sec * 1000), 1) / 1000
    if route.get("timeoutSec") is not None:
        return float(_int_config(route.get("timeoutSec"), int(default_timeout_sec), 1))
    return default_timeout_sec

def _summarize_image_generation_failure(meta: Dict[str, Any], fallback_reason: str) -> str:
    reason = meta.get("reason")
    if reason:
        return str(reason)

    attempts = meta.get("attempts")
    if isinstance(attempts, list):
        for attempt in reversed(attempts):
            if isinstance(attempt, dict) and attempt.get("reason"):
                endpoint = attempt.get("endpoint") or "unknown"
                return f"{endpoint}: {attempt.get('reason')}"

    status = meta.get("status")
    endpoint = meta.get("endpoint")
    if status and endpoint:
        return f"{endpoint}: {status}"
    if status and status != "not_started":
        return str(status)
    return fallback_reason

def _get_image_generation_routes(config: Dict[str, Any], tuzi_config: Dict[str, Any], room_id: Optional[str] = None) -> list[Dict[str, Any]]:
    image_generation = config.get("ai", {}).get("comic", {}).get("imageGeneration", {}) or {}
    configured_routes = image_generation.get("routes")
    if image_generation.get("enabled", True) and isinstance(configured_routes, list) and configured_routes:
        routes = [route for route in configured_routes if isinstance(route, dict) and route.get("enabled", True)]
    else:
        routes = [{
            "provider": "tuZi",
            "model": tuzi_config.get("model", "gpt-image-2"),
            "flow": "tuZiCompatible",
            "maxAttempts": 1,
        }]

    room_config = {}
    if room_id is not None:
        room_key = str(room_id)
        room_config = (
            config.get("ai", {}).get("roomSettings", {}).get(room_key, {})
            or config.get("roomSettings", {}).get(room_key, {})
        )
    room_image_generation = room_config.get("imageGeneration", {}) if isinstance(room_config, dict) else {}
    room_routes = room_image_generation.get("routes") if isinstance(room_image_generation, dict) else None
    if room_image_generation.get("enabled", True) and isinstance(room_routes, list) and room_routes:
        return [route for route in room_routes if isinstance(route, dict) and route.get("enabled", True)]

    return routes[:1]

def _call_image_generation_route(
    route: Dict[str, Any],
    provider: Dict[str, Any],
    prompt: str,
    reference_image_path,
    room_id: Optional[str],
    timeout_sec: float,
) -> Optional[str]:
    provider_name = provider.get("name") or route.get("provider") or "unknown"
    model = route.get("model") or "gpt-image-2"
    flow = route.get("flow") or "openaiImages"
    proxy_url = route.get("proxy", provider.get("proxy", ""))

    if (provider.get("type") or "openai").lower() not in ("openai", "openai-compatible", "openai_compatible"):
        print(f"[IMAGE_PROVIDER] Skip unsupported provider type: {provider_name} ({provider.get('type')})")
        return None

    if not provider.get("baseUrl") or not provider.get("apiKey"):
        print(f"[IMAGE_PROVIDER] Skip unconfigured provider: {provider_name}")
        return None

    if flow in ("tuZiCompatible", "tuziCompatible", "tuzi"):
        return call_tuzi_chat_completions_for_image(
            prompt=prompt,
            reference_image_path=reference_image_path,
            model=model,
            base_url=provider.get("baseUrl", ""),
            api_key=provider.get("apiKey", ""),
            proxy_url=proxy_url,
            timeout=timeout_sec,
            temperature=route.get("temperature", 0.7),
            max_tokens=route.get("maxTokens", 100000),
            room_id=room_id,
            strategy_mode=route.get("strategyMode"),
            include_async_fallback=bool(route.get("includeAsyncFallback", True)),
            async_fallback_model=route.get("asyncFallbackModel", "gemini-3-pro-image-preview-async"),
        )

    return call_tuzi_images_generations(
        prompt=prompt,
        reference_image_path=reference_image_path,
        model=model,
        base_url=provider.get("baseUrl", ""),
        api_key=provider.get("apiKey", ""),
        proxy_url=proxy_url,
        timeout=timeout_sec,
        size=route.get("size", "1:1"),
        n=_int_config(route.get("n"), 1, 1),
        response_format=route.get("responseFormat", "b64_json"),
        quality=route.get("quality", "high"),
        output_format=route.get("outputFormat", "png"),
        use_tuzi_retry=bool(route.get("useTuziRetry", False)),
        provider_label=str(provider_name),
    )

def generate_unique_filename(base_path: str) -> str:
    """生成不重复的文件名（如果文件已存在，添加 _1, _2 等后缀）"""
    if not os.path.exists(base_path):
        return base_path
    
    dir_name = os.path.dirname(base_path)
    ext = os.path.splitext(base_path)[1]
    name_without_ext = os.path.splitext(os.path.basename(base_path))[0]
    
    counter = 1
    while True:
        new_path = os.path.join(dir_name, f"{name_without_ext}_{counter}{ext}")
        if not os.path.exists(new_path):
            return new_path
        counter += 1

def get_existing_generated_file(base_path: str) -> Optional[str]:
    """返回同一高亮已生成过的文件，优先返回无后缀原始文件。"""
    if os.path.exists(base_path):
        return base_path

    dir_name = os.path.dirname(base_path)
    ext = os.path.splitext(base_path)[1]
    name_without_ext = os.path.splitext(os.path.basename(base_path))[0]

    if not os.path.isdir(dir_name):
        return None

    import re
    pattern = re.compile(rf"^{re.escape(name_without_ext)}_(\d+){re.escape(ext)}$")
    candidates = []
    for file_name in os.listdir(dir_name):
        if pattern.match(file_name):
            file_path = os.path.join(dir_name, file_name)
            try:
                candidates.append((os.path.getmtime(file_path), file_path))
            except OSError:
                candidates.append((0, file_path))

    if not candidates:
        return None

    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]

def acquire_generation_lock(lock_path: str, timeout_seconds: int = 30 * 60) -> bool:
    """原子创建生成锁；陈旧锁会被清理。"""
    try:
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump({
                "pid": os.getpid(),
                "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S%z")
            }, f)
        return True
    except FileExistsError:
        try:
            age = time.time() - os.path.getmtime(lock_path)
            if age > timeout_seconds:
                os.remove(lock_path)
                return acquire_generation_lock(lock_path, timeout_seconds)
        except FileNotFoundError:
            return acquire_generation_lock(lock_path, timeout_seconds)
        return False

def wait_for_generated_file(base_path: str, lock_path: str, wait_seconds: int = 20 * 60) -> Optional[str]:
    """等待其他进程生成结果。"""
    deadline = time.time() + wait_seconds
    while time.time() < deadline:
        existing = get_existing_generated_file(base_path)
        if existing:
            return existing

        if not os.path.exists(lock_path):
            return get_existing_generated_file(base_path)

        time.sleep(3)

    return None

def release_generation_lock(lock_path: str) -> None:
    try:
        os.remove(lock_path)
    except FileNotFoundError:
        pass
    except OSError as e:
        print(f"[WARNING] 删除漫画生成锁失败: {e}")

def get_live_cover_image(highlight_path: str) -> Optional[str]:
    """从录制目录查找对应的直播封面图片"""
    try:
        dir_path = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')

        # 查找.cover文件
        cover_extensions = ['.jpg', '.jpeg', '.png', '.webp']
        for ext in cover_extensions:
            cover_path = os.path.join(dir_path, f"{base_name}.cover{ext}")
            if os.path.exists(cover_path):
                print(f"[INFO]  找到直播封面: {os.path.basename(cover_path)}")
                return cover_path

        # 如果没有找到.cover文件，尝试查找同名的.jpg文件（封面）
        for ext in cover_extensions:
            cover_path = os.path.join(dir_path, f"{base_name}{ext}")
            if os.path.exists(cover_path):
                print(f"[INFO]  找到直播封面（同名文件）: {os.path.basename(cover_path)}")
                return cover_path

        return None
    except Exception as e:
        print(f"[WARNING] 查找直播封面失败: {e}")
        return None

def get_room_reference_image(room_id: str, highlight_path: Optional[str] = None) -> Optional[str]:
    """获取房间的参考图片路径
    
    兜底策略：
    1. 优先使用 roomSettings 中配置的主播参考图
    2. 如果没有配置主播参考图，使用直播封面
    3. 只有连封面都拿不到，且配置了 defaultReferenceImage，才使用默认参考图
    4. 没有配置默认参考图时返回 None，让模型无参考图生成
    """
    config = load_config()
    
    # 获取项目根目录
    scripts_dir = os.path.dirname(__file__)
    project_root = get_project_root()

    # 第一优先级：检查 roomSettings 中的配置（主播参考图）
    room_str = str(room_id)
    room_has_config = False  # 标记是否配置了主播参考图
    
    if room_str in config["roomSettings"]:
        ref_image = config["roomSettings"][room_str].get("referenceImage", "")
        if ref_image:
            room_has_config = True
            # 尝试相对于项目根目录的路径
            absolute_path = os.path.join(project_root, ref_image) if not os.path.isabs(ref_image) else ref_image
            if os.path.exists(absolute_path):
                print(f"[INFO]  使用主播参考图: {os.path.basename(absolute_path)}")
                return absolute_path
            # 尝试相对于脚本目录的路径
            script_relative = os.path.join(scripts_dir, ref_image) if not os.path.isabs(ref_image) else ref_image
            if os.path.exists(script_relative):
                print(f"[INFO]  使用主播参考图: {os.path.basename(script_relative)}")
                return script_relative
            
            print(f"[WARNING] 配置的主播参考图不存在: {ref_image}")

        # 如果配置了但文件不存在，尝试在reference_images目录中查找
        if not room_has_config:
            ref_images_dir = os.path.join(scripts_dir, "reference_images")
            if os.path.exists(ref_images_dir):
                possible_files = [
                    os.path.join(ref_images_dir, f"{room_id}.jpg"),
                    os.path.join(ref_images_dir, f"{room_id}.jpeg"),
                    os.path.join(ref_images_dir, f"{room_id}.png"),
                    os.path.join(ref_images_dir, f"{room_id}.webp")
                ]
                for file_path in possible_files:
                    if os.path.exists(file_path):
                        print(f"[INFO]  使用主播参考图: {os.path.basename(file_path)}")
                        return file_path

    # 第二优先级：如果没有配置主播参考图，尝试使用直播封面
    if not room_has_config:
        host_streamer_id = find_host_streamer_id(config, room_id)
        if host_streamer_id:
            host_streamer = resolve_streamer_registry(config).get(host_streamer_id)
            for ref_image in (host_streamer or {}).get("referenceImages", []) or []:
                resolved = resolve_configured_path(ref_image)
                if resolved:
                    print(f"[INFO]  使用 streamerRegistry 主播参考图: {os.path.basename(resolved)}")
                    return resolved
                print(f"[WARNING] streamerRegistry 主播参考图不存在: {host_streamer_id} -> {ref_image}")

    if not room_has_config and highlight_path:
        live_cover = get_live_cover_image(highlight_path)
        if live_cover:
            print(f"[INFO]  未配置主播参考图，使用直播封面: {os.path.basename(live_cover)}")
            return live_cover

    # 第三优先级（兜底）：只有连封面都拿不到，才使用默认参考图片
    # 新格式：ai.defaultReferenceImage 或 ai.comic.defaultReferenceImage
    default_image = ""
    if "ai" in config:
        if config["ai"].get("defaultReferenceImage"):
            default_image = config["ai"]["defaultReferenceImage"]
        elif config["ai"].get("comic", {}).get("defaultReferenceImage"):
            default_image = config["ai"]["comic"]["defaultReferenceImage"]
    # 兼容旧格式
    if not default_image and config.get("aiServices", {}).get("defaultReferenceImage"):
        default_image = config["aiServices"]["defaultReferenceImage"]
    
    if default_image:
        # 尝试相对于项目根目录的路径
        absolute_path = os.path.join(project_root, default_image) if not os.path.isabs(default_image) else default_image
        if os.path.exists(absolute_path):
            print(f"[INFO]  使用默认参考图片（兜底）: {os.path.basename(absolute_path)}")
            return absolute_path
        # 尝试相对于脚本目录的路径
        script_relative = os.path.join(scripts_dir, default_image) if not os.path.isabs(default_image) else default_image
        if os.path.exists(script_relative):
            print(f"[INFO]  使用默认参考图片（兜底）: {os.path.basename(script_relative)}")
            return script_relative

    print("[INFO]  未配置默认参考图，将无参考图生成")
    return None

def resolve_configured_path(file_path: str) -> Optional[str]:
    """Resolve a configured path against project root first, then script dir."""
    if not file_path:
        return None
    scripts_dir = os.path.dirname(__file__)
    project_root = get_project_root()
    candidates = [
        file_path if os.path.isabs(file_path) else os.path.join(project_root, file_path),
        file_path if os.path.isabs(file_path) else os.path.join(scripts_dir, file_path),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return os.path.abspath(candidate)
    return None

def get_multi_reference_config(config: Dict[str, Any], room_id: Optional[str]) -> Dict[str, Any]:
    """Return global multi-reference config with room overrides applied."""
    ai_config = config.get("ai", {})
    global_config = ai_config.get("comic", {}).get("multiReferenceImages", {})
    room_config = {}
    if room_id:
        room_config = (config.get("ai", {}).get("roomSettings", {}).get(str(room_id), {}).get("multiReferenceImages", {})
                       or config.get("roomSettings", {}).get(str(room_id), {}).get("multiReferenceImages", {}))
    merged = {
        "enabled": False,
        "maxExtraCharacters": 2,
        "maxMentionedContextCharacters": 2,
        "minSpeakerScore": 0.64,
        "minSpeechSeconds": 8,
        "minSpeakerMaxScore": 0.80,
        "minSpeakerSecondsWhenLowScore": 900,
        "includeUnknownSpeakers": False,
        "includeMentionedStreamers": True,
        "includeMentionedStreamerImages": True,
        "useMentionedOnlyAsContext": True,
        "filterExtraImagesByComicScript": True,
        "filterMentionedImagesByComicScript": True,
        "appendCharacterDescriptions": True,
        "imageOrder": ["host", "appeared_streamers", "cover", "screenshots", "default"],
        "requirePlannedRosterForAppearedCharacters": False,
        "mentionCharacterMode": "allowed",
    }
    if isinstance(global_config, dict):
        merged.update(global_config)
    if isinstance(room_config, dict):
        merged.update(room_config)
    return merged

def get_allowed_extra_streamer_ids(multi_config: Dict[str, Any]) -> set[str]:
    allowed = multi_config.get("allowedExtraStreamerIds") or multi_config.get("allowedExtraStreamers") or []
    if not isinstance(allowed, list):
        return set()
    return {str(item).strip() for item in allowed if str(item or "").strip()}

def resolve_streamer_registry(config: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    registry = config.get("ai", {}).get("streamerRegistry", {})
    if not isinstance(registry, dict):
        return {}
    resolved = {}
    for streamer_id, entry in registry.items():
        if not isinstance(entry, dict):
            continue
        display_name = str(entry.get("displayName") or streamer_id).strip()
        labels = []
        for value in [streamer_id, display_name] + entry.get("speakerLabels", []) + entry.get("aliases", []):
            text = str(value or "").strip()
            if text and text not in labels:
                labels.append(text)
        mention_labels = []
        for value in [display_name] + entry.get("searchTags", []) + entry.get("mentionLabels", []):
            text = str(value or "").strip()
            if text and text not in mention_labels:
                mention_labels.append(text)
        resolved[str(streamer_id)] = {
            **entry,
            "id": str(streamer_id),
            "displayName": display_name,
            "speakerLabels": labels,
            "mentionLabels": mention_labels,
        }
    return resolved

def find_host_streamer_id(config: Dict[str, Any], room_id: Optional[str]) -> Optional[str]:
    if not room_id:
        return None
    room_text = str(room_id)
    for streamer_id, entry in resolve_streamer_registry(config).items():
        room_ids = [str(value) for value in entry.get("roomIds", [])]
        if room_text in room_ids:
            return streamer_id
    return None

def resolve_audio_path_for_reference(audio_path: str) -> str:
    text = str(audio_path or "").strip()
    if not text:
        return ""
    if os.path.isabs(text):
        return text
    return os.path.join(get_project_root(), text)

def collect_asr_speaker_references(config: Dict[str, Any]) -> list[dict]:
    asr_config = config.get("asr", {})
    if not isinstance(asr_config, dict):
        return []

    refs = []
    for backend_config in asr_config.values():
        if not isinstance(backend_config, dict):
            continue
        for ref in backend_config.get("speaker_references", []) or []:
            if isinstance(ref, dict):
                refs.append(ref)
    return refs

def host_has_asr_speaker_reference(config: Dict[str, Any], room_id: Optional[str]) -> tuple[bool, str]:
    registry = resolve_streamer_registry(config)
    host_streamer_id = find_host_streamer_id(config, room_id)
    if not host_streamer_id:
        return False, f"room={room_id} 未在 streamerRegistry.roomIds 中匹配到房间主人"

    host = registry.get(host_streamer_id)
    if not host:
        return False, f"房间主人 {host_streamer_id} 未配置 streamerRegistry"

    labels = []
    for value in [
        host.get("displayName"),
        *(host.get("speakerLabels", []) or []),
        *(host.get("aliases", []) or []),
    ]:
        text = str(value or "").strip()
        if text and text not in labels:
            labels.append(text)

    normalized_labels = {normalize_mention_text(label) for label in labels}
    references = collect_asr_speaker_references(config)
    if not references:
        return False, f"房间主人 {host.get('displayName') or host_streamer_id} 未配置 ASR speaker_references"

    matched_missing_paths = []
    for ref in references:
        speaker = str(ref.get("speaker") or "").strip()
        if not speaker or normalize_mention_text(speaker) not in normalized_labels:
            continue
        audio_path = resolve_audio_path_for_reference(str(ref.get("audio_path") or ""))
        if audio_path and os.path.exists(audio_path):
            return True, ""
        matched_missing_paths.append(str(ref.get("audio_path") or "").strip() or "(empty audio_path)")

    display_name = host.get("displayName") or host_streamer_id
    if matched_missing_paths:
        return False, f"房间主人 {display_name} 的 ASR speaker reference 音频不存在: {', '.join(matched_missing_paths)}"
    return False, f"房间主人 {display_name} 未配置可匹配的 ASR speaker reference"

def load_asr_speakers_for_highlight(highlight_path: str) -> dict:
    """Load xxx.asr_speakers.json for a highlight/SRT path if present."""
    try:
        if not highlight_path:
            return {}
        dir_path = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path)
        candidates = []
        if base_name.endswith("_AI_HIGHLIGHT.txt"):
            original_base = base_name.replace("_AI_HIGHLIGHT.txt", "")
            candidates.append(os.path.join(dir_path, f"{original_base}.asr_speakers.json"))
        else:
            stem, _ = os.path.splitext(base_name)
            candidates.append(os.path.join(dir_path, f"{stem}.asr_speakers.json"))

        for candidate in candidates:
            if os.path.exists(candidate):
                with open(candidate, "r", encoding="utf-8-sig") as f:
                    data = json.load(f)
                print(f"[INFO]  读取 ASR speaker summary: {os.path.basename(candidate)}")
                return data if isinstance(data, dict) else {}

        print(f"[INFO]  未找到 ASR speaker summary，跳过多参考图: {', '.join(os.path.basename(p) for p in candidates)}")
        return {}
    except Exception as e:
        print(f"[WARNING] 读取 ASR speaker summary 失败，跳过多参考图: {e}")
        return {}

def read_highlight_text_for_mentions(highlight_path: Optional[str]) -> str:
    if not highlight_path or not os.path.exists(highlight_path):
        return ""
    try:
        with open(highlight_path, "r", encoding="utf-8-sig") as f:
            return f.read()
    except Exception as e:
        print(f"[WARNING] 读取 highlight 文本失败，跳过提到主播解析: {e}")
        return ""

def normalize_mention_text(value: str) -> str:
    return str(value or "").casefold()

def is_safe_mention_label(label: str) -> bool:
    text = str(label or "").strip()
    if not text:
        return False
    # Avoid matching very short ASCII fragments such as IDs or initials in normal text.
    if text.isascii() and len(text) < 3:
        return False
    return True

def find_mention_label(highlight_text: str, streamer: Dict[str, Any]) -> Optional[str]:
    match = find_mention_match(highlight_text, streamer, {})
    return match[0] if match else None

def strip_highlight_chat_comments(highlight_text: str) -> str:
    return re.sub(r"\s*\(💬[^\n]*\)", "", highlight_text or "")

def strip_danmaku_sticker_tokens(text: str) -> str:
    """Remove sticker pack labels that look like streamer names but are not story actors."""
    if not text:
        return ""
    # Examples: [花礼Harei收藏集表情包_哈气], [栞栞收藏集表情包_啊？]
    return re.sub(r"\[[^\]\n]*(?:收藏集表情包|表情包)[^\]\n]*\]", "表情包", text)

def correction_to_pair(item: Any) -> Optional[tuple[str, str]]:
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        source = str(item[0] or "").strip()
        target = str(item[1] or "").strip()
    elif isinstance(item, dict):
        source = str(item.get("from") or item.get("alias") or item.get("source") or item.get("wrong") or "").strip()
        target = str(item.get("to") or item.get("word") or item.get("target") or item.get("correct") or "").strip()
    else:
        return None
    if not source or not target:
        return None
    return source, target

def collect_safe_correction_pairs(corrections: Any) -> list[tuple[str, str]]:
    if not corrections:
        return []
    if isinstance(corrections, dict) and ("safe" in corrections or "contextual" in corrections):
        return collect_safe_correction_pairs(corrections.get("safe"))
    if isinstance(corrections, dict):
        return [(str(source), str(target)) for source, target in corrections.items() if str(source or "").strip() and str(target or "").strip()]
    if isinstance(corrections, list):
        pairs = []
        for item in corrections:
            pair = correction_to_pair(item)
            if pair:
                pairs.append(pair)
        return pairs
    return []

def route_matches_room(match: Any, room_id: Optional[str]) -> bool:
    if not isinstance(match, dict):
        return False
    room_text = str(room_id or "").strip()
    for key, expected in match.items():
        if key not in ("room_id", "roomId", "room"):
            continue
        if isinstance(expected, list):
            return room_text in {str(item) for item in expected}
        return room_text == str(expected)
    return False

def collect_configured_asr_safe_corrections(room_id: Optional[str] = None, config: Optional[Dict[str, Any]] = None) -> list[tuple[str, str]]:
    cfg = config or load_config()
    asr_config = cfg.get("asr", {}) if isinstance(cfg, dict) else {}
    pairs = collect_safe_correction_pairs(asr_config.get("corrections"))
    for rule in asr_config.get("routing", []) or []:
        if not isinstance(rule, dict) or not route_matches_room(rule.get("match"), room_id):
            continue
        pairs.extend(collect_safe_correction_pairs(rule.get("corrections")))
    return pairs

def apply_configured_asr_corrections_for_comic(text: str, room_id: Optional[str] = None, config: Optional[Dict[str, Any]] = None) -> str:
    """Reuse configured ASR safe corrections when old highlight text is fed to comic generation."""
    output = text or ""
    pairs = collect_configured_asr_safe_corrections(room_id, config)
    for source, target in sorted(pairs, key=lambda pair: len(pair[0]), reverse=True):
        output = output.replace(source, target)
    return output

def sanitize_highlight_for_comic_script(highlight_content: str, room_id: Optional[str] = None, config: Optional[Dict[str, Any]] = None) -> str:
    """Keep factual text while removing non-semantic subtitle-review annotations."""
    # `.speaker.srt` prefixes are diagnostic CAM++ labels, not source facts.
    without_speaker_prefixes = re.sub(r"\[(?:[^\]\n]+?)\s+(?:\d+(?:\.\d+)?)\]\s*", "", highlight_content or "")
    cleaned = apply_configured_asr_corrections_for_comic(strip_danmaku_sticker_tokens(without_speaker_prefixes), room_id, config)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in cleaned.splitlines()]
    return "\n".join(line for line in lines if line).strip()


def live_generation_context_path(highlight_path: str) -> str:
    base_name = os.path.basename(highlight_path).replace("_AI_HIGHLIGHT.txt", "")
    return os.path.join(os.path.dirname(highlight_path), f"{base_name}_LIVE_CONTEXT.json")


def parse_recording_live_context(highlight_path: str, room_id: Optional[str] = None) -> Dict[str, Any]:
    base_name = os.path.basename(highlight_path).replace("_AI_HIGHLIGHT.txt", "")
    match = re.match(r"^录制-(\d+)-(\d{8})-(\d{6})-([^-]+)-(.+)$", base_name)
    parsed_room_id = str(room_id) if room_id is not None else None
    live_title = None
    recording_start_local_time = None
    if match:
        parsed_room_id = parsed_room_id or match.group(1)
        live_title = re.sub(r"_merged(?:_\d+)?$", "", match.group(5)).strip() or None
        date_part = match.group(2)
        time_part = match.group(3)
        recording_start_local_time = (
            f"{date_part[0:4]}-{date_part[4:6]}-{date_part[6:8]} "
            f"{time_part[0:2]}:{time_part[2:4]}:{time_part[4:6]} UTC+8"
        )
    return {
        "schemaVersion": 1,
        "roomId": parsed_room_id,
        "liveTitle": live_title,
        "recordingStartTime": None,
        "recordingStartLocalTime": recording_start_local_time,
        "contentHints": [],
        "recentDynamics": [],
        "sources": {
            "liveTitle": "recording-filename" if live_title else None,
            "recentDynamics": "not-requested",
        },
    }


def get_room_content_hints(config: Dict[str, Any], room_id: Optional[str]) -> list[str]:
    room_key = str(room_id or "")
    room_settings = (
        config.get("ai", {}).get("roomSettings", {}).get(room_key)
        or config.get("roomSettings", {}).get(room_key)
        or {}
    )
    raw_hints = room_settings.get("contentHints")
    if raw_hints is None:
        host_id = find_host_streamer_id(config, room_id)
        host = resolve_streamer_registry(config).get(host_id, {}) if host_id else {}
        raw_hints = host.get("contentHints")
    if isinstance(raw_hints, list):
        return [re.sub(r"\s+", " ", str(item)).strip() for item in raw_hints if str(item).strip()]
    hint = re.sub(r"\s+", " ", str(raw_hints or "")).strip()
    return [hint] if hint else []


def load_live_generation_context(
    highlight_path: str,
    room_id: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    context_path = live_generation_context_path(highlight_path)
    if os.path.exists(context_path):
        try:
            with open(context_path, "r", encoding="utf-8") as context_file:
                context = json.load(context_file)
            if isinstance(context, dict) and context.get("schemaVersion") == 1:
                return context
        except Exception as error:
            print(f"[WARNING] 读取直播事实上下文失败，将仅使用文件名: {error}")

    context = parse_recording_live_context(highlight_path, room_id)
    context["contentHints"] = get_room_content_hints(config or load_config(), context.get("roomId"))
    return context


def format_live_generation_context(context: Optional[Dict[str, Any]]) -> str:
    if not context:
        return ""
    lines = [
        "【本场事实上下文（高优先级约束）】",
        f"- 直播标题：{context.get('liveTitle') or '未取得'}",
        f"- 开播时间（北京时间）：{context.get('recordingStartLocalTime') or '未取得'}。判断早/午/晚必须以此为准，不能因主播说“刚起床”等作息描述改写客观时段。",
    ]
    recent_dynamics = context.get("recentDynamics") or []
    if recent_dynamics:
        lines.append("- 开播前近期动态（仅用于确认本场主题/预告，不得把动态里未在本场发生的事写成直播内容）：")
        for item in recent_dynamics:
            publish_time = str(item.get("publishTime") or "时间未知")
            content = re.sub(r"\s+", " ", str(item.get("content") or "")).strip()
            if content:
                lines.append(f"  - [{publish_time}] {content}")
    content_hints = context.get("contentHints") or []
    if content_hints:
        lines.append("- 主播内容歧义提示（只用于解释本场已经出现的词句，不得主动补写）：")
        lines.extend(f"  - {hint}" for hint in content_hints)
    lines.extend([
        "【事实证据优先级】直播标题与明确语音 > 同场弹幕 > 开播前近期动态 > 稳定人设、兴趣、口头禅与模型常识。",
        "稳定人设、兴趣和口头禅不是本场发生的事实，只能消解正文中确实存在且没有冲突证据的歧义；一旦高优先级证据指向其他游戏、活动或人物，必须服从高优先级证据。",
        "当直播标题、明确语音或开播前动态中至少两类证据一致确认具体游戏/活动时，回复和画面应自然点明该名称，不要退化成泛化的“某游戏”“抽卡界面”；只有证据不足或互相冲突时才使用中性描述。",
        "不得因为人物设定中的某款游戏或口头禅，擅自给本场添加对应游戏界面、角色、Logo或台词。游戏/活动无法确认时使用中性描述，不猜具体作品。",
    ])
    return "\n".join(lines)


def hash_live_generation_context(context: Optional[Dict[str, Any]]) -> Optional[str]:
    if context is None:
        return None
    relevant = {
        "liveTitle": context.get("liveTitle"),
        "recordingStartTime": context.get("recordingStartTime"),
        "recordingStartLocalTime": context.get("recordingStartLocalTime"),
        "contentHints": context.get("contentHints") or [],
        "recentDynamics": context.get("recentDynamics") or [],
    }
    serialized = json.dumps(relevant, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

def count_normalized_occurrences(text: str, label: str) -> int:
    normalized_text = normalize_mention_text(text)
    normalized_label = normalize_mention_text(label)
    if not normalized_label:
        return 0
    return normalized_text.count(normalized_label)

def is_short_cjk_mention_label(label: str) -> bool:
    text = str(label or "").strip()
    if len(text) > 2:
        return False
    return any("\u4e00" <= char <= "\u9fff" for char in text)

def is_configured_alias_label(label: str, streamer: Dict[str, Any]) -> bool:
    normalized_label = normalize_mention_text(label)
    aliases = streamer.get("aliases", []) or []
    return any(normalize_mention_text(str(alias or "").strip()) == normalized_label for alias in aliases)

def find_mention_match(
    highlight_text: str,
    streamer: Dict[str, Any],
    multi_config: Optional[Dict[str, Any]] = None,
    strict_short_mentions: bool = True,
    room_id: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
) -> Optional[tuple[str, int, int]]:
    multi_config = multi_config or {}
    mention_text = apply_configured_asr_corrections_for_comic(strip_danmaku_sticker_tokens(highlight_text), room_id, config)
    spoken_text = strip_highlight_chat_comments(mention_text)
    min_short_spoken = int(multi_config.get("minShortMentionSpokenOccurrences") or 2)
    min_short_total = int(multi_config.get("minShortMentionTotalOccurrences") or 8)
    min_danmaku_only = int(multi_config.get("minDanmakuOnlyMentionOccurrences") or 3)
    for label in streamer.get("mentionLabels", []) or []:
        label_text = str(label or "").strip()
        if not is_safe_mention_label(label_text):
            continue
        total_count = count_normalized_occurrences(mention_text, label_text)
        if total_count <= 0:
            continue
        spoken_count = count_normalized_occurrences(spoken_text, label_text)
        if spoken_count <= 0 and total_count < min_danmaku_only:
            continue
        if strict_short_mentions and is_short_cjk_mention_label(label_text):
            if spoken_count >= 1 and is_configured_alias_label(label_text, streamer):
                return label_text, spoken_count, total_count
            if spoken_count < min_short_spoken and total_count < min_short_total:
                continue
        return label_text, spoken_count, total_count
    return None

def find_streamer_label_in_text(text: str, streamer: Dict[str, Any]) -> Optional[str]:
    normalized_text = normalize_mention_text(text)
    labels = []
    for value in [
        streamer.get("displayName"),
        *(streamer.get("mentionLabels", []) or []),
        *(streamer.get("speakerLabels", []) or []),
        *(streamer.get("aliases", []) or []),
    ]:
        label = str(value or "").strip()
        if label and label not in labels:
            labels.append(label)
    for label in labels:
        if not is_safe_mention_label(label):
            continue
        if normalize_mention_text(label) in normalized_text:
            return label
    return None

def filter_extra_streamers_for_image_prompt(
    extra_streamers: Optional[list[dict]],
    comic_text: str,
    config: Dict[str, Any],
    room_id: Optional[str],
) -> list[dict]:
    if not extra_streamers:
        return []
    multi_config = get_multi_reference_config(config, room_id)
    filter_all_extra = multi_config.get("filterExtraImagesByComicScript", True)
    filter_mentioned = multi_config.get("filterMentionedImagesByComicScript", True)
    if not filter_all_extra and not filter_mentioned:
        return list(extra_streamers)

    filtered = []
    for streamer in extra_streamers:
        reason = streamer.get("_comicReferenceReason") or "appeared"
        should_filter = filter_all_extra or (reason == "mentioned" and filter_mentioned)
        if not should_filter:
            filtered.append(streamer)
            continue
        matched_label = find_streamer_label_in_text(comic_text or "", streamer)
        if matched_label:
            filtered.append({**streamer, "_matchedComicLabel": matched_label})
        else:
            display_name = streamer.get("displayName") or streamer.get("id") or "unknown"
            matched_mention = streamer.get("_matchedMentionLabel") or ""
            source_label = "文本提到" if reason == "mentioned" else "ASR出声"
            source_detail = f"，highlight命中: {matched_mention}" if matched_mention else ""
            print(f"[INFO]  额外主播未出现在漫画脚本中，跳过其参考图: {display_name} (来源: {source_label}{source_detail})")
    return filtered

def to_optional_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        parsed = float(value)
        return parsed if parsed == parsed else None
    except (TypeError, ValueError):
        return None

def find_sidecar_participant_for_streamer(sidecar: dict, streamer: Dict[str, Any]) -> Optional[dict]:
    participants = sidecar.get("participants", []) if isinstance(sidecar, dict) else []
    streamer_id = str(streamer.get("id") or "")
    for participant in participants:
        if str(participant.get("streamerId") or "") == streamer_id:
            return participant
    return None


def find_sidecar_speaker_for_streamer(sidecar: dict, streamer: Dict[str, Any]) -> Optional[dict]:
    speakers = sidecar.get("speakers", []) if isinstance(sidecar, dict) else []
    labels = []
    for value in [
        streamer.get("displayName"),
        *(streamer.get("speakerLabels", []) or []),
        *(streamer.get("aliases", []) or []),
    ]:
        label = str(value or "").strip()
        if label and label not in labels:
            labels.append(label)
    normalized_labels = {normalize_mention_text(label) for label in labels}
    for speaker in speakers:
        speaker_label = normalize_mention_text(str(speaker.get("label") or "").strip())
        if speaker_label in normalized_labels:
            return speaker
    return None

def sidecar_speaker_passes_reference_thresholds(
    speaker: Optional[dict],
    streamer: Dict[str, Any],
    multi_config: Dict[str, Any],
) -> bool:
    if not speaker:
        return True

    display_name = streamer.get("displayName") or streamer.get("id") or speaker.get("label") or "unknown"
    total_seconds = to_optional_float(speaker.get("totalSpeechSeconds")) or 0.0
    avg_score = to_optional_float(speaker.get("avgScore"))
    max_score = to_optional_float(speaker.get("maxScore"))
    min_seconds = float(multi_config.get("minSpeechSeconds") or 0)
    min_avg_score = float(multi_config.get("minSpeakerScore") or 0)
    min_max_score = float(multi_config.get("minSpeakerMaxScore") or 0)
    low_score_seconds = float(multi_config.get("minSpeakerSecondsWhenLowScore") or 0)

    if total_seconds < min_seconds:
        print(f"[INFO]  过滤额外出声主播参考图: {display_name} 出声 {total_seconds:.1f}s < {min_seconds:.1f}s")
        return False
    if avg_score is not None and avg_score < min_avg_score:
        print(f"[INFO]  过滤额外出声主播参考图: {display_name} avgScore {avg_score:.4f} < {min_avg_score:.4f}")
        return False
    if max_score is not None and min_max_score > 0 and max_score < min_max_score and total_seconds < low_score_seconds:
        print(
            f"[INFO]  过滤低置信额外出声主播参考图: {display_name} "
            f"maxScore {max_score:.4f} < {min_max_score:.4f} 且出声 {total_seconds:.1f}s < {low_score_seconds:.1f}s"
        )
        return False
    return True

def resolve_mentioned_streamers(
    config: Dict[str, Any],
    room_id: Optional[str],
    highlight_path: Optional[str],
    already_streamer_ids: Optional[set[str]] = None,
    highlight_text: Optional[str] = None,
    strict_short_mentions: bool = True,
) -> list[dict]:
    multi_config = get_multi_reference_config(config, room_id)
    include_mentions = multi_config.get("includeMentionedStreamers", multi_config.get("useMentionedOnlyAsContext", True))
    if not include_mentions:
        return []

    if highlight_text is None:
        highlight_text = read_highlight_text_for_mentions(highlight_path)
    if not highlight_text:
        return []

    registry = resolve_streamer_registry(config)
    host_streamer_id = find_host_streamer_id(config, room_id)
    already = set(already_streamer_ids or set())
    allowed_extra_ids = get_allowed_extra_streamer_ids(multi_config)
    max_mentioned = max(0, int(multi_config.get("maxMentionedContextCharacters") or multi_config.get("maxExtraCharacters") or 0))
    mentioned_streamers = []

    for streamer_id, entry in registry.items():
        if streamer_id == host_streamer_id or streamer_id in already:
            continue
        if allowed_extra_ids and streamer_id not in allowed_extra_ids:
            continue
        mention_match = find_mention_match(
            highlight_text,
            entry,
            multi_config,
            strict_short_mentions=strict_short_mentions,
            room_id=room_id,
            config=config,
        )
        if not mention_match:
            continue
        matched_label, spoken_count, total_count = mention_match
        if len(mentioned_streamers) >= max_mentioned:
            print(f"[INFO]  文本提到主播达到上限 maxMentionedContextCharacters={max_mentioned}，跳过 {streamer_id}")
            continue
        mentioned_streamers.append({
            **entry,
            "_comicReferenceReason": "mentioned",
            "_matchedMentionLabel": matched_label,
            "_matchedMentionSpokenCount": spoken_count,
            "_matchedMentionTotalCount": total_count,
        })

    if mentioned_streamers:
        print("[INFO]  识别到文本提到的额外主播: " + ", ".join(
            f"{item.get('displayName', item['id'])}({item.get('_matchedMentionLabel')})"
            for item in mentioned_streamers
        ))
    return mentioned_streamers

def resolve_extra_appeared_streamers(
    config: Dict[str, Any],
    room_id: Optional[str],
    highlight_path: Optional[str],
    include_mentioned_streamers: bool = True,
) -> list[dict]:
    multi_config = get_multi_reference_config(config, room_id)
    print(f"[INFO]  multiReferenceImages.enabled={bool(multi_config.get('enabled'))} room={room_id}")
    if not multi_config.get("enabled"):
        return []
    if not highlight_path:
        print("[INFO]  未提供 highlight_path，跳过多参考图")
        return []

    registry = resolve_streamer_registry(config)
    host_streamer_id = find_host_streamer_id(config, room_id)
    max_extra = max(0, int(multi_config.get("maxExtraCharacters") or 0))
    allowed_extra_ids = get_allowed_extra_streamer_ids(multi_config)
    extra_streamers = []

    host_has_reference, host_reference_skip_reason = host_has_asr_speaker_reference(config, room_id)
    sidecar = {}
    if host_has_reference:
        sidecar = load_asr_speakers_for_highlight(highlight_path)
    else:
        print(
            "[INFO]  跳过 ASR 出声触发漫画参考图: "
            f"{host_reference_skip_reason}；无法可靠区分房间主人和其他说话人"
        )

    require_planned_roster = bool(multi_config.get("requirePlannedRosterForAppearedCharacters"))
    has_explicit_roster = bool(sidecar and sidecar.get("constrainedToRoster"))
    if require_planned_roster and not has_explicit_roster:
        print("[INFO]  房间要求已规划名单才允许额外实际出声角色，忽略非约束 ASR 标签")

    for streamer_id in sidecar.get("extraAppearedStreamerIds", []) if sidecar else []:
        streamer_id = str(streamer_id)
        if require_planned_roster and not has_explicit_roster:
            continue
        if streamer_id == host_streamer_id:
            print(f"[INFO]  跳过房间主人额外参考图: {streamer_id}")
            continue
        if allowed_extra_ids and streamer_id not in allowed_extra_ids:
            print(f"[INFO]  跳过未在 allowedExtraStreamerIds 中的额外参考图: {streamer_id}")
            continue
        entry = registry.get(streamer_id)
        if not entry:
            print(f"[WARNING] ASR sidecar 中的主播未配置 streamerRegistry: {streamer_id}")
            continue
        participant = find_sidecar_participant_for_streamer(sidecar, entry)
        if participant and participant.get("appeared") is False:
            print(f"[INFO]  跳过未实际出声的参与者: {streamer_id}")
            continue
        speaker = find_sidecar_speaker_for_streamer(sidecar, entry)
        if not sidecar_speaker_passes_reference_thresholds(speaker, entry, multi_config):
            continue
        if len(extra_streamers) >= max_extra:
            print(f"[INFO]  额外主播达到上限 maxExtraCharacters={max_extra}，跳过 {streamer_id}")
            continue
        extra_streamers.append({**entry, "_comicReferenceReason": "appeared"})

    if sidecar and not extra_streamers:
        for participant in sidecar.get("participants", []) or []:
            if participant.get("appeared") is not True:
                continue
            streamer_id = str(participant.get("streamerId") or "")
            if not streamer_id or streamer_id == host_streamer_id:
                continue
            if any(str(item.get("id") or "") == streamer_id for item in extra_streamers):
                continue
            if allowed_extra_ids and streamer_id not in allowed_extra_ids:
                continue
            entry = registry.get(streamer_id)
            if not entry:
                continue
            speaker = find_sidecar_speaker_for_streamer(sidecar, entry)
            if not sidecar_speaker_passes_reference_thresholds(speaker, entry, multi_config):
                continue
            if len(extra_streamers) >= max_extra:
                break
            extra_streamers.append({**entry, "_comicReferenceReason": "planned_appeared"})

    if include_mentioned_streamers:
        already_ids = {streamer.get("id") for streamer in extra_streamers if streamer.get("id")}
        for streamer in resolve_mentioned_streamers(config, room_id, highlight_path, already_ids):
            if len(extra_streamers) >= max_extra:
                print(f"[INFO]  额外主播达到上限 maxExtraCharacters={max_extra}，跳过文本提到主播 {streamer.get('id')}")
                continue
            extra_streamers.append(streamer)

    if extra_streamers:
        print("[INFO]  识别到可用于多参考图的额外主播: " + ", ".join(item.get("displayName", item["id"]) for item in extra_streamers))
    else:
        print("[INFO]  未识别到可用于多参考图的额外出声主播")
    return extra_streamers

def resolve_image_prompt_extra_streamers(
    config: Dict[str, Any],
    room_id: Optional[str],
    highlight_path: Optional[str],
    comic_text: str,
) -> list[dict]:
    """Choose extra character references only after the storyboard is available.

    ASR-confirmed speakers remain eligible directly. Text-only candidates are
    resolved from the completed storyboard rather than the whole highlight, so
    an unrelated mention cannot be promoted into a different scene merely
    because its reference image was available first.
    """
    multi_config = get_multi_reference_config(config, room_id)
    max_extra = max(0, int(multi_config.get("maxExtraCharacters") or 0))
    detected_streamers = resolve_extra_appeared_streamers(
        config,
        room_id,
        highlight_path,
        include_mentioned_streamers=False,
    )

    selected: list[dict] = []
    selected_ids: set[str] = set()
    for streamer in detected_streamers:
        if streamer.get("_comicReferenceReason") == "mentioned":
            continue
        if len(selected) >= max_extra:
            break
        streamer_id = str(streamer.get("id") or "")
        if streamer_id and streamer_id in selected_ids:
            continue
        selected.append(streamer)
        if streamer_id:
            selected_ids.add(streamer_id)

    # A generated storyboard is never evidence that a new streamer should be
    # drawn. Resolve mentions from the source highlight first, then require the
    # approved storyboard to actually use that source-backed mention.
    source_mentions = resolve_mentioned_streamers(
        config,
        room_id,
        highlight_path,
        selected_ids,
        strict_short_mentions=False,
    )
    for streamer in filter_extra_streamers_for_image_prompt(source_mentions, comic_text, config, room_id):
        if len(selected) >= max_extra:
            print(f"[INFO]  额外主播达到上限 maxExtraCharacters={max_extra}，跳过漫画脚本提到主播 {streamer.get('id')}")
            continue
        streamer_id = str(streamer.get("id") or "")
        if streamer_id and streamer_id in selected_ids:
            continue
        selected.append(streamer)
        if streamer_id:
            selected_ids.add(streamer_id)

    if selected:
        print("[INFO]  根据漫画脚本确定额外主播参考图: " + ", ".join(
            item.get("displayName", item["id"]) for item in selected
        ))
    return selected

def collect_all_images(room_id: str, highlight_path: Optional[str] = None, extra_streamers: Optional[list[dict]] = None) -> list[str]:
    """收集所有可用的图片（引用图、封面、截图）用于AI输入
    
    返回图片路径列表，按优先级排序：
    1. 主播参考图（roomSettings中配置的referenceImage）
    2. 直播封面（.cover文件）
    3. 直播截图（_SCREENSHOTS.jpg）
    4. 默认参考图（只有在没有主播参考图、封面、截图且配置了 defaultReferenceImage 时才使用）
    5. 没有配置默认参考图时返回空列表，让模型无参考图生成
    """
    images = []
    seen_images = set()

    def add_image(image_path: str, log_message: str) -> bool:
        real_path = os.path.abspath(image_path)
        if real_path in seen_images:
            print(f"[INFO]  跳过重复图片: {os.path.basename(real_path)}")
            return False
        images.append(real_path)
        seen_images.add(real_path)
        print(log_message)
        return True

    config = load_config()
    scripts_dir = os.path.dirname(__file__)
    project_root = get_project_root()
    multi_config = get_multi_reference_config(config, room_id)
    if not multi_config.get("enabled"):
        extra_streamers = []
    max_total_images = int(multi_config.get("maxTotalImages") or 4)
    
    # 1. 尝试获取主播参考图（roomSettings中配置的）
    room_str = str(room_id)
    has_anchor_image = False
    
    if room_str in config["roomSettings"]:
        ref_image = config["roomSettings"][room_str].get("referenceImage", "")
        if ref_image:
            # 尝试相对于项目根目录的路径
            absolute_path = os.path.join(project_root, ref_image) if not os.path.isabs(ref_image) else ref_image
            if os.path.exists(absolute_path):
                add_image(absolute_path, f"[INFO]  收集到主播参考图: {os.path.basename(absolute_path)}")
                has_anchor_image = True
            else:
                # 尝试相对于脚本目录的路径
                script_relative = os.path.join(scripts_dir, ref_image) if not os.path.isabs(ref_image) else ref_image
                if os.path.exists(script_relative):
                    add_image(script_relative, f"[INFO]  收集到主播参考图: {os.path.basename(script_relative)}")
                    has_anchor_image = True
                else:
                    print(f"[WARNING] 配置的主播参考图不存在: {ref_image}")
    
    # 如果没有配置主播参考图，尝试在reference_images目录中查找
    if not has_anchor_image:
        ref_images_dir = os.path.join(scripts_dir, "reference_images")
        if os.path.exists(ref_images_dir):
            possible_files = [
                os.path.join(ref_images_dir, f"{room_id}.jpg"),
                os.path.join(ref_images_dir, f"{room_id}.jpeg"),
                os.path.join(ref_images_dir, f"{room_id}.png"),
                os.path.join(ref_images_dir, f"{room_id}.webp")
            ]
            for file_path in possible_files:
                if os.path.exists(file_path):
                    add_image(file_path, f"[INFO]  收集到主播参考图: {os.path.basename(file_path)}")
                    has_anchor_image = True
                    break

    if not has_anchor_image:
        host_streamer_id = find_host_streamer_id(config, room_id)
        if host_streamer_id:
            host_streamer = resolve_streamer_registry(config).get(host_streamer_id)
            for ref_image in (host_streamer or {}).get("referenceImages", []) or []:
                resolved = resolve_configured_path(ref_image)
                if resolved:
                    add_image(resolved, f"[INFO]  收集到 streamerRegistry 主播参考图: {os.path.basename(resolved)}")
                    has_anchor_image = True
                    break
                print(f"[WARNING] streamerRegistry 主播参考图不存在: {host_streamer_id} -> {ref_image}")

    # 1.5 额外实际出声/文本提到主播参考图。只取每人第一张存在的图。
    for streamer in (extra_streamers or []):
        if len(images) >= max_total_images:
            print(f"[INFO]  图片数量达到保守上限 {max_total_images}，停止加入额外主播参考图")
            break
        display_name = streamer.get("displayName") or streamer.get("id") or "unknown"
        reason = streamer.get("_comicReferenceReason") or "appeared"
        if reason == "mentioned" and not multi_config.get("includeMentionedStreamerImages", True):
            print(f"[INFO]  已识别文本提到主播但配置为不上传参考图: {display_name}")
            continue
        reference_images = streamer.get("referenceImages", []) or []
        if not reference_images:
            print(f"[INFO]  额外主播未配置参考图，将按文字描述生成: {display_name}")
            continue
        added = False
        for ref_image in reference_images:
            resolved = resolve_configured_path(ref_image)
            if resolved:
                reason_label = "文本提到主播" if reason == "mentioned" else "实际出声主播"
                added = add_image(resolved, f"[INFO]  收集到额外{reason_label}参考图: {display_name} -> {os.path.basename(resolved)}")
                break
            print(f"[WARNING] 额外主播参考图不存在: {display_name} -> {ref_image}")
        if not added:
            print(f"[WARNING] 额外主播没有可用参考图: {display_name}")
    
    # 2. 获取直播封面
    has_cover = False
    if highlight_path:
        cover_image = get_live_cover_image(highlight_path)
        if cover_image and len(images) < max_total_images:
            add_image(cover_image, f"[INFO]  收集到直播封面: {os.path.basename(cover_image)}")
            has_cover = True
        elif cover_image:
            print(f"[INFO]  图片数量达到保守上限 {max_total_images}，跳过直播封面: {os.path.basename(cover_image)}")
    
    # 3. 获取直播截图（从环境变量）
    screenshot_path = os.environ.get('SCREENSHOT_PATH', '')
    if screenshot_path and os.path.exists(screenshot_path) and len(images) < max_total_images:
        add_image(screenshot_path, f"[INFO]  收集到直播截图: {os.path.basename(screenshot_path)}")
    elif screenshot_path and os.path.exists(screenshot_path):
        print(f"[INFO]  图片数量达到保守上限 {max_total_images}，跳过直播截图: {os.path.basename(screenshot_path)}")
    
    # 如果没有截图路径，尝试从highlight_path推断
    if not screenshot_path and highlight_path:
        dir_path = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')
        inferred_screenshot = os.path.join(dir_path, f"{base_name}_SCREENSHOTS.jpg")
        if os.path.exists(inferred_screenshot) and len(images) < max_total_images:
            add_image(inferred_screenshot, f"[INFO]  收集到推断的直播截图: {os.path.basename(inferred_screenshot)}")
        elif os.path.exists(inferred_screenshot):
            print(f"[INFO]  图片数量达到保守上限 {max_total_images}，跳过推断的直播截图: {os.path.basename(inferred_screenshot)}")
    
    # 4. 只有在完全没有任何图片时，才使用默认参考图（兜底）
    # 检查是否已经收集到任何图片（主播参考图、封面、截图）
    if len(images) == 0:
        print("[INFO]  未找到任何图片（主播参考图、封面、截图），检查是否配置默认参考图...")
        default_image = ""
        if "ai" in config:
            if config["ai"].get("defaultReferenceImage"):
                default_image = config["ai"]["defaultReferenceImage"]
            elif config["ai"].get("comic", {}).get("defaultReferenceImage"):
                default_image = config["ai"]["comic"]["defaultReferenceImage"]
        # 兼容旧格式
        if not default_image and config.get("aiServices", {}).get("defaultReferenceImage"):
            default_image = config["aiServices"]["defaultReferenceImage"]
        
        if default_image:
            # 尝试相对于项目根目录的路径
            absolute_path = os.path.join(project_root, default_image) if not os.path.isabs(default_image) else default_image
            if os.path.exists(absolute_path):
                add_image(absolute_path, f"[INFO]  收集到默认参考图（兜底）: {os.path.basename(absolute_path)}")
            else:
                # 尝试相对于脚本目录的路径
                script_relative = os.path.join(scripts_dir, default_image) if not os.path.isabs(default_image) else default_image
                if os.path.exists(script_relative):
                    add_image(script_relative, f"[INFO]  收集到默认参考图（兜底）: {os.path.basename(script_relative)}")
        if not default_image:
            print("[INFO]  未配置默认参考图，将无参考图生成")
    else:
        print(f"[INFO]  已有 {len(images)} 张图片，跳过默认参考图")
    
    print(f"[INFO]  共收集到 {len(images)} 张图片用于AI输入")
    return images

def read_highlight_file(highlight_path: str) -> str:
    """读取AI_HIGHLIGHT.txt内容"""
    try:
        with open(highlight_path, 'r', encoding='utf-8') as f:
            return f.read()
    except Exception as e:
        print(f"[ERROR] 读取AI_HIGHLIGHT文件失败: {e}")
        raise

def extract_room_id_from_filename(filename: str) -> Optional[str]:
    """从文件名中提取房间ID"""
    # DDTV文件名格式: 26966466_20240101_120000_AI_HIGHLIGHT.txt
    import re
    match = re.match(r'^(\d+)_', filename)
    return match.group(1) if match else None

def get_room_character_description(room_id: Optional[str] = None) -> str:
    """从配置中获取房间或全局的角色描述，返回已清洗的字符串。"""
    try:
        config = load_config()

        desc = ""
        if room_id:
            room_cfg = config.get("roomSettings", {}).get(str(room_id), {})
            desc = room_cfg.get("characterDescription") or room_cfg.get("characterDesc", "")

        if not desc:
            # 新格式：从 ai.defaultCharacterDescription 读取
            if "ai" in config and config["ai"].get("defaultCharacterDescription"):
                desc = config["ai"]["defaultCharacterDescription"]
            # 兼容旧格式
            elif config.get("aiServices", {}).get("defaultCharacterDescription"):
                desc = config["aiServices"]["defaultCharacterDescription"]

        if not desc:
            # 内置回退描述（与原先硬编码内容一致）
            desc = "岁己SUI（白发红瞳女生），饼干岁（有细细四肢的小小小的饼干状生物）"

        # 清洗：折叠换行、去两端空白、截断、去除尖括号以避免模型解析问题
        desc = " ".join([s.strip() for s in desc.splitlines() if s.strip()])
        desc = desc.replace("<", "").replace(">", "")
        if len(desc) > 400:
            desc = desc[:400]

        return desc
    except Exception:
        return "岁己SUI（白发红瞳女生），饼干岁（有细细四肢的小小的饼干状生物）"

def get_multi_character_description(room_id: Optional[str] = None, extra_streamers: Optional[list[dict]] = None) -> str:
    """Return host character description plus appeared extra streamer descriptions."""
    base_desc = get_room_character_description(room_id)
    try:
        config = load_config()
        multi_config = get_multi_reference_config(config, room_id)
        if not multi_config.get("enabled") or not multi_config.get("appendCharacterDescriptions", True):
            return base_desc
        if not extra_streamers:
            return base_desc

        lines = [base_desc, "", "额外实际出声/文本提到主播："]
        for idx, streamer in enumerate(extra_streamers, 1):
            display_name = streamer.get("displayName") or streamer.get("id") or f"主播{idx}"
            desc = streamer.get("characterDescription") or display_name
            desc = " ".join(str(desc).replace("<", "").replace(">", "").split())
            reason = streamer.get("_comicReferenceReason") or "appeared"
            reason_label = "文本提到" if reason == "mentioned" else "实际出声"
            lines.append(f"{idx}. {display_name}（{reason_label}）：{desc}")
        return "\n".join(lines)
    except Exception as e:
        print(f"[WARNING] 构建多角色描述失败，使用房间角色描述: {e}")
        return base_desc

def model_supports_chinese(model: Optional[str] = None) -> bool:
    """判断模型是否支持在图像中生成汉字
    
    Args:
        model: 模型名称
        
    Returns:
        True 如果模型支持汉字，False 否则
    """
    if not model:
        return False
    
    # 高级模型列表（支持汉字）
    advanced_models = [
        "gpt-image-2",
        "gpt-image-1.5",
        "gemini-3-pro-image-preview-async",
        "gemini-3-pro-image-preview/nano-banana-2",
        "gemini-3-pro-image-preview-2k-async",
        "gemini-3-pro-image-preview-4k-async",
    ]
    
    # 检查模型名称是否在高级模型列表中
    for advanced_model in advanced_models:
        if advanced_model in model:
            return True
    
    return False

def build_multi_character_constraints(extra_streamers: Optional[list[dict]] = None) -> str:
    if not extra_streamers:
        return ""
    names = "、".join(streamer.get("displayName") or streamer.get("id") or "额外主播" for streamer in extra_streamers)
    mapping_lines = ["- 参考图1 = 房间主人。"]
    referenced_streamers = []
    unreferenced_streamers = []
    for streamer in extra_streamers:
        has_reference = any(resolve_configured_path(ref_image) for ref_image in (streamer.get("referenceImages", []) or []))
        (referenced_streamers if has_reference else unreferenced_streamers).append(streamer)
    for index, streamer in enumerate(referenced_streamers, start=2):
        display_name = streamer.get("displayName") or streamer.get("id") or f"额外主播{index - 1}"
        desc = " ".join(str(streamer.get("characterDescription") or display_name).replace("<", "").replace(">", "").split())
        mapping_lines.append(f"- 参考图{index} = {display_name}：{desc}")
    mapping_text = "\n".join(mapping_lines)
    no_reference_text = ""
    if unreferenced_streamers:
        no_reference_names = "、".join(
            streamer.get("displayName") or streamer.get("id") or "额外主播"
            for streamer in unreferenced_streamers
        )
        no_reference_text = f"\n- {no_reference_names} 没有参考图，只能依据文字描述单独绘制；不要套用任一已有参考图的外观。"
    return f"""
多角色参考图约束：
- 识别出的连麦/实际出声/文本提到主播：{names}。
- 参考图编号映射如下，必须逐一遵守，不要混淆角色：
{mapping_text}
- 不要把没有对应编号的角色误画成任一参考图人物。{no_reference_text}
- 漫画脚本中只要出现上述额外主播，必须优先按对应编号的参考图还原外观，而不是只根据文字描述脑补。
- 后续直播封面、截图只用于直播间/背景/道具参考，不要当作额外主播的角色参考图。
- 不要把不同角色的发色、服装、配饰混合。
- 只有漫画脚本明确出现多人互动或明确需要画到被提到的人时才画多位主播。
- 仅被提到但没有实际出声的人，可以使用其参考图保持形象准确，但不要默认画成现场连麦角色。"""

def build_comic_prompt(
    highlight_content: str,
    reference_image_path: Optional[str] = None,
    room_id: Optional[str] = None,
    existing_comic: Optional[str] = None,
    model: Optional[str] = None,
    extra_streamers: Optional[list[dict]] = None,
    live_context: Optional[Dict[str, Any]] = None,
) -> Tuple[str, str, bool]:
    """构建漫画生成提示词并返回 (prompt, comic_content, is_generated)。

    如果提供 `existing_comic` 则复用已有脚本而不再调用AI生成。
    返回值: (base_prompt, comic_content, is_generated)
    is_generated: 是否真正生成了漫画脚本（True）还是使用原文或已有脚本（False）
    
    Args:
        highlight_content: 直播内容
        reference_image_path: 参考图片路径（已废弃，保留用于兼容性）
        room_id: 房间ID
        existing_comic: 已有的漫画脚本
        model: 模型名称，用于判断是否支持汉字
    """
    # 第一步：如果传入已有脚本则复用，否则使用AI生成漫画内容脚本
    is_generated = False
    if existing_comic and existing_comic.strip() != "":
        comic_content = existing_comic
        is_generated = True  # 复用已有脚本也算成功，允许继续生成图像
        # build_comic_prompt is called a second time after fresh generation to
        # add reference-image constraints. Keep that generation provenance.
        if get_comic_script_meta().get("status") != "success":
            set_comic_script_meta(provider="existing", model="existing-script", status="success", reason="复用已有漫画脚本")
    else:
        comic_content, is_generated = generate_comic_content_with_ai(
            highlight_content,
            room_id=room_id,
            extra_streamers=extra_streamers,
            live_context=live_context,
        )

    # 获取角色描述并注入绘画提示词（优先房间配置、再全局默认、最后内置默认）
    character_desc = get_multi_character_description(room_id, extra_streamers)
    multi_constraints = build_multi_character_constraints(extra_streamers)

    # 尝试获取房间级别的自定义图片生成 prompt
    config = load_config()
    room_config = config.get("roomSettings", {}).get(str(room_id), {}) if room_id else {}
    custom_image_prompt = room_config.get("customPrompts", {}).get("comicImage")
    live_context_block = format_live_generation_context(live_context)

    # 第二步：基于漫画内容构建绘画提示词（包含角色设定，便于图像生成一致）
    if custom_image_prompt:
        # 使用自定义 prompt 模板
        has_live_context_placeholder = "{live_context}" in custom_image_prompt
        base_prompt = custom_image_prompt.replace("{character_desc}", character_desc).replace("{comic_content}", comic_content)
        base_prompt = base_prompt.replace("{live_context}", live_context_block)
        if live_context_block and not has_live_context_placeholder:
            base_prompt = f"{live_context_block}\n\n{base_prompt}"
        if multi_constraints:
            base_prompt = f"{base_prompt}\n{multi_constraints}"
    else:
        # 使用默认模板，包含 {chinese_instruction} 占位符
        # 这个占位符会在实际调用 API 时根据模型能力动态替换
        base_prompt = f"""<note>一定要按照给你的参考图还原形象，而不是自己乱画一个动漫角色</note>
<character>{character_desc}</character>
<live_facts>{live_context_block}</live_facts>
若下方漫画脚本与 live_facts 冲突，以 live_facts 为准并修正画面，不要绘制错误的游戏界面、角色、Logo或台词。
{multi_constraints}
要画得精致，角色要画得帅气、美丽、可爱。
{{chinese_instruction}}
下面是根据直播内容生成的漫画脚本，请根据这个脚本绘制漫画：
{comic_content}"""

    return base_prompt, comic_content, is_generated


def build_comic_identity_context(
    highlight_content: str,
    room_id: Optional[str],
    config: Optional[Dict[str, Any]] = None,
    appeared_streamers: Optional[list[dict]] = None,
) -> Dict[str, Any]:
    """Resolve host, ASR-confirmed participants, and text-only mentions."""
    cfg = config or load_config()
    registry = resolve_streamer_registry(cfg)
    host_id = find_host_streamer_id(cfg, room_id)
    host = registry.get(host_id) if host_id else None
    appeared = list(appeared_streamers or [])
    appeared_ids = {
        str(item.get("id") or "")
        for item in appeared
        if str(item.get("id") or "")
    }
    mentions = resolve_mentioned_streamers(
        cfg,
        room_id,
        None,
        already_streamer_ids=appeared_ids,
        highlight_text=highlight_content,
        strict_short_mentions=True,
    )
    return {
        "host": host,
        "appeared": appeared,
        "mentions": mentions,
    }


def format_comic_identity_context(context: Dict[str, Any]) -> str:
    host = context.get("host") or {}
    host_name = host.get("displayName") or "房间主人"
    appeared_lines = []
    for item in context.get("appeared") or []:
        name = item.get("displayName") or item.get("id")
        appeared_lines.append(
            f"- {name}：ASR 已确认在本场直播中实际出声，是现场互动角色。"
        )
    appeared = "\n".join(appeared_lines) if appeared_lines else "- 无其他已确认出声角色。"
    mention_lines = []
    for item in context.get("mentions") or []:
        name = item.get("displayName") or item.get("id")
        label = item.get("_matchedMentionLabel") or name
        mention_lines.append(f"- {name}：仅在原文中被提到（命中“{label}”），不是本场嘉宾、连麦者或合唱者。")
    mentions = "\n".join(mention_lines) if mention_lines else "- 无其他已验证人物提及。"
    return f"""人物事实边界（必须遵守）：
- 本场直播主人唯一是：{host_name}。不要把 ASR、弹幕或模型记忆里的其他名字改写成主播。
- 已确认在本场实际出声的互动角色：
{appeared}
- 已验证的文字提及：
{mentions}
- 已确认出声的互动角色应按正文中的共同事件参与画面，不要用粉丝吉祥物或路人替代。
- 被提到的人只能按照原文明确的事件画成回忆/游戏画面/屏幕内容；绝不能自动成为嘉宾、连麦者、合唱者或本场直播角色。
- 不要在画面中生成“主播”“嘉宾”“主持”“连麦”等身份牌，也不要生成或翻译人名（包括中文名、英文名、拼音）。人名不是必要画面文字时一律省略。"""


# 虚拟主播二创画师大手子的统一prompt模板（方便统一修改）
# 文字prompt: 画图+文字台词or简介，可以没有文字，有的话要很短（5个单词内），不要用中文。
COMIC_ARTIST_PROMPT_TEMPLATE = """你作为虚拟主播二创画师大手子，根据直播内容，绘制直播总结插画。
角色描述：{character_desc}。
{identity_context}。
{live_context}
风格：多个剪贴画风格分镜（2~4个吧），每个是一个片段场景，
默认以画面叙事为主，但如果有助于漫画效果，可以设计少量中文台词框、拟声词、标题字或路牌字，文字要自然、准确、排版清楚，不要过多。
注意：弹幕里的“[某某收藏集表情包_xxx]”或“[某某表情包_xxx]”只是观众发的表情包名称，不代表这个主播出场、连麦或参与对话；不要把表情包名称当成漫画角色。
只画语音正文、摘要事件或明确提到的真实人物；不确定时画房间主人、观众小人、道具或屏幕内容，不要凭表情包名新增主播。
如果语音正文给出团体、名单或成员关系，只能按该关系附近的正文确定成员；不能把本场其它段落提到的主播替换进这个团体。
下面是一场直播的语音+弹幕文本，请先构思图片并用文字给我，我再拿去绘制图片。整体600个字符以内。只返回各个分镜的文字描述，不要包含任何多余的说明、格式。若适合带字，请明确写出这些字应该出现在什么位置、每处写什么，单处文字尽量控制在1到12个字。
{highlight_content}
"""

def build_comic_generation_prompt(
    character_desc: str,
    highlight_content: str,
    room_id: Optional[str] = None,
    appeared_streamers: Optional[list[dict]] = None,
    live_context: Optional[Dict[str, Any]] = None,
) -> str:
    """使用COMIC_ARTIST_PROMPT_TEMPLATE构建完整的prompt（用于Gemini等调用）"""
    # 尝试获取房间级别的自定义漫画脚本 prompt
    config = load_config()
    room_config = config.get("roomSettings", {}).get(str(room_id), {}) if room_id else {}
    custom_prompt = room_config.get("customPrompts", {}).get("comicScript")
    
    # 如果有自定义 prompt，使用它
    if custom_prompt:
        template = custom_prompt.strip()
    else:
        # 否则使用默认模板
        template = COMIC_ARTIST_PROMPT_TEMPLATE.strip()
    
    identity_context = format_comic_identity_context(
        build_comic_identity_context(
            highlight_content,
            room_id,
            config,
            appeared_streamers=appeared_streamers,
        )
    )
    live_context_block = format_live_generation_context(live_context)
    has_live_context_placeholder = "{live_context}" in template
    base = template.replace("{character_desc}", character_desc)
    base = base.replace("{identity_context}", identity_context)
    base = base.replace("{live_context}", live_context_block)
    base = base.replace("{highlight_content}", highlight_content)
    if live_context_block and not has_live_context_placeholder:
        base = f"{live_context_block}\n\n{base}"
    return base


def is_gemini_error(text: str) -> bool:
    """检测文本是否包含Gemini错误信息"""
    if not text:
        return False
    return 'Gemini Error' in text


def is_valid_comic_script(text: Optional[str]) -> bool:
    """Return False for obviously truncated or non-story comic scripts."""
    if not text:
        return False

    normalized = re.sub(r'\s+', '', text)
    return len(normalized) >= 40


def is_comic_script_fallback_allowed(room_id: Optional[str] = None) -> bool:
    """是否允许在AI脚本生成失败后使用本地兜底脚本继续生图。"""
    if str(os.environ.get("DISABLE_COMIC_SCRIPT_FALLBACK", "")).lower() == "true":
        return False
    if str(os.environ.get("ALLOW_COMIC_SCRIPT_FALLBACK", "")).lower() == "true":
        return True
    return str(room_id or "") == "25788785"


def strip_srt_timestamps(text: str) -> str:
    text = re.sub(r'\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}', ' ', text)
    text = re.sub(r'^\s*\d+\s*$', ' ', text, flags=re.MULTILINE)
    return text


def build_local_fallback_comic_script(highlight_content: str, room_id: Optional[str] = None) -> str:
    """用摘要内容生成一个短兜底分镜，避免脚本AI短暂故障时完全跳过图片。"""
    cleaned = strip_srt_timestamps(highlight_content)
    lines = []
    for raw_line in cleaned.splitlines():
        line = re.sub(r'\s+', ' ', raw_line).strip()
        if len(line) < 8:
            continue
        if any(marker in line.lower() for marker in ["http://", "https://", "[error]", "traceback"]):
            continue
        lines.append(line)

    if not lines:
        compact = re.sub(r'\s+', ' ', cleaned).strip()
        lines = [compact[i:i + 70] for i in range(0, min(len(compact), 280), 70) if compact[i:i + 70]]

    while len(lines) < 4:
        lines.append("主播和观众温柔互动，直播间氛围轻松热闹。")

    selected = lines[:4]
    anchor_name = "岁己" if str(room_id or "") == "25788785" else "主播"
    panels = []
    panel_styles = [
        "开场",
        "互动",
        "名场面",
        "晚安收束",
    ]
    for index, line in enumerate(selected, start=1):
        panels.append(f"分镜{index}（{panel_styles[index - 1]}）：{anchor_name}在直播间里延续今晚的高光片段：{line[:120]}")

    return "\n".join(panels)

def postprocess_generated_comic_script(
    comic_content: str,
    source_highlight: str,
    room_id: Optional[str] = None,
    appeared_streamers: Optional[list[dict]] = None,
) -> str:
    """Remove unsupported identities and roles before the image model sees a script."""
    if not comic_content:
        return comic_content

    config = load_config()
    cleaned_source = sanitize_highlight_for_comic_script(source_highlight, room_id, config)
    identity_context = build_comic_identity_context(
        cleaned_source,
        room_id,
        config,
        appeared_streamers=appeared_streamers,
    )
    allowed_names = {
        normalize_mention_text(str((identity_context.get("host") or {}).get("displayName") or ""))
    }
    allowed_names.update(
        normalize_mention_text(str(item.get("displayName") or ""))
        for item in identity_context.get("mentions") or []
    )
    allowed_names.update(
        normalize_mention_text(str(item.get("displayName") or ""))
        for item in identity_context.get("appeared") or []
    )
    output = strip_danmaku_sticker_tokens(comic_content)

    # If 花礼 only appeared through stripped sticker tokens, do not let it become an invented actor.
    if not re.search(r"花礼|Harei", cleaned_source) and re.search(r"花礼|Harei", output):
        fixed_lines = []
        for line in output.splitlines():
            if re.search(r"花礼|Harei", line):
                if re.search(r"乳贴|贴纸|安利|推荐", line) and re.search(r"岁己", cleaned_source):
                    line = re.sub(r"花礼Harei|花礼|Harei", "岁己SUI", line)
                    line = re.sub(r"（黑发蓝瞳鼠耳）", "（白发红瞳）", line)
                elif re.search(r"睡|下播|关播|直播设备|呼呼", line) and re.search(r"弥月|老弥", cleaned_source):
                    line = re.sub(r"花礼Harei|花礼|Harei", "弥月Mizuki", line)
                    line = re.sub(r"（黑发蓝瞳鼠耳）", "（亚麻发异瞳）", line)
                else:
                    line = re.sub(r"花礼Harei|花礼|Harei", "被提到的主播", line)
            fixed_lines.append(line)
        next_output = "\n".join(fixed_lines)
        if next_output != output:
            print("[INFO]  漫画脚本后处理：移除由弹幕表情包名误引入的花礼角色")
        output = next_output

    registry = resolve_streamer_registry(config)
    untrusted_names = []
    for streamer in registry.values():
        display_name = str(streamer.get("displayName") or "").strip()
        if not display_name or normalize_mention_text(display_name) in allowed_names:
            continue
        for label in [display_name, *(streamer.get("mentionLabels") or [])]:
            label = str(label or "").strip()
            if label and len(label) >= 2 and label not in untrusted_names:
                untrusted_names.append(label)

    filtered_lines = []
    for line in output.splitlines():
        has_untrusted_name = any(label in line for label in untrusted_names)
        has_unsupported_role = bool(re.search(r"嘉宾|连麦|合唱|一起直播|主播\s*[：:（(]", line))
        if has_untrusted_name and has_unsupported_role:
            print(f"[INFO]  漫画脚本后处理：移除无来源人物关系: {line[:100]}")
            continue
        # Remove explicit identity-card names, then remove the role word itself.
        # A confirmed participant name in ordinary prose remains intact.
        line = re.sub(
            r"(?:主播|嘉宾|主持|连麦)(?:\s+|[:：]\s*)[^\s，,；;。]+",
            "",
            line,
        )
        line = re.sub(r"主播|嘉宾|主持|连麦", "", line)
        filtered_lines.append(line.strip())

    return "\n".join(line for line in filtered_lines if line)


def return_comic_script_failure(highlight_content: str, room_id: Optional[str], reason: str) -> Tuple[str, bool]:
    if is_comic_script_fallback_allowed(room_id):
        fallback_script = build_local_fallback_comic_script(highlight_content, room_id)
        print(f"[WARNING]  AI漫画脚本生成失败（{reason}），使用本地兜底分镜继续生图")
        print(f"兜底脚本长度: {len(fallback_script)} 字符")
        print(f"兜底内容预览: {fallback_script[:200]}...")
        set_comic_script_meta(provider="local", model="local-fallback", fallback=True, status="success", reason=reason)
        return fallback_script, True
    set_comic_script_meta(provider=None, model=None, fallback=True, status="failure", reason=reason)
    return highlight_content, False


def has_socks_proxy_support() -> bool:
    """检查当前 Python 环境是否具备 SOCKS 代理支持。"""
    return importlib.util.find_spec("socksio") is not None

def generate_comic_content_with_ai(
    highlight_content: str,
    room_id: Optional[str] = None,
    extra_streamers: Optional[list[dict]] = None,
    live_context: Optional[Dict[str, Any]] = None,
) -> Tuple[str, bool]:
    """使用AI生成漫画内容脚本
    
    返回值: (comic_content, is_generated)
    is_generated: 是否真正生成了脚本（True）还是返回原文作为备选（False）
    """
    print("[AI] 使用AI生成漫画内容脚本...")

    script_highlight_content = sanitize_highlight_for_comic_script(highlight_content, room_id=room_id)
    character_desc = get_multi_character_description(room_id, extra_streamers)
    content_prompt = build_comic_generation_prompt(
        character_desc,
        script_highlight_content,
        room_id,
        appeared_streamers=extra_streamers,
        live_context=live_context,
    )

    # 首先尝试复用已有的 Node 文本生成器（ai_text_generator.js），避免在 Python 中重复实现 Gemini 调用
    try:
        node_bin = shutil.which('node')
        script_path = os.path.join(os.path.dirname(__file__), 'ai_text_generator.js')
        if node_bin and os.path.exists(script_path):
            try:
                print(f"[AI] 调用 node 脚本生成文本: {script_path}")
                proc = subprocess.run(
                    [node_bin, script_path, '--generate-text'],
                    input=content_prompt.encode('utf-8'),
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=os.path.dirname(__file__),
                    timeout=120,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
                )
                if proc.returncode == 0 and proc.stdout:
                    text = proc.stdout.decode('utf-8').strip()
                    stderr = proc.stderr.decode('utf-8') if proc.stderr else ''
                    generation_meta = {}
                    for line in reversed(stderr.splitlines()):
                        if line.startswith('[[TEXT_GENERATION_META]] '):
                            try:
                                generation_meta = json.loads(line[len('[[TEXT_GENERATION_META]] '):])
                            except json.JSONDecodeError:
                                print('[WARNING] ai_text_generator 返回了无法解析的生成元数据')
                            break
                    if text and not is_gemini_error(text) and is_valid_comic_script(text):
                        print('[OK] 从 ai_text_generator 返回内容')
                        set_comic_script_meta(
                            provider=generation_meta.get("provider", "node"),
                            model=generation_meta.get("model", "ai_text_generator"),
                            fallback=bool(generation_meta.get("fallback")),
                            status="success",
                        )
                        return postprocess_generated_comic_script(
                            text,
                            script_highlight_content,
                            room_id,
                            appeared_streamers=extra_streamers,
                        ), True
                    elif is_gemini_error(text):
                        print('[WARNING] ai_text_generator 返回了错误内容，尝试其他方案')
                    elif text:
                        print(f"[WARNING] ai_text_generator 返回内容无效或疑似截断，长度: {len(text)} 字符，尝试其他方案")
                    else:
                        stderr = proc.stderr.decode('utf-8') if proc.stderr else ''
                        print(f"[INFO] node 脚本返回非零状态: {proc.returncode}, stderr: {stderr}")
            except Exception as e:
                print(f"[INFO] 调用 node 脚本失败: {e}")
    except Exception:
        pass

    # Gemini重试逻辑
    max_gemini_retries = 3
    
    # 首先检查 google-genai 是否可用
    if not HAS_GOOGLE_GENAI:
        print("[INFO] google-genai 库未安装，跳过 Gemini 文本生成，直接使用 daiYu API")
        # 直接跳到 daiYu API 备用方案
    else:
        for gemini_attempt in range(max_gemini_retries):
            try:
                # 获取Gemini API密钥（使用统一配置加载器）
                gemini_api_key = get_gemini_api_key()

                if not gemini_api_key:
                    print("[WARNING]  Gemini API密钥未配置，使用原始内容")
                    break

                # 加载配置获取其他参数
                config = load_config()
                gemini_config = config.get('aiServices', {}).get('gemini', {})

                # 设置代理 (如果需要)
                proxy_url = gemini_config.get('proxy', '')
                if proxy_url:
                    if proxy_url.startswith('socks') and not has_socks_proxy_support():
                        print("[WARNING] Gemini 配置了 SOCKS 代理，但当前环境缺少 socksio/httpx[socks]，跳过 Gemini 直连备用方案")
                        break
                    os.environ['http_proxy'] = proxy_url
                    os.environ['https_proxy'] = proxy_url
                    os.environ['HTTP_PROXY'] = proxy_url
                    os.environ['HTTPS_PROXY'] = proxy_url

                # 创建客户端（增加超时时间到120秒以应对SSL握手超时）
                client = genai.Client(api_key=gemini_api_key, http_options=genai_types.HttpOptions(timeout=120))

                # 获取模型名称
                model_name = gemini_config.get('model', 'gemini-2.0-flash')

                # 调用Gemini
                if gemini_attempt > 0:
                    print(f"[RETRY] 第 {gemini_attempt + 1} 次重试 Gemini...")
                print(f"[AI] 使用Gemini生成漫画内容脚本: {model_name}")
                response = client.models.generate_content(
                    model=model_name,
                    contents=content_prompt
                )

                if response and response.text:
                    comic_content = response.text.strip()
                    
                    # 检测是否包含错误信息
                    if is_gemini_error(comic_content):
                        print(f"[WARNING] Gemini返回了错误内容 (尝试 {gemini_attempt + 1}/{max_gemini_retries})")
                        if gemini_attempt < max_gemini_retries - 1:
                            print("[RETRY] 2秒后重试...")
                            time.sleep(2)
                            continue
                        else:
                            print("[ERROR] Gemini重试次数已用完，尝试备用方案")
                            break

                    if not is_valid_comic_script(comic_content):
                        print(f"[WARNING] Gemini返回内容无效或疑似截断 (尝试 {gemini_attempt + 1}/{max_gemini_retries})，长度: {len(comic_content)} 字符")
                        if gemini_attempt < max_gemini_retries - 1:
                            print("[RETRY] 2秒后重试...")
                            time.sleep(2)
                            continue
                        print("[ERROR] Gemini重试次数已用完，尝试备用方案")
                        break

                    print("[OK] AI漫画内容生成完成")
                    print(f"生成内容长度: {len(comic_content)} 字符")
                    set_comic_script_meta(provider="gemini", model=model_name, status="success", fallback=False)
                    return postprocess_generated_comic_script(
                        comic_content,
                        script_highlight_content,
                        room_id,
                        appeared_streamers=extra_streamers,
                    ), True
                else:
                    print("[WARNING]  AI返回空结果，使用原始内容")
                    break

            except Exception as e:
                error_msg = str(e)
                print(f"[ERROR]  AI内容生成失败 (尝试 {gemini_attempt + 1}/{max_gemini_retries}): {e}")
                
                # 检测是否是SSL相关错误
                is_ssl_error = any(keyword in error_msg.lower() for keyword in ['ssl', 'handshake', 'timed out', 'timeout'])
                
                if gemini_attempt < max_gemini_retries - 1:
                    # SSL错误使用更长的重试间隔
                    retry_delay = 5 if is_ssl_error else 2
                    print(f"[RETRY] {retry_delay}秒后重试...")
                    time.sleep(retry_delay)
                    continue
                else:
                    print("[ERROR] Gemini重试次数已用完，尝试备用方案")
                    break
    
    # Gemini失败后，使用 daiYu/gpt-5.6-luna 作为备用方案，并开启思考。
    print("[COMIC_SCRIPT] Google文本生成失败，尝试 daiYu/gpt-5.6-luna 生成漫画脚本...")

    # content_prompt 已经包含完整直播高光；不要在 user/system 两个角色里重复发送。
    system_prompt = "你是直播总结漫画编剧。请严格依据用户提供的直播内容，只输出完整、可绘制的分镜脚本。"
    user_prompt = content_prompt
    try:
        config = load_config()
        ai_config = config.get("ai", {}) or {}
        text_config = ai_config.get("text", {}) or {}
        daiyu_config = text_config.get("daiYu", {}) or {}
        provider_config = (ai_config.get("providers", {}) or {}).get("daiYu", {}) or {}
        daiyu_api_key = daiyu_config.get("apiKey") or provider_config.get("apiKey", "")
        daiyu_base_url = (
            daiyu_config.get("baseUrl")
            or daiyu_config.get("baseURL")
            or provider_config.get("baseURL")
            or provider_config.get("baseUrl")
            or "http://localhost:8080"
        )
        daiyu_model = daiyu_config.get("model", "gpt-5.6-luna")
        daiyu_thinking = daiyu_config.get("thinking", {}) or {}
        thinking_enabled = daiyu_thinking.get("enabled", True) is not False
        thinking_budget_tokens = daiyu_thinking.get("budgetTokens", 10000)
        temperature = daiyu_config.get("temperature", provider_config.get("textTemperature", 0.7))
        max_tokens = daiyu_config.get("maxTokens", provider_config.get("textMaxTokens", 100000))

        if not daiyu_api_key:
            print("[WARNING] daiYu provider 未配置，跳过")
            return return_comic_script_failure(highlight_content, room_id, "daiYu未配置")

        print(f"[COMIC_SCRIPT] 尝试 daiYu provider 生成漫画脚本 (model: {daiyu_model}, thinking: {thinking_enabled})...")
        comic_content = call_daiyu_chat_completions(
            prompt=user_prompt,
            system_prompt=system_prompt,
            model=daiyu_model,
            base_url=daiyu_base_url,
            api_key=daiyu_api_key,
            proxy_url=daiyu_config.get("proxy", provider_config.get("proxy", "")) or "",
            timeout=120,
            temperature=temperature,
            max_tokens=max_tokens,
            thinking=thinking_enabled,
            thinking_budget_tokens=thinking_budget_tokens,
        )

        if comic_content and is_valid_comic_script(comic_content) and not is_gemini_error(comic_content):
            print("[OK] daiYu provider 漫画文本生成成功")
            print(f"生成内容长度: {len(comic_content)} 字符")
            set_comic_script_meta(
                provider="daiYu",
                model=daiyu_model,
                status="success",
                fallback=True,
            )
            return postprocess_generated_comic_script(
                comic_content,
                script_highlight_content,
                room_id,
                appeared_streamers=extra_streamers,
            ), True

        reason = "daiYu 返回空内容" if not comic_content else (
            "daiYu 返回 Gemini 错误内容"
            if is_gemini_error(comic_content)
            else "daiYu 返回无效脚本"
        )
        print(f"[WARNING] daiYu provider 失败: {reason}")
        return return_comic_script_failure(highlight_content, room_id, reason)
    except Exception as daiyu_error:
        print(f"[ERROR]  daiYu provider 异常: {daiyu_error}")
        return return_comic_script_failure(highlight_content, room_id, f"daiYu异常({daiyu_error})")
    
    # 确保函数在所有路径都返回有效值
    return return_comic_script_failure(highlight_content, room_id, "所有AI脚本通道失败")

def encode_image_to_base64(image_path: str, with_data_uri: bool = False) -> str:
    """将图片编码为base64
    
    Args:
        image_path: 图片路径
        with_data_uri: 是否添加 data:image/xxx;base64, 前缀
    """
    try:
        with open(image_path, "rb") as image_file:
            base64_data = base64.b64encode(image_file.read()).decode('utf-8')
        
        if with_data_uri:
            # 根据文件扩展名确定MIME类型
            ext = os.path.splitext(image_path)[1].lower()
            mime_map = {
                '.png': 'image/png',
                '.jpg': 'image/jpeg',
                '.jpeg': 'image/jpeg',
                '.webp': 'image/webp',
                '.gif': 'image/gif'
            }
            mime_type = mime_map.get(ext, 'image/png')
            return f"data:{mime_type};base64,{base64_data}"
        
        return base64_data
    except Exception as e:
        print(f"[ERROR] 图片编码失败: {e}")
        raise

def try_simpler_model(prompt: str, hf_config: Dict[str, Any], proxies: Dict[str, str]) -> Optional[str]:
    """尝试使用更简单的模型生成图像"""
    try:
        # 尝试使用更小、更快的模型
        simpler_models = [
            "runwayml/stable-diffusion-v1-5",
            "CompVis/stable-diffusion-v1-4",
            "prompthero/openjourney"
        ]
        
        for model_name in simpler_models:
            print(f"[RETRY] 尝试模型: {model_name}")
            
            router_url = "https://router.huggingface.co/hf-inference/models"
            headers = {
                "Authorization": f"Bearer {hf_config['apiToken']}",
                "Content-Type": "application/json"
            }
            
            simple_prompt = f"Anime comic style: {prompt[:100]}"
            
            payload = {
                "inputs": simple_prompt,
                "parameters": {
                    "num_inference_steps": 15,
                    "guidance_scale": 7.0,
                    "width": 512,
                    "height": 512
                }
            }
            
            api_url = f"{router_url}/{model_name}"
            response = requests.post(api_url, headers=headers, json=payload, timeout=120, proxies=proxies)
            
            if response.status_code == 200:
                print(f"[OK] 图像生成成功 (模型: {model_name})")
                
                import tempfile
                import uuid
                temp_dir = tempfile.gettempdir()
                temp_file = os.path.join(temp_dir, f"comic_{uuid.uuid4().hex[:8]}.png")
                
                with open(temp_file, 'wb') as f:
                    f.write(response.content)
                
                print(f"[SAVE] 图像已保存: {temp_file}")
                return temp_file
            elif response.status_code == 503:
                print(f"[INFO]  模型 {model_name} 正在加载，跳过")
                continue
            else:
                print(f"[WARNING]  模型 {model_name} 失败: {response.status_code}")
                continue
        
        print("[ERROR] 所有模型尝试都失败")
        return None
        
    except Exception as e:
        print(f"[ERROR] 尝试简单模型失败: {e}")
        return None

def call_google_image_api(prompt: str, reference_image_path: Optional[str] = None) -> Optional[str]:
    """
    调用Google图像生成API
    使用Google的Imagen或其他图像生成模型
    支持重试机制
    """
    config = load_config()
    google_config = config.get("aiServices", {}).get("googleImage", {})

    if not is_googleimage_configured():
        print("[WARNING]  Google图像生成API未配置，跳过Google图像生成")
        return None

    max_retries = google_config.get("maxRetries", 3)
    print(f"[GOOGLE] 调用Google图像生成API生成漫画... (最多重试 {max_retries} 次)")

    for attempt in range(max_retries + 1):
        try:
            if attempt > 0:
                print(f"[RETRY] 第 {attempt} 次重试...")

            # 导入Google GenAI库 (新版本)
            import google.genai as genai

            # 创建客户端
            ai = genai.GoogleGenAI(api_key=google_config["apiKey"])

            # 设置代理
            proxy_url = google_config.get("proxy", "")
            if proxy_url:
                import os
                os.environ['http_proxy'] = proxy_url
                os.environ['https_proxy'] = proxy_url
                if attempt == 0:  # 只在第一次显示代理信息
                    print(f"[PROXY] 使用代理: {proxy_url}")

            # 获取模型名称
            model_name = google_config.get("model", "imagen-3.0-generate-001")

            # 构建图像生成请求
            # 注意：Google的Imagen API可能需要不同的调用方式
            # 这里使用GenAI的图像生成功能

            # 首先尝试使用GenAI的图像生成
            try:
                # 构建提示词（优化为适合图像生成）

                # 构建提示词（优化为适合图像生成）
                image_prompt = prompt

                if attempt == 0:
                    print("[WAIT] 正在通过Google API生成图像...")

                # 生成图像（60秒超时）
                response = ai.models.generate_content(
                    model=model_name,
                    contents=image_prompt,
                    generation_config={
                        "temperature": 0.7,
                        "top_p": 0.95,
                        "top_k": 40,
                    },
                    safety_settings=google_config.get("safetySettings", []),
                    timeout=60
                )

                # 处理响应
                if response and hasattr(response, 'candidates') and response.candidates:
                    # 检查是否有图像数据
                    for candidate in response.candidates:
                        if hasattr(candidate, 'content') and candidate.content:
                            for part in candidate.content.parts:
                                if hasattr(part, 'inline_data') and part.inline_data:
                                    # 提取图像数据
                                    image_data = part.inline_data.data
                                    mime_type = part.inline_data.mime_type

                                    # 保存图像
                                    import tempfile
                                    import uuid

                                    temp_dir = tempfile.gettempdir()
                                    extension = mime_type.split('/')[-1] if '/' in mime_type else 'png'
                                    temp_file = os.path.join(temp_dir, f"comic_google_{uuid.uuid4().hex[:8]}.{extension}")

                                    with open(temp_file, 'wb') as f:
                                        f.write(image_data)

                                    print(f"[OK] Google图像生成成功")
                                    print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
                                    return temp_file

                # 如果上面的方法不工作，尝试备用方案
                if attempt == 0:
                    print("[INFO]  标准图像生成方法未返回图像，尝试备用方案...")

            except Exception as genai_error:
                print(f"[WARNING]  Generative AI图像生成失败: {genai_error}")
                if attempt == max_retries:
                    print("   重试次数已用完，尝试备用方案...")
                elif attempt < max_retries:
                    print(f"   将在 {attempt + 1} 次重试时重试...")

            # 如果不是最后一次重试，继续重试
            if attempt < max_retries:
                continue

            # 备用方案：使用Google Cloud Vertex AI API
            try:
                if attempt == 0:
                    print("[BACKUP] 尝试使用Vertex AI REST API...")

                # 构建Vertex AI请求
                import vertexai
                from vertexai.preview.vision_models import ImageGenerationModel

                # 初始化Vertex AI
                vertexai.init(project="your-project-id", location="us-central1")

                model = ImageGenerationModel.from_pretrained(model_name)

                # 生成图像
                images = model.generate_images(
                    prompt=prompt[:500],
                    number_of_images=1,
                    aspect_ratio="1:1",
                    safety_filter_level="block_some",
                    person_generation="allow_adult"
                )

                if images and len(images) > 0:
                    # 保存第一张图像
                    import tempfile
                    import uuid

                    temp_dir = tempfile.gettempdir()
                    temp_file = os.path.join(temp_dir, f"comic_vertex_{uuid.uuid4().hex[:8]}.png")

                    images[0].save(temp_file)

                    print(f"[OK] Vertex AI图像生成成功")
                    print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
                    return temp_file

            except Exception as vertex_error:
                print(f"[WARNING]  Vertex AI失败: {vertex_error}")
                if attempt == max_retries:
                    print("   尝试使用简单的REST API调用...")

            # 如果不是最后一次重试，继续重试
            if attempt < max_retries:
                continue

            # 最终备用方案：使用简单的REST API调用
            if attempt == 0:
                print("[FINAL] 尝试使用简单的REST API调用...")

            # Google Cloud Imagen API端点
            api_endpoint = "https://us-central1-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/imagen-3.0-generate-001:predict"

            # 由于需要项目ID和认证，这里简化处理
            # 在实际使用中，用户需要配置正确的项目ID和认证

            print("[INFO]  Google图像生成需要配置Google Cloud项目，请参考文档进行设置")
            print("   提示: 您需要设置Google Cloud项目并启用Imagen API")

            return None

        except ImportError:
            print("[ERROR]  google-genai库未安装")
            print("   请安装: pip install google-genai")
            return None
        except Exception as e:
            print(f"[ERROR]  Google图像生成失败 (尝试 {attempt + 1}/{max_retries + 1}): {e}")
            if attempt < max_retries:
                print(f"   将重试...")
                time.sleep(2)  # 短暂等待后重试
            else:
                print(f"   重试次数已用完")
                safe_print_exc()
                return None

    return None

def call_tuzi_image_api(prompt: str, reference_image_path=None, room_id: Optional[str] = None) -> Optional[str]:
    """
    Generate comic images through configured OpenAI-compatible image routes.
    The legacy tuZi config is still used when no route list is configured.
    """
    config = load_config()
    tuzi_config = config["aiServices"].get("tuZi", {})

    if reference_image_path:
        if isinstance(reference_image_path, list):
            valid_images = [img for img in reference_image_path if os.path.exists(img)]
            if valid_images:
                print(f"[IMAGE_PROVIDER] Reference images: {len(valid_images)}")
                for idx, img in enumerate(valid_images, 1):
                    print(f"  {idx}. {os.path.basename(img)}")
            else:
                print("[IMAGE_PROVIDER] No valid reference images")
        elif isinstance(reference_image_path, str) and os.path.exists(reference_image_path):
            print(f"[IMAGE_PROVIDER] Reference image: {os.path.basename(reference_image_path)}")
        else:
            print("[IMAGE_PROVIDER] No valid reference images")
    else:
        print("[IMAGE_PROVIDER] No reference images")

    timeout_ms = config.get("timeouts", {}).get("aiApiTimeout", 360000)
    if tuzi_config.get("model", "gpt-image-2") in ("gpt-image-2", "gpt-image-1.5", "gpt-image-1"):
        timeout_ms = max(timeout_ms, 1000000)
    timeout_sec = timeout_ms / 1000

    routes = _get_image_generation_routes(config, tuzi_config, room_id)
    route_labels = [f"{route.get('provider', 'tuZi')}:{route.get('model', 'gpt-image-2')}" for route in routes]
    route_attempts = []
    print(f"[IMAGE_PROVIDER] Image generation routes: {route_labels}")

    for index, route in enumerate(routes, 1):
        provider_name = route.get("provider") or "tuZi"
        provider = _resolve_image_provider_config(config, provider_name)
        model = route.get("model") or "gpt-image-2"
        attempts = _int_config(route.get("maxAttempts"), 1, 1)
        route_timeout_sec = _route_timeout_seconds(route, timeout_sec)

        for attempt in range(attempts):
            print(
                f"[IMAGE_PROVIDER] Route {index}/{len(routes)} attempt {attempt + 1}/{attempts}: "
                f"{provider_name}:{model}, flow={route.get('flow', 'openaiImages')}, timeout={route_timeout_sec}s"
            )
            reset_last_image_generation_meta()
            result = _call_image_generation_route(
                route=route,
                provider=provider,
                prompt=prompt,
                reference_image_path=reference_image_path,
                room_id=str(room_id) if room_id else None,
                timeout_sec=route_timeout_sec,
            )
            last_meta = get_last_image_generation_meta()
            failure_reason = None if result else _summarize_image_generation_failure(
                last_meta,
                f"{provider_name}:{model} returned no image",
            )
            if failure_reason:
                print(f"[IMAGE_PROVIDER] Route failed: {provider_name}:{model} attempt {attempt + 1}/{attempts}: {failure_reason}")
            route_attempts.append({
                "provider": provider_name,
                "model": model,
                "attempt": attempt + 1,
                "status": "success" if result else "failure",
                "reason": failure_reason,
            })
            if result:
                annotate_last_image_generation_meta(
                    provider=provider_name,
                    routeAttempts=route_attempts,
                )
                return result

    annotate_last_image_generation_meta(
        status="failure",
        endpoint="imageGenerationRoutes",
        reason="All configured image generation routes failed",
        routeAttempts=route_attempts,
    )
    return None


def call_huggingface_comic_factory(prompt: str, reference_image_path: Optional[str] = None) -> Optional[str]:
    """
    调用Hugging Face AI Comic Factory API
    使用更可靠的备用方案，因为gradio_client可能有连接问题
    """
    config = load_config()
    hf_config = config["aiServices"]["huggingFace"]
    
    if not is_huggingface_configured():
        raise ValueError("Hugging Face API未配置，请检查config.json中的apiToken")
    
    print("[ART] 调用Hugging Face AI Comic Factory生成漫画...")
    
    # 获取代理配置
    proxy_url = hf_config.get("proxy", "")
    
    # 设置代理
    proxies = {}
    if proxy_url:
        proxies = {
            "http": proxy_url,
            "https": proxy_url
        }
        print(f"[PROXY] 使用代理: {proxy_url}")
    
    try:
        # 方案1：尝试使用gradio_client（如果可用）
        try:
            from gradio_client import Client
            
            # 设置环境变量
            if proxy_url:
                import os
                os.environ["HTTP_PROXY"] = proxy_url
                os.environ["HTTPS_PROXY"] = proxy_url
                os.environ["http_proxy"] = proxy_url
                os.environ["https_proxy"] = proxy_url
            
            print("[GRADIO] 尝试使用gradio_client连接...")
            client = Client(hf_config["comicFactoryModel"], verbose=False)
            
            # 准备参数
            params = {
                "prompt": prompt,
                "style": "Japanese Manga",  # 漫画风格
                "layout": "Neutral",        # 布局风格
            }
            
            print("[WAIT] 正在生成漫画，这可能需要几分钟...")
            result = client.predict(**params)
            
            # 处理返回结果
            if result and isinstance(result, (str, list)):
                print("[OK] 漫画生成成功 (gradio_client)")
                return str(result[0] if isinstance(result, list) else result)
            else:
                print("[WARNING]  生成结果格式异常")
                # 继续尝试备用方案
                raise ValueError("gradio_client返回结果格式异常")
                
        except Exception as gradio_error:
            print(f"[WARNING]  gradio_client失败: {gradio_error}")
            print("   切换到备用方案...")
            
    except ImportError:
        print("[WARNING]  gradio_client未安装，使用备用方案")
    
    # 方案2：使用Hugging Face Router API（备用方案）
    print("[BACKUP] 使用Hugging Face Router API备用方案...")
    
    try:
        # 使用新的router API端点
        router_url = "https://router.huggingface.co/hf-inference/models"
        
        # 使用一个稳定的文本到图像模型
        model_name = "stabilityai/stable-diffusion-xl-base-1.0"
        
        # 构建请求
        headers = {
            "Authorization": f"Bearer {hf_config['apiToken']}",
            "Content-Type": "application/json"
        }
        
        # 构建更简单的提示词
        simple_prompt = f"Anime style comic panel, cute character, colorful: {prompt[:150]}"
        
        payload = {
            "inputs": simple_prompt,
            "parameters": {
                "num_inference_steps": 20,
                "guidance_scale": 7.5,
                "width": 512,
                "height": 512
            }
        }
        
        # 完整的API URL
        api_url = f"{router_url}/{model_name}"
        
        print(f"[WAIT] 通过Router API生成图像 (模型: {model_name})...")
        response = requests.post(api_url, headers=headers, json=payload, timeout=180, proxies=proxies)
        
        if response.status_code == 200:
            print("[OK] 图像生成成功 (Router API)")
            
            # 保存图像
            import tempfile
            import uuid
            
            # 创建临时文件
            temp_dir = tempfile.gettempdir()
            temp_file = os.path.join(temp_dir, f"comic_{uuid.uuid4().hex[:8]}.png")
            
            with open(temp_file, 'wb') as f:
                f.write(response.content)
            
            print(f"[SAVE] 图像已保存到临时文件: {temp_file}")
            return temp_file
            
        elif response.status_code == 503:
            print("[INFO]  模型正在加载，请稍后重试")
            print("   响应: " + response.text[:200])
            return None
        else:
            print(f"[ERROR] API调用失败: {response.status_code}")
            print(f"   响应头: {dict(response.headers)}")
            print(f"   响应内容: {response.text[:500]}")
            
            # 尝试使用更简单的模型
            print("[RETRY] 尝试使用更简单的模型...")
            return try_simpler_model(prompt, hf_config, proxies)
            
    except Exception as e:
        print(f"[ERROR] 备用方案也失败: {e}")
        safe_print_exc()
        return None

def save_comic_result(output_path: str, comic_data: Any) -> str:
    """保存漫画结果"""
    try:
        # 生成不重复的文件名
        unique_path = generate_unique_filename(output_path)
        
        # 如果comic_data是文件路径，复制文件
        if isinstance(comic_data, str) and os.path.exists(comic_data):
            print(f"[COPY] 复制漫画图片: {os.path.basename(comic_data)}")
            import shutil
            shutil.copy2(comic_data, unique_path)
            print(f"[OK] 漫画图片已保存: {os.path.basename(unique_path)}")
            return unique_path
        
        # 如果comic_data是URL，下载图片
        elif isinstance(comic_data, str) and comic_data.startswith(('http://', 'https://')):
            print(f"[DOWNLOAD] 下载漫画图片: {comic_data}")
            response = requests.get(comic_data, timeout=60)
            if response.status_code == 200:
                with open(unique_path, 'wb') as f:
                    f.write(response.content)
                print(f"[OK] 漫画图片已保存: {os.path.basename(unique_path)}")
                return unique_path
            else:
                raise ValueError(f"下载失败: {response.status_code}")
        
        # 如果comic_data是base64编码的图片
        elif isinstance(comic_data, str) and len(comic_data) > 100 and 'data:image' in comic_data:
            # 提取base64数据
            import re
            match = re.search(r'base64,(.+)', comic_data)
            if match:
                image_data = base64.b64decode(match.group(1))
                with open(unique_path, 'wb') as f:
                    f.write(image_data)
                print(f"[OK] 漫画图片已保存: {os.path.basename(unique_path)}")
                return unique_path
        
        # 其他情况，直接保存为文本（可能是错误信息或文本结果）
        else:
            with open(unique_path, 'w', encoding='utf-8') as f:
                f.write(str(comic_data))
            print(f"[OK] 漫画结果已保存为文本: {os.path.basename(unique_path)}")
            return unique_path
            
    except Exception as e:
        print(f"[ERROR] 保存漫画结果失败: {e}")
        raise


def comic_meta_path(output_path: str) -> str:
    root, _ = os.path.splitext(output_path)
    return f"{root}_META.json"


def write_comic_generation_meta(output_path: str, meta: Dict[str, Any]) -> None:
    try:
        payload = {
            "status": meta.get("status") or "unknown",
            "provider": meta.get("provider"),
            "model": meta.get("model"),
            "endpoint": meta.get("endpoint"),
            "reason": meta.get("reason"),
            "requestIds": meta.get("requestIds") or [],
            "lastRequestId": meta.get("lastRequestId"),
            "lastResponseId": meta.get("lastResponseId"),
            "attempts": meta.get("attempts") or [],
            "routeAttempts": meta.get("routeAttempts") or [],
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        with open(comic_meta_path(output_path), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"[INFO] 生图元数据已保存: {os.path.basename(comic_meta_path(output_path))}")
    except Exception as e:
        print(f"[WARNING] 保存生图元数据失败: {e}")


def comic_script_meta_path(text_output_path: str) -> str:
    root, _ = os.path.splitext(text_output_path)
    return f"{root}_META.json"


def write_comic_script_meta(
    text_output_path: str,
    meta: Dict[str, Any],
    room_id: Optional[str] = None,
    highlight_content: Optional[str] = None,
    appeared_streamer_ids: Optional[list[str]] = None,
    live_context: Optional[Dict[str, Any]] = None,
) -> None:
    try:
        payload = {
            "schemaVersion": 3,
            "policyVersion": COMIC_SCRIPT_POLICY_VERSION,
            "status": meta.get("status") or "unknown",
            "provider": meta.get("provider"),
            "model": meta.get("model"),
            "fallback": bool(meta.get("fallback")),
            "reason": meta.get("reason"),
            "roomId": str(room_id) if room_id is not None else None,
            "highlightSha256": hashlib.sha256((highlight_content or "").encode("utf-8")).hexdigest() if highlight_content is not None else None,
            "liveContextSha256": hash_live_generation_context(live_context),
            "appearedStreamerIds": sorted({
                str(streamer_id)
                for streamer_id in (appeared_streamer_ids or [])
                if str(streamer_id)
            }),
            "updatedAt": meta.get("updatedAt") or time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        with open(comic_script_meta_path(text_output_path), "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"[INFO] 漫画脚本文本元数据已保存: {os.path.basename(comic_script_meta_path(text_output_path))}")
    except Exception as e:
        print(f"[WARNING] 保存漫画脚本文本元数据失败: {e}")

def generate_comic_from_highlight(highlight_path: str, room_id: Optional[str] = None) -> Optional[str]:
    """从AI_HIGHLIGHT文件生成漫画"""
    print(f"[FILE] 处理AI_HIGHLIGHT文件: {os.path.basename(highlight_path)}")
    
    config = load_config()
    
    # 设置API启用状态
    # 注意：这里检查的是图像生成API的启用状态，不是文本生成API
    use_google = config["aiServices"].get("googleImage", {}).get("enabled", False)
    use_tuzi = config["aiServices"].get("tuZi", {}).get("enabled", False)
    lock_path = None
    lock_acquired = False
    
    try:
        # 检查输入文件
        if not os.path.exists(highlight_path):
            raise FileNotFoundError(f"AI_HIGHLIGHT文件不存在: {highlight_path}")

        dir_name = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')
        output_path = os.path.join(dir_name, f"{base_name}_COMIC_FACTORY.png")
        existing_output = get_existing_generated_file(output_path)
        if existing_output:
            print(f"[INFO]  漫画已存在，跳过重复生成: {os.path.basename(existing_output)}")
            return existing_output

        # 默认开启输出锁。同一高亮可能由多个后台进程同时处理，单靠“文件已存在”
        # 检查挡不住竞态，必须在首次图片 API 调用前抢占同一个输出锁。
        output_lock_enabled = bool(config.get("ai", {}).get("comic", {}).get("outputLockEnabled", True))
        if output_lock_enabled:
            lock_path = output_path + ".lock"
            lock_acquired = acquire_generation_lock(lock_path)
            if not lock_acquired:
                print(f"[WAIT] 漫画正在由其他进程生成，等待结果: {os.path.basename(output_path)}")
                generated_by_other_process = wait_for_generated_file(output_path, lock_path)
                if generated_by_other_process:
                    print(f"[OK] 复用其他进程生成的漫画: {os.path.basename(generated_by_other_process)}")
                    return generated_by_other_process
                print("[WARNING] 等待漫画生成超时，跳过本次重复生成")
                write_comic_generation_meta(output_path, {
                    "status": "failure",
                    "model": None,
                    "endpoint": "output-lock",
                    "reason": "waiting for another comic generation process timed out",
                    "attempts": [],
                })
                return None
        else:
            print("[INFO]  漫画输出锁已关闭，允许并发生成")
        
        # 提取房间ID（优先使用传入的 room_id，其次从文件名提取）
        if room_id is None:
            filename = os.path.basename(highlight_path)
            file_room_id = extract_room_id_from_filename(filename)
            room_id = file_room_id or "unknown"

        if not room_id or str(room_id).strip() == '':
            print("[WARNING]  无法确定房间ID，使用 'unknown'")
            room_id = "unknown"

        print(f"[ROOM] 房间ID: {room_id}")
        
        # 检查房间是否启用漫画生成
        room_str = str(room_id)
        if room_str in config["roomSettings"]:
            if not config["roomSettings"][room_str].get("enableComicGeneration", True):
                print(f"[INFO]  房间 {room_id} 的漫画生成功能已禁用")
                write_comic_generation_meta(output_path, {
                    "status": "failure",
                    "model": None,
                    "endpoint": "room-settings",
                    "reason": f"comic generation disabled for room {room_id}",
                    "attempts": [],
                })
                return None
        
        # 读取内容
        highlight_content = read_highlight_file(highlight_path)
        live_context = load_live_generation_context(highlight_path, room_id, config)
        live_context_hash = hash_live_generation_context(live_context)
        print(
            f"[CONTEXT] 漫画采用本场事实上下文: 标题={live_context.get('liveTitle') or '未取得'}, "
            f"近期动态={len(live_context.get('recentDynamics') or [])}条"
        )
        script_highlight_content = sanitize_highlight_for_comic_script(highlight_content, room_id, config)
        script_highlight_hash = hashlib.sha256(script_highlight_content.encode("utf-8")).hexdigest()
        script_extra_streamers = resolve_extra_appeared_streamers(
            config,
            room_id,
            highlight_path,
            include_mentioned_streamers=False,
        )
        script_appeared_ids = sorted({
            str(item.get("id") or "")
            for item in script_extra_streamers
            if str(item.get("id") or "")
        })
        print(f"[BOOK] 读取内容完成 ({len(highlight_content)} 字符)")

        # 确定脚本文件路径，优先复用已存在的脚本以避免重复AI调用
        text_output_path = os.path.join(dir_name, f"{base_name}_COMIC_SCRIPT.txt")

        comic_text = None
        existing_comic_invalidated = False
        if os.path.exists(text_output_path):
            try:
                with open(text_output_path, 'r', encoding='utf-8') as tf:
                    comic_text = tf.read()
                meta_path = comic_script_meta_path(text_output_path)
                meta = {}
                if os.path.exists(meta_path):
                    with open(meta_path, 'r', encoding='utf-8') as mf:
                        meta = json.load(mf)
                metadata_matches = (
                    meta.get("schemaVersion") == 3
                    and meta.get("policyVersion") == COMIC_SCRIPT_POLICY_VERSION
                    and meta.get("roomId") == str(room_id)
                    and meta.get("highlightSha256") == script_highlight_hash
                    and meta.get("liveContextSha256") == live_context_hash
                    and sorted(meta.get("appearedStreamerIds") or []) == script_appeared_ids
                )
                if is_valid_comic_script(comic_text) and metadata_matches:
                    print(f"[INFO]  已存在漫画脚本，复用: {os.path.basename(text_output_path)}")
                else:
                    print(f"[WARNING]  已存在漫画脚本无效或元数据过期，重新生成: {os.path.basename(text_output_path)}")
                    comic_text = None
                    existing_comic_invalidated = True
            except Exception as e:
                print(f"[WARNING]  读取已存在漫画脚本失败，重新生成: {e}")

        # 构建提示词（包含漫画内容生成），如果已有脚本则复用
        prompt, comic_text, is_comic_generated = build_comic_prompt(
            highlight_content,
            None,
            room_id,
            existing_comic=comic_text,
            extra_streamers=script_extra_streamers,
            live_context=live_context,
        )

        # 如果脚本生成失败（使用原文作为备选），则不生成图片
        if not is_comic_generated:
            script_meta = get_comic_script_meta()
            script_reason = script_meta.get("reason") or "漫画脚本生成失败"
            script_provider = script_meta.get("provider")
            script_model = script_meta.get("model")
            print(f"[ERROR] 漫画脚本生成失败，跳过图像生成 (原因: {script_reason})")
            print("[[COMIC_SCRIPT_READY]] status=failure")
            write_comic_generation_meta(output_path, {
                "status": "failure",
                "model": script_model,
                "endpoint": "comic-script",
                "reason": script_reason,
                "attempts": get_last_image_generation_meta().get("attempts") or [],
            })
            return None

        image_extra_streamers = resolve_image_prompt_extra_streamers(
            config,
            room_id,
            highlight_path,
            comic_text,
        )
        all_images = collect_all_images(room_id, highlight_path, extra_streamers=image_extra_streamers)
        reference_image_path = all_images if all_images else None
        prompt, comic_text, is_comic_generated = build_comic_prompt(
            highlight_content,
            reference_image_path,
            room_id,
            existing_comic=comic_text,
            extra_streamers=image_extra_streamers,
            live_context=live_context,
        )
        if all_images:
            print(f"[IMAGE] 根据漫画脚本收集到 {len(all_images)} 张图片，将全部传入AI:")
            for idx, img_path in enumerate(all_images, 1):
                img_name = os.path.basename(img_path)
                print(f"  ✓ {idx}. {img_name}")
        else:
            print("[WARNING] 未找到任何可用图片，将仅使用提示词生成")

        # 图像生成成功，现在保存漫画脚本（只在真正生成脚本时保存，不保存原文备选）
        try:
            if (not os.path.exists(text_output_path) or existing_comic_invalidated) and comic_text and is_comic_generated:
                with open(text_output_path, 'w', encoding='utf-8') as tf:
                    tf.write(comic_text)
                print(f"[OK] 漫画脚本已保存: {os.path.basename(text_output_path)}")
                write_comic_script_meta(
                    text_output_path,
                    get_comic_script_meta(),
                    room_id,
                    script_highlight_content,
                    script_appeared_ids,
                    live_context,
                )
            elif os.path.exists(text_output_path) and not os.path.exists(comic_script_meta_path(text_output_path)):
                write_comic_script_meta(
                    text_output_path,
                    get_comic_script_meta(),
                    room_id,
                    script_highlight_content,
                    script_appeared_ids,
                    live_context,
                )
        except Exception as e:
            print(f"[WARNING] 保存漫画脚本失败: {e}")

        print(f"[[COMIC_SCRIPT_READY]] path={text_output_path}")

        # 调用API生成漫画（按优先级顺序）
        comic_result = None

        # 1. 优先尝试Google图像生成（带重试）
        if use_google:
            print("[GOOGLE] 使用Google图像生成API...")
            comic_result = call_google_image_api(prompt, reference_image_path)
            if comic_result:
                print(f"[DEBUG] Google API返回结果: {comic_result}")
            else:
                print("[DEBUG] Google API返回None")

        # 2. 如果Google失败，尝试tu-zi.com作为最终备用方案
        if not comic_result and use_tuzi:
            print("[TUZI] Google生成失败，尝试tu-zi.com...")
            # 传入所有收集到的图片和房间ID（用于差异化重试策略）
            comic_result = call_tuzi_image_api(prompt, all_images if all_images else None, room_id=str(room_id) if room_id else None)
            if comic_result:
                print(f"[DEBUG] tu-zi.com返回结果: {comic_result}")
            else:
                print(f"[DEBUG] tu-zi.com返回None")

        if not comic_result:
            print("[ERROR] 所有图像生成API都失败，无返回结果")
            failure_meta = get_last_image_generation_meta()
            if failure_meta.get("status") in (None, "not_started"):
                failure_meta = {
                    "status": "failure",
                    "model": None,
                    "endpoint": "all",
                    "reason": "所有图像生成API都失败，无返回结果",
                    "attempts": [],
                }
            write_comic_generation_meta(output_path, failure_meta)
            return None
        
        print(f"[DEBUG] comic_result类型: {type(comic_result)}, 内容: {comic_result}")
        
        # 确定输出路径
        print(f"[DEBUG] 输出路径: {output_path}")

        # 保存结果
        saved_path = save_comic_result(output_path, comic_result)
        success_meta = get_last_image_generation_meta()
        if success_meta.get("status") in (None, "not_started"):
            success_meta = {
                "status": "success",
                "model": "googleImage" if use_google else None,
                "endpoint": "googleImage" if use_google else None,
                "reason": "生成成功",
                "attempts": [],
            }
        write_comic_generation_meta(output_path, success_meta)
        if saved_path != output_path:
            write_comic_generation_meta(saved_path, success_meta)
        return saved_path
        
    except Exception as e:
        print(f"[ERROR] 生成漫画失败: {e}")
        safe_print_exc()
        try:
            write_comic_generation_meta(output_path, {
                "status": "failure",
                "model": None,
                "endpoint": "all",
                "reason": str(e),
                "attempts": get_last_image_generation_meta().get("attempts") or [],
            })
        except Exception:
            pass
        return None
    finally:
        if lock_acquired and lock_path:
            release_generation_lock(lock_path)

def main():
    """主函数"""
    if len(sys.argv) < 2:
        print("用法: python ai_comic_generator.py <AI_HIGHLIGHT.txt路径> [--room-id <房间ID>]")
        print("或:    python ai_comic_generator.py --batch <目录路径>")
        sys.exit(1)
    
    try:
        # 解析命令行参数
        room_id = None
        highlight_path = None
        batch_mode = False
        directory = None
        
        i = 1
        while i < len(sys.argv):
            arg = sys.argv[i]
            if arg == "--batch":
                batch_mode = True
                if i + 1 < len(sys.argv):
                    directory = sys.argv[i + 1]
                    i += 1
            elif arg == "--room-id":
                if i + 1 < len(sys.argv):
                    room_id = sys.argv[i + 1]
                    i += 1
            elif not arg.startswith("-"):
                highlight_path = arg
            i += 1
        
        if batch_mode:
            if not directory:
                print("[ERROR] 批量模式需要指定目录")
                sys.exit(1)
                
            print(f"[SEARCH] 批量处理目录: {directory}")
            
            if not os.path.exists(directory):
                print(f"[ERROR] 目录不存在: {directory}")
                sys.exit(1)
            
            highlight_files = []
            for root, dirs, files in os.walk(directory):
                for file in files:
                    if file.endswith("_AI_HIGHLIGHT.txt"):
                        highlight_files.append(os.path.join(root, file))
            
            print(f"找到 {len(highlight_files)} 个AI_HIGHLIGHT文件")
            
            success_count = 0
            for i, file_path in enumerate(highlight_files, 1):
                print(f"\n--- [{i}/{len(highlight_files)}] 处理: {os.path.basename(file_path)} ---")
                try:
                    result = generate_comic_from_highlight(file_path, room_id)
                    if result:
                        success_count += 1
                        print(f"[OK] 成功生成: {os.path.basename(result)}")
                    else:
                        print("[ERROR] 生成失败")
                except Exception as e:
                    print(f"[ERROR] 处理失败: {e}")
            
            print(f"\n[CHART] 批量处理完成:")
            print(f"   [OK] 成功: {success_count} 个")
            print(f"   [ERROR] 失败: {len(highlight_files) - success_count} 个")
            
        else:
            if not highlight_path:
                print("[ERROR] 需要指定AI_HIGHLIGHT文件路径")
                sys.exit(1)
                
            result = generate_comic_from_highlight(highlight_path, room_id)
            
            if result:
                print(f"\n[CELEBRATE] 处理完成，输出文件: {result}")
            else:
                print("\n[INFO]  未生成任何文件（已安全完成，退出码 0）")
                sys.exit(0)
                
    except Exception as e:
        print(f"[EXPLOSION] 处理失败: {e}")
        safe_print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
