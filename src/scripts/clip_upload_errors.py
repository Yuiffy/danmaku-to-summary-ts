"""Classify deterministic uploader failures without loading queue state."""

import re


TERMINAL_UPLOAD_ERROR_MARKERS = (
    "视频文件不存在",
    "文件不存在:",
    "metadata json not found",
    "upload manifest not found",
    "no clips found in upload json",
    "unsupported upload json shape",
    "无法读取上传 json",
    "上传 json 中未找到切片",
    "no such file or directory",
    "review.md not found",
    "cannot read review",
    "cannot read review.md",
    "no clips found in review",
    "review.md 中未找到切片",
    "invalid_video",
    "video validation failed",
    "no video stream",
    "video too short",
    "无法创建封面",
    "no_cover",
)


def has_terminal_upload_error(output: str) -> bool:
    return bool(terminal_upload_error_reason(output))


def terminal_upload_error_reason(output: str) -> str:
    """Return a reason for an error that cannot succeed by retrying unchanged.

    Summary lines with a zero count are informational.  Only a positive
    count or an explicit per-clip error should make a job terminal.
    """
    text = str(output or "")
    lowered = text.lower()
    for marker in TERMINAL_UPLOAD_ERROR_MARKERS:
        if marker.lower() in lowered:
            return f"deterministic uploader error: {marker}"
    if re.search(r"文件缺失:\s*[1-9]\d*", text):
        return "deterministic uploader error: 文件缺失"
    if re.search(
        r"(?:同标题冲突(?:\(待核对\))?|标题冲突)\s*[:：]\s*(?:[1-9]\d*|BV\w+)",
        text,
    ) or re.search(r"\[\s*CONFLICT\s*\]|上传前发现同标题已存在", text, re.IGNORECASE):
        return "deterministic uploader error: 同标题冲突"
    return ""


def format_upload_failure(returncode: int, output: str) -> str:
    detail = str(output or "").strip()
    if len(detail) > 2000:
        detail = detail[-2000:]
    prefix = f"upload subprocess exited with code {returncode}"
    return f"{prefix}: {detail}" if detail else prefix
