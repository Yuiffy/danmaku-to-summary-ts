"""Image-route policy and bounded attempts with injected provider operations."""

import os
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional


@dataclass(frozen=True)
class ImageRouteIO:
    compatible: Callable[..., Optional[str]]
    images: Callable[..., Optional[str]]
    reset_metadata: Callable[[], None]
    read_metadata: Callable[[], Dict[str, Any]]
    annotate_metadata: Callable[..., None]
    log: Callable[..., None] = print


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
    recovery_state_path: Optional[str] = None,
    *,
    io: ImageRouteIO,
) -> Optional[str]:
    provider_name = provider.get("name") or route.get("provider") or "unknown"
    model = route.get("model") or "gpt-image-2"
    flow = route.get("flow") or "openaiImages"
    proxy_url = route.get("proxy", provider.get("proxy", ""))

    if (provider.get("type") or "openai").lower() not in ("openai", "openai-compatible", "openai_compatible"):
        io.log(f"[IMAGE_PROVIDER] Skip unsupported provider type: {provider_name} ({provider.get('type')})")
        return None

    if not provider.get("baseUrl") or not provider.get("apiKey"):
        io.log(f"[IMAGE_PROVIDER] Skip unconfigured provider: {provider_name}")
        return None

    if flow in ("tuZiCompatible", "tuziCompatible", "tuzi"):
        return io.compatible(
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
            recovery_state_path=recovery_state_path,
        )

    return io.images(
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


def generate_image(
    prompt: str,
    reference_image_path=None,
    room_id: Optional[str] = None,
    recovery_state_path: Optional[str] = None,
    *,
    config: Dict[str, Any],
    io: ImageRouteIO,
) -> Optional[str]:
    """
    Generate comic images through configured OpenAI-compatible image routes.
    The legacy tuZi config is still used when no route list is configured.
    """
    tuzi_config = config["aiServices"].get("tuZi", {})

    if reference_image_path:
        if isinstance(reference_image_path, list):
            valid_images = [img for img in reference_image_path if os.path.exists(img)]
            if valid_images:
                io.log(f"[IMAGE_PROVIDER] Reference images: {len(valid_images)}")
                for idx, img in enumerate(valid_images, 1):
                    io.log(f"  {idx}. {os.path.basename(img)}")
            else:
                io.log("[IMAGE_PROVIDER] No valid reference images")
        elif isinstance(reference_image_path, str) and os.path.exists(reference_image_path):
            io.log(f"[IMAGE_PROVIDER] Reference image: {os.path.basename(reference_image_path)}")
        else:
            io.log("[IMAGE_PROVIDER] No valid reference images")
    else:
        io.log("[IMAGE_PROVIDER] No reference images")

    timeout_ms = config.get("timeouts", {}).get("aiApiTimeout", 360000)
    if tuzi_config.get("model", "gpt-image-2") in ("gpt-image-2", "gpt-image-1.5", "gpt-image-1"):
        timeout_ms = max(timeout_ms, 1000000)
    timeout_sec = timeout_ms / 1000

    routes = _get_image_generation_routes(config, tuzi_config, room_id)
    route_labels = [f"{route.get('provider', 'tuZi')}:{route.get('model', 'gpt-image-2')}" for route in routes]
    route_attempts = []
    io.log(f"[IMAGE_PROVIDER] Image generation routes: {route_labels}")

    for index, route in enumerate(routes, 1):
        provider_name = route.get("provider") or "tuZi"
        provider = _resolve_image_provider_config(config, provider_name)
        model = route.get("model") or "gpt-image-2"
        attempts = _int_config(route.get("maxAttempts"), 1, 1)
        route_timeout_sec = _route_timeout_seconds(route, timeout_sec)

        for attempt in range(attempts):
            io.log(
                f"[IMAGE_PROVIDER] Route {index}/{len(routes)} attempt {attempt + 1}/{attempts}: "
                f"{provider_name}:{model}, flow={route.get('flow', 'openaiImages')}, timeout={route_timeout_sec}s"
            )
            io.reset_metadata()
            result = _call_image_generation_route(
                route=route,
                provider=provider,
                prompt=prompt,
                reference_image_path=reference_image_path,
                room_id=str(room_id) if room_id else None,
                timeout_sec=route_timeout_sec,
                recovery_state_path=recovery_state_path,
                io=io,
            )
            last_meta = io.read_metadata()
            failure_reason = None if result else _summarize_image_generation_failure(
                last_meta,
                f"{provider_name}:{model} returned no image",
            )
            if failure_reason:
                io.log(f"[IMAGE_PROVIDER] Route failed: {provider_name}:{model} attempt {attempt + 1}/{attempts}: {failure_reason}")
            route_attempts.append({
                "provider": provider_name,
                "model": model,
                "attempt": attempt + 1,
                "status": "success" if result else "failure",
                "reason": failure_reason,
            })
            if result:
                io.annotate_metadata(
                    provider=provider_name,
                    routeAttempts=route_attempts,
                )
                return result

    io.annotate_metadata(
        status="failure",
        endpoint="imageGenerationRoutes",
        reason="All configured image generation routes failed",
        routeAttempts=route_attempts,
    )
    return None
