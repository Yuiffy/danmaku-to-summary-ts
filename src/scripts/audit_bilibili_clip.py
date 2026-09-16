#!/usr/bin/env python
"""Read-only audit for a local clip and, optionally, an existing Bilibili BV.

The audit deliberately does not upload, edit, or enqueue anything.  It checks
the mechanical facts that are easy to lose between cutting and publishing:
media streams and duration, subtitle bounds, generated metadata, cover shape,
explicit evidence terms, and the current creator-center record for a BVID.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


TIMESTAMP_RE = re.compile(
    r"(?P<start>\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*"
    r"(?P<end>\d{2}:\d{2}:\d{2}[,.]\d{3})"
)


def parse_timestamp(value: str) -> float:
    normalized = str(value or "").replace(",", ".")
    hours, minutes, seconds = normalized.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def normalize_text(value: str) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(value or "").casefold())


def parse_srt(path: str | Path) -> List[Dict[str, Any]]:
    text = Path(path).read_text(encoding="utf-8-sig")
    segments: List[Dict[str, Any]] = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    index = 0
    while index < len(lines):
        match = TIMESTAMP_RE.search(lines[index])
        if not match:
            index += 1
            continue
        body: List[str] = []
        cursor = index + 1
        while cursor < len(lines) and lines[cursor].strip():
            body.append(lines[cursor].strip())
            cursor += 1
        segments.append(
            {
                "start": parse_timestamp(match.group("start")),
                "end": parse_timestamp(match.group("end")),
                "text": " ".join(body),
            }
        )
        index = cursor
    return segments


def probe_media(path: str | Path) -> Dict[str, Any]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=index,codec_type,codec_name,nb_frames,duration",
        "-of",
        "json",
        str(path),
    ]
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=30,
    )
    payload = json.loads(result.stdout or "{}")
    format_data = payload.get("format") or {}
    return {
        "duration": float(format_data.get("duration") or 0),
        "streams": payload.get("streams") or [],
    }


def _load_json(path: Optional[str | Path]) -> Dict[str, Any]:
    if not path:
        return {}
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def _append_unique(items: List[str], value: str) -> None:
    if value and value not in items:
        items.append(value)


def _cover_dimensions(path: str | Path) -> Optional[Tuple[int, int]]:
    try:
        from PIL import Image

        with Image.open(path) as image:
            return image.size
    except (ImportError, OSError, ValueError):
        return None


def _same_path(left: str | Path, right: str | Path) -> bool:
    """Compare generated paths without requiring either file to exist."""
    left_path = os.path.normcase(os.path.abspath(os.path.expanduser(str(left))))
    right_path = os.path.normcase(os.path.abspath(os.path.expanduser(str(right))))
    return left_path == right_path


def _evidence_matches(text: str, expression: str) -> bool:
    normalized_text = normalize_text(text)
    alternatives = [normalize_text(item) for item in str(expression).split("|")]
    return any(item and item in normalized_text for item in alternatives)


def audit_local_clip(
    video_path: str | Path,
    *,
    srt_path: Optional[str | Path] = None,
    metadata_path: Optional[str | Path] = None,
    cover_path: Optional[str | Path] = None,
    evidence: Sequence[str] = (),
    duration_tolerance: float = 2.0,
) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []
    checks: Dict[str, Any] = {}
    video = Path(video_path).expanduser().resolve()
    checks["videoPath"] = str(video)

    if not video.exists():
        return {"status": "error", "errors": [f"video not found: {video}"], "warnings": [], "checks": checks}

    try:
        media = probe_media(video)
        checks["media"] = media
    except Exception as error:
        errors.append(f"ffprobe failed: {error}")
        media = {"duration": 0, "streams": []}

    streams = media.get("streams") or []
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if not video_streams:
        errors.append("video stream is missing")
    if not audio_streams:
        warnings.append("audio stream is missing")
    duration = float(media.get("duration") or 0)
    if duration <= 0:
        errors.append("media duration is missing or zero")

    resolved_srt = Path(srt_path).expanduser().resolve() if srt_path else video.with_suffix(".srt")
    segments: List[Dict[str, Any]] = []
    if resolved_srt.exists():
        try:
            segments = parse_srt(resolved_srt)
            checks["srtPath"] = str(resolved_srt)
            checks["subtitleSegmentCount"] = len(segments)
            if not segments:
                errors.append("SRT contains no subtitle segments")
            else:
                previous: Optional[Dict[str, Any]] = None
                for index, segment in enumerate(segments, start=1):
                    start = float(segment["start"])
                    end = float(segment["end"])
                    if start < 0:
                        errors.append(f"subtitle {index} starts before the clip: {start:.3f}s")
                    if end <= start:
                        errors.append(
                            f"subtitle {index} has invalid bounds: {start:.3f}s -> {end:.3f}s"
                        )
                    if previous:
                        if start < float(previous["start"]):
                            errors.append(f"subtitle {index} is out of chronological order")
                        if start < float(previous["end"]):
                            warnings.append(f"subtitle {index} overlaps the previous subtitle")
                    previous = segment
                if duration and segments[-1]["end"] > duration + 1.0:
                    errors.append(
                        f"last subtitle ends at {segments[-1]['end']:.3f}s, beyond media duration {duration:.3f}s"
                    )
        except Exception as error:
            errors.append(f"SRT parse failed: {error}")
    elif srt_path:
        errors.append(f"SRT not found: {resolved_srt}")
    else:
        warnings.append(f"SRT not found next to video: {resolved_srt}")

    transcript = "\n".join(segment.get("text", "") for segment in segments)
    checks["evidence"] = list(evidence)
    for expression in evidence:
        if not _evidence_matches(transcript, expression):
            errors.append(f"required evidence not found in SRT: {expression}")

    resolved_metadata = Path(metadata_path).expanduser().resolve() if metadata_path else video.with_suffix(".json")
    metadata: Dict[str, Any] = {}
    if resolved_metadata.exists():
        try:
            metadata = _load_json(resolved_metadata)
            checks["metadataPath"] = str(resolved_metadata)
            checks["metadataStatus"] = metadata.get("status")
            output = metadata.get("output") or {}
            copy = metadata.get("copy") or {}
            metadata_media_path = output.get("mediaPath")
            if metadata_media_path and not _same_path(metadata_media_path, video):
                errors.append(
                    "metadata output.mediaPath does not match the audited video: "
                    f"{metadata_media_path}"
                )
            if output.get("burnedSubtitles") is not True:
                errors.append("metadata does not confirm burned subtitles")
            subtitle_count_value = output.get("srtSegmentCount")
            if subtitle_count_value is None:
                subtitle_count_value = output.get("subtitleSegmentCount")
            subtitle_count = int(subtitle_count_value or 0)
            checks["metadataSubtitleSegmentCount"] = subtitle_count
            if segments and subtitle_count <= 0:
                errors.append("metadata reports zero burned subtitle segments")
            elif segments and subtitle_count != len(segments):
                warnings.append(
                    f"metadata subtitle count {subtitle_count} differs from SRT segment count {len(segments)}"
                )
            expected_duration = float((metadata.get("window") or {}).get("duration") or 0)
            if expected_duration and duration and abs(expected_duration - duration) > duration_tolerance:
                warnings.append(
                    f"metadata window duration {expected_duration:.3f}s differs from media {duration:.3f}s"
                )
            if not str(copy.get("title") or "").strip():
                errors.append("metadata copy.title is empty")
            if not str(copy.get("description") or "").strip():
                warnings.append("metadata copy.description is empty")
            if not cover_path and output.get("coverPath"):
                cover_path = output.get("coverPath")
        except Exception as error:
            errors.append(f"metadata parse failed: {error}")
    elif metadata_path:
        errors.append(f"metadata not found: {resolved_metadata}")
    else:
        warnings.append(f"metadata not found next to video: {resolved_metadata}")

    if cover_path:
        cover = Path(cover_path).expanduser().resolve()
        checks["coverPath"] = str(cover)
        if not cover.exists():
            errors.append(f"cover not found: {cover}")
        else:
            dimensions = _cover_dimensions(cover)
            if dimensions:
                width, height = dimensions
                checks["coverDimensions"] = [width, height]
                if height <= 0 or abs((width / height) - (16 / 9)) > 0.03:
                    warnings.append(f"cover is not close to 16:9: {width}x{height}")
            else:
                warnings.append("Pillow is unavailable; cover dimensions were not checked")
    else:
        warnings.append("cover path was not provided or found in metadata")

    return {
        "status": "error" if errors else ("warning" if warnings else "ok"),
        "errors": errors,
        "warnings": warnings,
        "checks": checks,
        "local": {
            "duration": duration,
            "subtitleFirst": segments[0]["start"] if segments else None,
            "subtitleLast": segments[-1]["end"] if segments else None,
            "title": str((metadata.get("copy") or {}).get("title") or ""),
        },
    }


def compare_online_archive(
    archive_data: Dict[str, Any],
    *,
    expected_title: str = "",
    local_duration: Optional[float] = None,
    duration_tolerance: float = 2.0,
) -> Dict[str, Any]:
    archive = archive_data.get("archive") or archive_data
    videos = archive_data.get("videos") or []
    first_video = videos[0] if videos else {}
    online_title = str(archive.get("title") or "")
    online_duration = float(first_video.get("duration") or archive.get("duration") or 0)
    errors: List[str] = []
    warnings: List[str] = []
    if expected_title and online_title != expected_title:
        errors.append(f"online title mismatch: expected {expected_title!r}, got {online_title!r}")
    if local_duration and online_duration:
        difference = abs(float(local_duration) - online_duration)
        if difference > duration_tolerance:
            errors.append(
                f"online duration mismatch: local={float(local_duration):.3f}s, "
                f"online={online_duration:.3f}s, delta={difference:.3f}s"
            )
    elif local_duration and not online_duration:
        warnings.append("online duration is unavailable, often because the edit is still under review")

    return {
        "status": "error" if errors else ("warning" if warnings else "ok"),
        "errors": errors,
        "warnings": warnings,
        "online": {
            "bvid": archive.get("bvid") or first_video.get("bvid") or "",
            "title": online_title,
            "duration": online_duration,
            "state": archive.get("state"),
            "stateDesc": archive.get("state_desc") or first_video.get("status_desc") or "",
            "cid": first_video.get("cid"),
            "filename": first_video.get("filename"),
        },
    }


async def fetch_online_archive(bvid: str) -> Dict[str, Any]:
    project_root = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(project_root / "src" / "scripts"))
    from bilibili_api import video_uploader
    from bilibili_upload import build_credential

    editor = video_uploader.VideoEditor(
        bvid=bvid,
        meta={
            "title": "",
            "copyright": 1,
            "tag": "",
            "desc_format_id": 0,
            "desc": "",
            "dynamic": "",
            "interactive": 0,
            "new_web_edit": 1,
            "act_reserve_create": 0,
            "handle_staff": False,
            "topic_grey": 1,
            "no_reprint": 0,
            "subtitles": {"lan": "", "open": 0},
            "web_os": 2,
        },
        credential=build_credential(),
    )
    await editor._fetch_configs()
    return editor._VideoEditor__old_configs


def _print_report(report: Dict[str, Any]) -> None:
    print(f"status: {report.get('status')}")
    for error in report.get("errors") or []:
        print(f"[ERROR] {error}")
    for warning in report.get("warnings") or []:
        print(f"[WARN] {warning}")
    checks = report.get("checks") or {}
    if checks.get("videoPath"):
        media = checks.get("media") or {}
        print(f"video: {checks['videoPath']} ({float(media.get('duration') or 0):.3f}s)")
    online = report.get("online")
    if online:
        print(
            f"online: {online.get('bvid') or '-'} | {online.get('title') or '-'} | "
            f"duration={float(online.get('duration') or 0):.3f}s | "
            f"state={online.get('state') or '-'} {online.get('stateDesc') or ''}".rstrip()
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="只读核对本地切片与可选的 B 站线上稿件")
    parser.add_argument("--video", required=True, help="本地成片路径")
    parser.add_argument("--srt", help="SRT 路径；默认查找与视频同名的 .srt")
    parser.add_argument("--metadata", help="切片 JSON；默认查找与视频同名的 .json")
    parser.add_argument("--cover", help="封面路径；默认使用切片 JSON 中的 coverPath")
    parser.add_argument("--bvid", help="可选：线上稿件 BV 号；只读查询创作中心信息")
    parser.add_argument("--expected-title", default="", help="线上稿件应有的完整标题")
    parser.add_argument(
        "--evidence",
        action="append",
        default=[],
        help="要求在 SRT 中出现的事实词；用 | 分隔 ASR 变体，可重复传入",
    )
    parser.add_argument("--duration-tolerance", type=float, default=2.0)
    parser.add_argument("--strict-warnings", action="store_true")
    parser.add_argument("--json", action="store_true", dest="as_json")
    return parser


async def run(args: argparse.Namespace) -> Dict[str, Any]:
    report = audit_local_clip(
        args.video,
        srt_path=args.srt,
        metadata_path=args.metadata,
        cover_path=args.cover,
        evidence=args.evidence,
        duration_tolerance=args.duration_tolerance,
    )
    if args.bvid:
        try:
            online_data = await fetch_online_archive(args.bvid)
            online_report = compare_online_archive(
                online_data,
                expected_title=args.expected_title,
                local_duration=(report.get("local") or {}).get("duration"),
                duration_tolerance=args.duration_tolerance,
            )
            report["online"] = online_report.get("online")
            report["errors"].extend(online_report.get("errors") or [])
            report["warnings"].extend(online_report.get("warnings") or [])
            report["status"] = "error" if report["errors"] else ("warning" if report["warnings"] else "ok")
        except Exception as error:
            report["errors"].append(f"online audit failed: {error}")
            report["status"] = "error"
    return report


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    report = asyncio.run(run(args))
    if args.as_json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_report(report)
    if report.get("errors") or (args.strict_warnings and report.get("warnings")):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
