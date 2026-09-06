"""Reference-image ordering, fallback selection, and input provenance."""

import os
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional


@dataclass(frozen=True)
class ImageInputContext:
    config: Dict[str, Any]
    scripts_dir: str
    project_root: str
    multi_config: Dict[str, Any]
    reference_policy: Dict[str, Any]
    exclude_screenshots: bool
    host_resolver: Callable[[], Optional[dict]]
    resolve_path: Callable[[str], Optional[str]]
    cover_resolver: Callable[[str], Optional[str]]
    log: Callable[..., None] = print


def collect_all_images(
    room_id: str,
    highlight_path: Optional[str] = None,
    extra_streamers: Optional[list[dict]] = None,
    directed_screenshots: Optional[list[dict]] = None,
    screenshot_mode: str = "contact_sheet",
    image_manifest: Optional[list[dict]] = None,
    max_total_images: Optional[int] = None,
    *,
    context: ImageInputContext,
) -> list[str]:
    """收集所有可用的图片（引用图、封面、截图）用于AI输入
    
    返回图片路径列表，按优先级排序：
    1. 主播参考图（roomSettings中配置的referenceImage）
    2. 已确认出声及脚本需要的额外人物参考图；人物身份锚点优先于直播证据
    3. 脚本定向直播证据；超出图片额度时从低优先级截图开始截断
    4. 直播封面（.cover文件）
    5. 旧版固定时间截图拼图（_SCREENSHOTS.jpg，或独立关键帧失败时兜底）
    6. 默认参考图（只有在没有主播参考图、封面、截图且配置了 defaultReferenceImage 时才使用）
    7. 没有配置默认参考图时返回空列表，让模型无参考图生成
    """
    images = []
    seen_images = set()

    def add_image(image_path: str, log_message: str, **metadata: Any) -> bool:
        real_path = os.path.abspath(image_path)
        if real_path in seen_images:
            context.log(f"[INFO]  跳过重复图片: {os.path.basename(real_path)}")
            return False
        images.append(real_path)
        seen_images.add(real_path)
        if image_manifest is not None:
            manifest_item = {
                "path": real_path,
                "fileBytes": os.path.getsize(real_path),
                **metadata,
            }
            try:
                from PIL import Image
                with Image.open(real_path) as image:
                    width, height = image.size
                manifest_item.update({
                    "width": width,
                    "height": height,
                    "pixels": width * height,
                })
            except (OSError, ValueError, ImportError):
                pass
            image_manifest.append(manifest_item)
        context.log(log_message)
        return True

    config = context.config
    scripts_dir = context.scripts_dir
    project_root = context.project_root
    multi_config = context.multi_config
    reference_policy = context.reference_policy
    exclude_screenshots = context.exclude_screenshots
    if exclude_screenshots:
        context.log(f"[INFO] 房间 {room_id} 按静态视频检测跳过直播截图")
    if not multi_config.get("enabled"):
        extra_streamers = []
    if max_total_images is None:
        max_total_images = int(multi_config.get("maxTotalImages") or 4)
    else:
        try:
            max_total_images = max(1, min(12, int(max_total_images)))
        except (TypeError, ValueError):
            max_total_images = int(multi_config.get("maxTotalImages") or 4)

    directed_candidates = [
        screenshot for screenshot in (directed_screenshots or [])
        if isinstance(screenshot, dict)
    ]
    if exclude_screenshots:
        directed_candidates = []

    def directed_priority(indexed_screenshot: tuple[int, dict]) -> tuple[int, int]:
        index, screenshot = indexed_screenshot
        is_requested_sheet = screenshot.get("requestSource") == "script_reference_sheet"
        is_requested_detail = screenshot.get("selectionMode") == "script_requested"
        if is_requested_detail:
            return (0, index)
        if is_requested_sheet:
            return (1, index)
        return (2, index)

    directed_candidates = [
        screenshot
        for _, screenshot in sorted(
            enumerate(directed_candidates),
            key=directed_priority,
        )
    ]
    
    # 1. 尝试获取主播参考图（roomSettings中配置的）
    room_str = str(room_id)
    has_anchor_image = False
    
    if room_str in config["roomSettings"]:
        room_config = config["roomSettings"][room_str]
        configured_room_images = list(room_config.get("referenceImages") or [])
        if room_config.get("referenceImage"):
            configured_room_images.insert(0, room_config["referenceImage"])
        for ref_image in configured_room_images:
            # 尝试相对于项目根目录的路径
            absolute_path = os.path.join(project_root, ref_image) if not os.path.isabs(ref_image) else ref_image
            if os.path.exists(absolute_path):
                add_image(absolute_path, f"[INFO]  收集到主播参考图: {os.path.basename(absolute_path)}", role="host")
                has_anchor_image = True
                continue
            else:
                # 尝试相对于脚本目录的路径
                script_relative = os.path.join(scripts_dir, ref_image) if not os.path.isabs(ref_image) else ref_image
                if os.path.exists(script_relative):
                    add_image(script_relative, f"[INFO]  收集到主播参考图: {os.path.basename(script_relative)}", role="host")
                    has_anchor_image = True
                    continue
                else:
                    context.log(f"[WARNING] 配置的主播参考图不存在: {ref_image}")
    
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
                    add_image(file_path, f"[INFO]  收集到主播参考图: {os.path.basename(file_path)}", role="host")
                    has_anchor_image = True
                    break

    if not has_anchor_image:
        host_streamer = context.host_resolver()
        host_streamer_id = (host_streamer or {}).get("id")
        if host_streamer_id:
            for ref_image in (host_streamer or {}).get("referenceImages", []) or []:
                resolved = context.resolve_path(ref_image)
                if resolved:
                    add_image(resolved, f"[INFO]  收集到 streamerRegistry 主播参考图: {os.path.basename(resolved)}", role="host")
                    has_anchor_image = True
                    break
                context.log(f"[WARNING] streamerRegistry 主播参考图不存在: {host_streamer_id} -> {ref_image}")

    # 1.5 额外实际出声/文本提到主播参考图。只取每人第一张存在的图。
    # 人物身份参考是不可替代的锚点；截图只能使用人物图加入后的剩余额度。
    for streamer in (extra_streamers or []):
        if len(images) >= max_total_images:
            context.log(f"[INFO]  图片数量达到上限 {max_total_images}，停止加入额外主播参考图")
            break
        display_name = streamer.get("displayName") or streamer.get("id") or "unknown"
        reason = streamer.get("_comicReferenceReason") or "appeared"
        if reason == "mentioned" and not multi_config.get("includeMentionedStreamerImages", True):
            context.log(f"[INFO]  已识别文本提到主播但配置为不上传参考图: {display_name}")
            continue
        reference_images = streamer.get("referenceImages", []) or []
        if not reference_images:
            context.log(f"[INFO]  额外主播未配置参考图，将按文字描述生成: {display_name}")
            continue
        added = False
        for ref_image in reference_images:
            resolved = context.resolve_path(ref_image)
            if resolved:
                reason_label = "文本提到主播" if reason == "mentioned" else "实际出声主播"
                added = add_image(
                    resolved,
                    f"[INFO]  收集到额外{reason_label}参考图: {display_name} -> {os.path.basename(resolved)}",
                    role="mentioned_streamer" if reason == "mentioned" else "appeared_streamer",
                    displayName=display_name,
                    streamerId=str(streamer.get("id") or "") or None,
                )
                break
            context.log(f"[WARNING] 额外主播参考图不存在: {display_name} -> {ref_image}")
        if not added:
            context.log(f"[WARNING] 额外主播没有可用参考图: {display_name}")
    
    # 2. 优先加入脚本时间点对应的定向关键帧。
    directed_added = False
    if screenshot_mode == "individual":
        for screenshot in directed_candidates:
            screenshot_path = str(screenshot.get("path") or "")
            if not screenshot_path or not os.path.exists(screenshot_path):
                continue
            if len(images) >= max_total_images:
                context.log(f"[INFO]  图片数量达到保守上限 {max_total_images}，停止加入定向直播关键帧")
                break
            directed_added = add_image(
                screenshot_path,
                f"[INFO]  收集到定向直播关键帧: {os.path.basename(screenshot_path)}",
                role="directed_screenshot",
                timestampSeconds=screenshot.get("timestampSeconds"),
                timestampsSeconds=screenshot.get("timestampsSeconds"),
                selectedTimestampSeconds=screenshot.get("selectedTimestampSeconds"),
                scene=screenshot.get("scene"),
                visualIntent=screenshot.get("visualIntent"),
                referenceUsage=screenshot.get("referenceUsage"),
                referenceRequestId=screenshot.get("referenceRequestId"),
                requestSource=screenshot.get("requestSource"),
                evidenceRole=screenshot.get("evidenceRole"),
                mustShow=screenshot.get("mustShow"),
                captureMode=screenshot.get("captureMode"),
                windowStartSeconds=screenshot.get("windowStartSeconds"),
                windowEndSeconds=screenshot.get("windowEndSeconds"),
                candidateIndex=screenshot.get("candidateIndex"),
                candidateCount=screenshot.get("candidateCount"),
                selectionMode=screenshot.get("selectionMode"),
                coverageCandidateTimestampsSeconds=screenshot.get("coverageCandidateTimestampsSeconds"),
                bestCandidateTimestampSeconds=screenshot.get("bestCandidateTimestampSeconds"),
                bestCandidateLabel=screenshot.get("bestCandidateLabel"),
                bestCandidateScore=screenshot.get("bestCandidateScore"),
                bestCandidateIndex=screenshot.get("bestCandidateIndex"),
                bestCandidateSelectionMode=screenshot.get("bestCandidateSelectionMode"),
                visionSelectionConfidence=screenshot.get("visionSelectionConfidence"),
                visionSelectionReason=screenshot.get("visionSelectionReason"),
            ) or directed_added

    # 3. 独立关键帧优先于封面；旧版仍保持“角色图 -> 封面 -> 拼图”的顺序。
    has_cover = False
    if reference_policy["allowLiveCover"] and highlight_path and (screenshot_mode != "individual" or not directed_added or len(images) < max_total_images):
        cover_image = context.cover_resolver(highlight_path)
        if cover_image and len(images) < max_total_images:
            add_image(
                cover_image,
                f"[INFO]  收集到直播封面: {os.path.basename(cover_image)}",
                role="cover",
            )
            has_cover = True
        elif cover_image:
            context.log(f"[INFO]  图片数量达到保守上限 {max_total_images}，跳过直播封面: {os.path.basename(cover_image)}")

    # 4. 没有可用定向关键帧时，降级使用固定时间截图拼图。
    screenshot_path = os.environ.get('SCREENSHOT_PATH', '')
    should_use_contact_sheet = not exclude_screenshots and (screenshot_mode != "individual" or not directed_added)
    if should_use_contact_sheet and screenshot_path and os.path.exists(screenshot_path) and len(images) < max_total_images:
        add_image(
            screenshot_path,
            f"[INFO]  收集到直播截图拼图: {os.path.basename(screenshot_path)}",
            role="contact_sheet",
        )
    elif should_use_contact_sheet and screenshot_path and os.path.exists(screenshot_path):
        context.log(f"[INFO]  图片数量达到保守上限 {max_total_images}，跳过直播截图: {os.path.basename(screenshot_path)}")
    
    # 如果没有截图路径，尝试从highlight_path推断
    if should_use_contact_sheet and not screenshot_path and highlight_path:
        dir_path = os.path.dirname(highlight_path)
        base_name = os.path.basename(highlight_path).replace('_AI_HIGHLIGHT.txt', '')
        inferred_screenshot = os.path.join(dir_path, f"{base_name}_SCREENSHOTS.jpg")
        if os.path.exists(inferred_screenshot) and len(images) < max_total_images:
            add_image(
                inferred_screenshot,
                f"[INFO]  收集到推断的直播截图拼图: {os.path.basename(inferred_screenshot)}",
                role="contact_sheet",
            )
        elif os.path.exists(inferred_screenshot):
            context.log(f"[INFO]  图片数量达到保守上限 {max_total_images}，跳过推断的直播截图: {os.path.basename(inferred_screenshot)}")
    
    # 4. 只有在完全没有任何图片时，才使用默认参考图（兜底）
    # 检查是否已经收集到任何图片（主播参考图、封面、截图）
    if len(images) == 0:
        context.log("[INFO]  未找到任何图片（主播参考图、封面、截图），检查是否配置默认参考图...")
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
                add_image(
                    absolute_path,
                    f"[INFO]  收集到默认参考图（兜底）: {os.path.basename(absolute_path)}",
                    role="default",
                )
            else:
                # 尝试相对于脚本目录的路径
                script_relative = os.path.join(scripts_dir, default_image) if not os.path.isabs(default_image) else default_image
                if os.path.exists(script_relative):
                    add_image(
                        script_relative,
                        f"[INFO]  收集到默认参考图（兜底）: {os.path.basename(script_relative)}",
                        role="default",
                    )
        if not default_image:
            context.log("[INFO]  未配置默认参考图，将无参考图生成")
    else:
        context.log(f"[INFO]  已有 {len(images)} 张图片，跳过默认参考图")
    
    context.log(f"[INFO]  共收集到 {len(images)} 张图片用于AI输入")
    return images
