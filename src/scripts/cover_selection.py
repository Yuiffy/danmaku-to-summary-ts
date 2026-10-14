"""Manual video frame/crop contracts shared by preview, saving and relettering."""
import math
import os
import subprocess
import json
import tempfile
from pathlib import Path


def validate_selection(value):
    if not isinstance(value, dict):
        raise ValueError("A cover selection is required")
    time = value.get("time")
    part = value.get("part", 1)
    text = value.get("text", "")
    if (isinstance(time, bool) or not isinstance(time, (int, float)) or not math.isfinite(time) or time < 0
            or isinstance(part, bool) or not isinstance(part, int) or not 1 <= part <= 1000
            or not isinstance(text, str) or not text.strip() or len(text) > 300 or "\0" in text):
        raise ValueError("Invalid cover time, part or text")
    crop = value.get("crop")
    result = {"time": time, "part": part, "text": text}
    if crop is not None:
        if not isinstance(crop, dict):
            raise ValueError("Invalid crop")
        fields = [crop.get(key) for key in ("x", "y", "width", "height")]
        if any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) for item in fields):
            raise ValueError("Invalid crop")
        x, y, width, height = fields
        if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001:
            raise ValueError("Crop must be inside the frame")
        result["crop"] = dict(zip(("x", "y", "width", "height"), fields))
    return result


def media_identity(video):
    file = Path(video).resolve()
    stat = file.stat()
    return {"path": str(file), "bytes": str(stat.st_size), "mtimeNs": str(stat.st_mtime_ns)}


def selected_cover(generator, video, selection, output, position="center"):
    from PIL import Image
    selection = validate_selection(selection)
    process_options = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(video)],
                           capture_output=True, text=True, check=True, timeout=15, **process_options)
    duration = float(json.loads(probe.stdout)["format"]["duration"])
    if not math.isfinite(duration) or selection["time"] >= duration:
        raise ValueError("Selected frame is outside the video")
    with tempfile.TemporaryDirectory(prefix="cover-frame-") as directory:
        frame = Path(directory) / "frame.jpg"
        generator.extract_frame(str(video), selection["time"], str(frame))
        crop = selection.get("crop")
        if crop:
            with Image.open(frame) as image:
                width, height = image.size
                left, top = round(crop["x"] * width), round(crop["y"] * height)
                right = min(width, round((crop["x"] + crop["width"]) * width))
                bottom = min(height, round((crop["y"] + crop["height"]) * height))
                if right <= left or bottom <= top:
                    raise ValueError("Crop is smaller than one pixel")
                cropped = image.crop((left, top, right, bottom))
            cropped.save(frame, quality=98)
        return generator.add_text_to_cover(str(frame), selection["text"], output_path=output, text_position=position)
