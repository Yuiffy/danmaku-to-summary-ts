"""Local video evidence acquisition for comic generation, independent of providers."""

import os
import re
import shutil
import subprocess
from functools import partial
from typing import Any, Callable, Dict, Optional

from .storyboard import extract_reference_requests

VIDEO_EXTENSIONS = (".flv", ".mp4", ".mkv", ".webm", ".mov", ".ts")


def _capture_video_frame(
    ffmpeg: str,
    video_path: str,
    timestamp: float,
    output_path: str,
    width: int,
    jpeg_quality: int,
) -> subprocess.CompletedProcess:
    args = [
        ffmpeg,
        "-y",
        "-loglevel", "error",
        "-ss", f"{timestamp:.3f}",
        "-i", video_path,
        "-frames:v", "1",
        "-an",
        "-vf", f"scale={width}:-2:force_original_aspect_ratio=decrease",
        "-q:v", str(jpeg_quality),
    ]
    ffmpeg_threads = str(os.environ.get("FFMPEG_THREADS") or "").strip()
    if ffmpeg_threads.isdigit() and int(ffmpeg_threads) > 0:
        args.extend(["-threads", ffmpeg_threads])
    args.append(output_path)
    return subprocess.run(
        args,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=120,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def generate_evidence_coverage_sheets(
    highlight_path: str,
    video_path: str,
    output_dir: str,
    base_name: str,
    reference_requests: list[dict],
    screenshot_config: Dict[str, Any],
    ffmpeg: str,
    duration: Optional[float],
    max_sheets: int = 2,
    *,
    log: Callable[..., None] = print,
) -> list[dict]:
    """Render script-requested timestamps into purpose-labelled reference sheets."""
    if screenshot_config.get("coverageSheetsEnabled", True) is False or max_sheets <= 0:
        return []
    try:
        from PIL import Image, ImageDraw, ImageFont
        import tempfile
    except (ImportError, OSError, RuntimeError, SystemExit) as error:
        log(f"[WARNING] 无法生成视觉证据覆盖拼图，将继续使用独立关键帧: {error}")
        return []

    try:
        max_candidates = max(4, min(16, int(screenshot_config.get("coverageSheetMaxCandidates") or 12)))
        sheet_width = max(960, min(2560, int(screenshot_config.get("coverageSheetWidth") or 1600)))
    except (TypeError, ValueError):
        max_candidates, sheet_width = 12, 1600

    sheets = []
    sheet_requests = [
        request for request in reference_requests
        if request.get("captureMode") == "sheet"
        and len(request.get("timestampsSeconds") or []) > 1
    ]
    for request in sheet_requests:
        if len(sheets) >= max_sheets:
            break
        request_id = str(request.get("referenceRequestId") or f"E{len(sheets) + 1}")
        timestamps = [
            float(value) for value in (request.get("timestampsSeconds") or [])[:max_candidates]
            if isinstance(value, (int, float))
        ]
        if len(timestamps) < 2:
            continue

        columns = min(4, 2 if len(timestamps) <= 4 else 3)
        tile_width = sheet_width // columns
        tile_height = max(180, int(round(tile_width * 9 / 16)))
        label_height = max(24, int(round(tile_width * 0.065)))
        rows = (len(timestamps) + columns - 1) // columns
        canvas = Image.new("RGB", (tile_width * columns, rows * (tile_height + label_height)), (16, 18, 22))
        draw = ImageDraw.Draw(canvas)
        try:
            index_font = ImageFont.truetype("arialbd.ttf", max(18, int(tile_width * 0.06)))
        except OSError:
            index_font = ImageFont.load_default()
        captured_candidates = []

        with tempfile.TemporaryDirectory(prefix=f"comic_{request_id}_reference_") as temp_dir:
            for candidate_index, requested_timestamp in enumerate(timestamps):
                timestamp = requested_timestamp
                if duration is not None:
                    timestamp = min(timestamp, max(0.0, duration - 0.1))
                frame_path = os.path.join(temp_dir, f"candidate_{candidate_index:02d}.jpg")
                try:
                    result = _capture_video_frame(
                        ffmpeg, video_path, timestamp, frame_path, tile_width, 2
                    )
                    if result.returncode != 0 or not os.path.exists(frame_path):
                        continue
                    with Image.open(frame_path) as frame_image:
                        frame = frame_image.convert("RGB")
                        frame.thumbnail((tile_width, tile_height))
                        column = len(captured_candidates) % columns
                        row = len(captured_candidates) // columns
                        left = column * tile_width + (tile_width - frame.width) // 2
                        top = row * (tile_height + label_height) + (tile_height - frame.height) // 2
                        canvas.paste(frame, (left, top))
                        label_top = row * (tile_height + label_height) + tile_height
                        draw.rectangle(
                            (column * tile_width, label_top, (column + 1) * tile_width, label_top + label_height),
                            fill=(10, 12, 16),
                        )
                        visible_index = len(captured_candidates) + 1
                        badge_text = f"#{visible_index}"
                        badge_width = max(44, int(tile_width * 0.12))
                        badge_height = max(28, int(tile_width * 0.08))
                        draw.rectangle(
                            (column * tile_width, row * (tile_height + label_height),
                             column * tile_width + badge_width,
                             row * (tile_height + label_height) + badge_height),
                            fill=(8, 12, 18),
                        )
                        draw.text(
                            (column * tile_width + 7, row * (tile_height + label_height) + 2),
                            badge_text,
                            fill=(255, 224, 86),
                            font=index_font,
                        )
                        draw.text(
                            (column * tile_width + 8, label_top + 4),
                            f"{badge_text}  {timestamp / 60:g}m",
                            fill=(245, 245, 245),
                        )
                    captured_candidates.append({
                        "timestampSeconds": timestamp,
                        "candidateIndex": visible_index,
                        "label": f"{timestamp / 60:g}m",
                    })
                except (OSError, RuntimeError, ValueError, subprocess.SubprocessError):
                    continue

        if not captured_candidates:
            continue
        used_rows = (len(captured_candidates) + columns - 1) // columns
        if used_rows < rows:
            canvas = canvas.crop((0, 0, canvas.width, used_rows * (tile_height + label_height)))
        output_path = os.path.join(
            output_dir,
            f"{base_name}_EVIDENCE_REQUEST_{re.sub(r'[^A-Za-z0-9_-]+', '_', request_id)}.jpg",
        )
        canvas.save(output_path, "JPEG", quality=92, subsampling=0)
        sheet = {
            "path": output_path,
            "referenceRequestId": request_id,
            "requestSource": "script_reference_sheet",
            "timestampSeconds": captured_candidates[0]["timestampSeconds"],
            "timestampsSeconds": [
                item["timestampSeconds"] for item in captured_candidates
            ],
            "selectedTimestampSeconds": None,
            "evidenceRole": request.get("evidenceRole"),
            "mustShow": request.get("mustShow"),
            "referenceUsage": request.get("referenceUsage"),
            "captureMode": "sheet",
            "candidateIndex": None,
            "candidateCount": len(captured_candidates),
            "selectionMode": "script_requested_sheet",
            "coverageCandidateTimestampsSeconds": [
                item["timestampSeconds"] for item in captured_candidates
            ],
        }
        sheets.append(sheet)
        log(
            f"[OK] 脚本请求参考宫格: 请求={request_id}, "
            f"时间点={len(captured_candidates)} -> {os.path.basename(output_path)}"
        )
    return sheets


def infer_source_video_path(highlight_path: str, explicit_path: Optional[str] = None) -> Optional[str]:
    candidates = [explicit_path, os.environ.get("SOURCE_VIDEO_PATH")]
    base_name = os.path.basename(highlight_path).replace("_AI_HIGHLIGHT.txt", "")
    directory = os.path.dirname(highlight_path)
    candidates.extend(os.path.join(directory, f"{base_name}{extension}") for extension in VIDEO_EXTENSIONS)

    if base_name.endswith("_merged"):
        unmerged_base = re.sub(r"_merged(?:_\d+)?$", "", base_name)
        candidates.extend(os.path.join(directory, f"{unmerged_base}{extension}") for extension in VIDEO_EXTENSIONS)

    for candidate in candidates:
        if not candidate:
            continue
        candidate = os.path.abspath(str(candidate))
        if os.path.isfile(candidate) and os.path.splitext(candidate)[1].lower() in VIDEO_EXTENSIONS:
            return candidate
    return None


def probe_video_duration_seconds(video_path: str) -> Optional[float]:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        result = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", video_path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        if result.returncode == 0:
            duration = float(result.stdout.decode("utf-8", errors="replace").strip())
            return duration if duration > 0 else None
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def generate_directed_storyboard_screenshots(
    highlight_path: str,
    comic_text: str,
    storytelling: Optional[Dict[str, Any]],
    source_video_path: Optional[str] = None,
    *,
    source_resolver: Optional[Callable[..., Optional[str]]] = None,
    duration_probe: Optional[Callable[[str], Optional[float]]] = None,
    sheet_renderer: Optional[Callable[..., list[dict]]] = None,
    log: Callable[..., None] = print,
) -> list[dict]:
    """Extract visual-evidence frames requested by either comic script variant."""
    screenshot_config = (storytelling or {}).get("directedScreenshots") or {}
    if screenshot_config.get("enabled", True) is False:
        return []
    try:
        max_images = max(1, min(8, int(screenshot_config.get("maxImages") or 4)))
        max_requests = max(1, min(8, int(screenshot_config.get("maxRequests") or 4)))
        max_frames_per_request = max(1, min(4, int(screenshot_config.get("maxFramesPerRequest") or 2)))
        max_width = max(320, min(1920, int(screenshot_config.get("maxWidth") or 960)))
        jpeg_quality = max(2, min(31, int(screenshot_config.get("jpegQuality") or 2)))
    except (TypeError, ValueError):
        max_images, max_requests, max_frames_per_request = 4, 4, 2
        max_width, jpeg_quality = 960, 2

    reference_requests = extract_reference_requests(comic_text, max_requests)
    if not reference_requests:
        log("[WARNING] 漫画脚本未解析出有效视觉证据请求，降级使用原截图拼图")
        return []

    video_path = (source_resolver or infer_source_video_path)(highlight_path, source_video_path)
    ffmpeg = shutil.which("ffmpeg")
    if not video_path or not ffmpeg:
        log("[WARNING] 未找到原始视频或 ffmpeg，定向关键帧降级使用原截图拼图")
        return []

    duration = (duration_probe or probe_video_duration_seconds)(video_path)
    output_dir = os.path.dirname(highlight_path)
    base_name = os.path.basename(highlight_path).replace("_AI_HIGHLIGHT.txt", "")
    extracted: list[dict] = []
    # Script-planned timestamps are authoritative. Screenshot extraction is local
    # and deterministic; no additional multimodal reviewer is called here.
    # Request order is importance order. When the image budget is smaller than
    # the request count, later sheets must not crowd out earlier requests.
    budgeted_requests = reference_requests[:max_images]
    coverage_sheets = (sheet_renderer or partial(generate_evidence_coverage_sheets, log=log))(
        highlight_path,
        video_path,
        output_dir,
        base_name,
        budgeted_requests,
        screenshot_config,
        ffmpeg,
        duration,
        max_sheets=max_images,
    )
    sheet_request_ids = {
        str(sheet.get("referenceRequestId") or "")
        for sheet in coverage_sheets
    }
    individual_image_limit = max(0, max_images - len(coverage_sheets))

    request_jobs: list[dict] = []
    jobs_by_request: list[list[dict]] = []
    for request in budgeted_requests:
        request_id = str(request.get("referenceRequestId") or "")
        if request_id in sheet_request_ids:
            continue
        requested_timestamps = [
            float(value) for value in (request.get("timestampsSeconds") or [request["timestampSeconds"]])
            if isinstance(value, (int, float))
        ][:max_frames_per_request]
        request_segments = []
        for candidate_index, requested_timestamp in enumerate(requested_timestamps, start=1):
            capture_timestamp = requested_timestamp
            if duration is not None:
                capture_timestamp = min(capture_timestamp, max(0.0, duration - 0.1))
            request_payload = {
                **request,
                "timestampSeconds": float(request["timestampSeconds"]),
                "timestampsSeconds": requested_timestamps,
            }
            request_segments.append({
                "request": request_payload,
                "segmentStartSeconds": capture_timestamp,
                "segmentEndSeconds": capture_timestamp,
                "preferredTimestampSeconds": capture_timestamp,
                "candidateIndex": candidate_index,
                "isAnchorCandidate": True,
                "selectionMode": "script_requested",
            })
        jobs_by_request.append(request_segments)

    # Round-robin allocation preserves the planner's request order while giving
    # each requested visual purpose one frame before taking second candidates.
    for candidate_round in range(max_frames_per_request):
        for request_segments in jobs_by_request:
            if candidate_round < len(request_segments) and len(request_jobs) < individual_image_limit:
                request_jobs.append(request_segments[candidate_round])

    candidate_counts: dict[str, int] = {}
    for job in request_jobs:
        request_id = str(job["request"].get("referenceRequestId") or "")
        candidate_counts[request_id] = candidate_counts.get(request_id, 0) + 1

    for index, job in enumerate(request_jobs, start=1):
        request = job["request"]
        timestamp = float(request["timestampSeconds"])
        capture_timestamp = float(job["preferredTimestampSeconds"])
        output_path = os.path.join(
            output_dir,
            f"{base_name}_EVIDENCE_FRAME_{index:02d}_{int(round(capture_timestamp)):06d}s.jpg",
        )
        selected_timestamp = capture_timestamp
        try:
            result = _capture_video_frame(
                ffmpeg, video_path, capture_timestamp, output_path, max_width, jpeg_quality
            )
            if result.returncode != 0:
                error = result.stderr.decode("utf-8", errors="replace")[:300]
                log(f"[WARNING] 视觉证据帧 {index} 提取失败: {error}")
                continue
        except (OSError, subprocess.SubprocessError) as error:
            log(f"[WARNING] 视觉证据帧 {index} 提取失败: {error}")
            continue
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            request_id = str(request.get("referenceRequestId") or "")
            extracted.append({
                **request,
                "timestampSeconds": timestamp,
                "selectedTimestampSeconds": selected_timestamp,
                "windowStartSeconds": job["segmentStartSeconds"],
                "windowEndSeconds": job["segmentEndSeconds"],
                "candidateIndex": job["candidateIndex"],
                "candidateCount": candidate_counts.get(request_id, 1),
                "selectionMode": "script_requested",
                "path": output_path,
            })
            log(
                f"[OK] 视觉证据帧 {index}/{len(request_jobs)}: 请求={request_id}, "
                f"用途={request.get('referenceUsage')}, 目标={timestamp:.1f}s, "
                f"选帧={selected_timestamp:.1f}s -> {os.path.basename(output_path)}"
            )
    extracted.extend(coverage_sheets[:max(0, max_images - len(extracted))])
    return extracted
