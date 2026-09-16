#!/usr/bin/env python
"""Generate readable, editorial-style Bilibili clip covers from a video frame.

The public upload title can be 18-42 Chinese characters long. A cover uses two
short text levels, which may form one utterance or an exchange. New clip planners should
pass ``--title`` as two lines (``coverText``); older callers can keep passing the
full upload title and this module will derive a conservative fallback.  Each
text level can wrap to preserve complete copy and quotation marks.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path
from typing import Optional, Tuple

try:
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageStat
except ImportError:
    print("[ERROR] 请安装 Pillow: pip install Pillow")
    sys.exit(1)


def hidden_subprocess_kwargs() -> dict:
    """Prevent console subprocesses from flashing a window on Windows."""
    if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


class CoverGenerator:
    """Create covers with two direct-on-image typographic text levels."""

    DEFAULT_CONFIG = {
        "font_path": None,
        "kicker_font_size": 104,
        "headline_font_size": 154,
        "text_max_width": 1320,
        "padding": 62,
        "output_size": (1920, 1080),
    }

    FONT_CANDIDATES = {
        # Deng is slightly more relaxed than a system sans for the setup line.
        "kicker": [
            "C:/Windows/Fonts/Dengb.ttf",
            "C:/Windows/Fonts/NotoSansSC-VF.ttf",
            "C:/Windows/Fonts/msyhbd.ttc",
        ],
        # The final hook needs the most legible, high-weight face available.
        "headline": [
            "C:/Windows/Fonts/msyhbd.ttc",
            "C:/Windows/Fonts/NotoSansSC-VF.ttf",
            "C:/Windows/Fonts/simhei.ttf",
        ],
    }

    def __init__(self, config: Optional[dict] = None):
        self.config = {**self.DEFAULT_CONFIG, **(config or {})}
        self.font_paths = self._find_fonts()
        # Keep the old public attribute for scripts which may inspect it.
        self.font_path = self.font_paths["headline"]

    def _find_fonts(self) -> dict[str, Optional[str]]:
        """Find a readable local Chinese font for each text role."""
        fonts: dict[str, Optional[str]] = {}
        custom_font = self.config.get("font_path")
        for role, candidates in self.FONT_CANDIDATES.items():
            role_candidates = ([custom_font] if custom_font and role == "headline" else []) + candidates
            fonts[role] = next((path for path in role_candidates if path and os.path.exists(path)), None)
            if fonts[role]:
                print(f"[INFO] {role} 字体: {fonts[role]}")
            else:
                print(f"[WARN] 未找到 {role} 中文字体，使用 Pillow 默认字体")
        return fonts

    def _load_font(self, role: str, size: int):
        try:
            path = self.font_paths.get(role) or self.font_path
            return ImageFont.truetype(path, size) if path else ImageFont.load_default()
        except Exception as error:
            print(f"[WARN] 加载 {role} 字体失败: {error}，使用默认字体")
            return ImageFont.load_default()

    @staticmethod
    def _clean_line(value: str) -> str:
        # Quotes are content, not transport escaping. Stripping them independently
        # removes the closing quote in copy such as: 随后宣布“拯救成功”.
        return re.sub(r"\s+", " ", str(value or "")).strip()

    @staticmethod
    def _split_clauses(text: str, separators: str) -> list[str]:
        """Split legacy titles only outside quotations and paired punctuation."""
        pairs = {"“": "”", "‘": "’", "「": "」", "『": "』", "（": "）", "(": ")",
                 "【": "】", "《": "》", '"': '"', "'": "'"}
        stack, parts, start = [], [], 0
        for index, char in enumerate(text):
            if char == "'" and 0 < index < len(text) - 1 and text[index - 1].isascii() \
                    and text[index - 1].isalnum() and text[index + 1].isalnum():
                continue
            if stack and char == stack[-1]:
                stack.pop()
            elif char in pairs:
                stack.append(pairs[char])
            elif char in separators and not stack:
                if text[start:index].strip():
                    parts.append(text[start:index].strip())
                start = index + 1
        if text[start:].strip():
            parts.append(text[start:].strip())
        return parts

    @classmethod
    def build_cover_lines(cls, title: str) -> Tuple[str, str]:
        """Return a setup and punchline for the cover.

        ``title`` may already contain a deliberate newline from the AI planner.
        Explicit copy is preserved without word deletion or ellipses; otherwise the
        fallback prefers the two clauses after a colon, then the first/last
        sentence.  This keeps legacy jobs usable without silently making up text.
        """
        raw = str(title or "").replace("\\n", "\n")
        supplied = [cls._clean_line(line) for line in raw.splitlines()]
        supplied = [line for line in supplied if line]
        if len(supplied) >= 2:
            return supplied[0], "\n".join(supplied[1:])

        source = cls._clean_line(raw)
        source = re.sub(r"^【[^】]+】", "", source)
        streamer_prefix = r"^(?:小岁|岁己SUI|岁己)[：:，,\s]*"
        source = re.sub(streamer_prefix, "", source)
        if not source:
            return "直播里发生了什么", "点进来看看"

        colon_parts = cls._split_clauses(source, "：:")
        if len(colon_parts) >= 2:
            tail_parts = cls._split_clauses(colon_parts[-1], "，,。！!?？；;")
            if len(tail_parts) >= 2:
                kicker, headline = tail_parts[-2], tail_parts[-1]
            else:
                prefix_parts = [part for prefix in colon_parts[:-1]
                                for part in cls._split_clauses(prefix, "，,。！!?？；;")]
                # A bare speaker label in "setup? SUI: reply" is not the setup.
                kicker = next((part for part in reversed(prefix_parts)
                               if re.sub(streamer_prefix, "", part)), "")
                headline = tail_parts[0] if tail_parts else colon_parts[-1]
        else:
            parts = cls._split_clauses(source, "，,。！!?？；;")
            if len(parts) >= 2:
                kicker, headline = parts[0], parts[-1]
            else:
                return "", source

        kicker = re.sub(streamer_prefix, "", kicker)
        headline = re.sub(streamer_prefix, "", headline)
        return kicker, headline or kicker

    @staticmethod
    def _ink_bbox(draw, text, font, stroke_width, shadow_offset) -> tuple[int, int, int, int]:
        main = draw.textbbox((0, 0), text, font=font, stroke_width=stroke_width, anchor="lm")
        shadow = draw.textbbox(shadow_offset, text, font=font, stroke_width=stroke_width + 5, anchor="lm")
        return (min(main[0], shadow[0]), min(main[1], shadow[1]),
                max(main[2], shadow[2]), max(main[3], shadow[3]))

    @staticmethod
    @lru_cache(maxsize=256)
    def _word_spans(text: str) -> tuple:
        try:
            import jieba
        except ImportError:
            return ()
        return tuple(jieba.tokenize(text, HMM=False))

    @classmethod
    def _wrap_text(cls, text: str, measure, max_width: int) -> Optional[list[str]]:
        """Balance measured rows without orphaned closing marks or broken tokens."""
        rows = []
        for paragraph in text.splitlines():
            forbidden = set()
            for index in range(1, len(paragraph)):
                if paragraph[index] in "，。！？；：、,.!?;:’”」』）】》)]}%％…" \
                        or paragraph[index - 1] in "‘“「『（【《([{":
                    forbidden.add(index)
            for quote in ('"', "'"):
                opening = True
                for index, char in enumerate(paragraph):
                    if char == quote:
                        if quote == "'" and 0 < index < len(paragraph) - 1 \
                                and paragraph[index - 1].isascii() and paragraph[index - 1].isalnum() \
                                and paragraph[index + 1].isalnum():
                            continue
                        forbidden.add(index + 1 if opening else index)
                        opening = not opening
            for pattern in (r"[A-Za-z0-9]+(?:[./'_’-][A-Za-z0-9]+)*[%％]?",
                            r'“[^“”]*”|‘[^‘’]*’|「[^「」]*」|『[^『』]*』|"[^"]*"'):
                for token in re.finditer(pattern, paragraph):
                    if measure(token.group()) <= max_width:
                        forbidden.update(range(token.start() + 1, token.end()))
            for word, start, end in cls._word_spans(paragraph):
                if measure(word) <= max_width:
                    forbidden.update(range(start + 1, end))
            # A quote can span the caller's explicit lines. Paragraph edges are
            # already fixed, even when a straight quote looks like an opener.
            forbidden.discard(0)
            forbidden.discard(len(paragraph))

            # Minimize row count first, then raggedness. Counting glyphs cannot
            # distinguish a narrow ASCII label from the same length in Chinese.
            best = {len(paragraph): (0, 0, [])}
            for start in range(len(paragraph) - 1, -1, -1):
                if paragraph[start].isspace():
                    if start + 1 in best:
                        best[start] = best[start + 1]
                    continue
                for end in range(start + 1, len(paragraph) + 1):
                    line = paragraph[start:end].rstrip()
                    width = measure(line)
                    if width > max_width:
                        break
                    if end in forbidden or end not in best:
                        continue
                    count, cost, rest = best[end]
                    candidate = (count + 1, cost + (max_width - width) ** 2, [line, *rest])
                    if start not in best or candidate[:2] < best[start][:2]:
                        best[start] = candidate
            if 0 not in best:
                return None
            rows.extend(best[0][2])
        return rows

    def _text_layout(self, width: int, height: int, text_position: str = "center") -> dict:
        """Place all copy inside the centered 4:3 crop of a 16:9 cover."""
        safe_width = min(width, int(round(height * 4 / 3)))
        safe_left = (width - safe_width) // 2
        safe_right = safe_left + safe_width
        scale = min(width / 1920, height / 1080)
        inner_margin = max(8, int(round(width * 0.025)))
        kicker_x = safe_left + inner_margin
        headline_x = kicker_x + max(5, int(round(width * 0.014)))
        max_width = min(
            int(round(self.config["text_max_width"] * scale)),
            safe_right - headline_x - inner_margin,
        )
        return {
            "safe_left": safe_left,
            "safe_right": safe_right,
            "kicker_x": kicker_x,
            "headline_x": headline_x,
            "max_width": max_width,
            "scale": scale,
            "top": int(round(height * (0.46 if text_position == "bottom" else 0.04))),
            "bottom": int(round(height * (0.96 if text_position == "bottom" else 0.58))),
        }

    def _layout_text(self, draw, title: str, width: int, height: int, text_position: str = "center") -> list[dict]:
        layout = self._text_layout(width, height, text_position)
        scale = layout["scale"]
        kicker, headline = self.build_cover_lines(title)
        roles = [("kicker", kicker, (255, 255, 255), 10, (7, 8), 64),
                 ("headline", headline, (255, 222, 52), 14, (10, 11), 96)]
        for reduction in range(8):
            rows, used_height = [], 0
            for role, text, fill, stroke, shadow, minimum in roles:
                if not text:
                    continue
                stroke = max(1, round(stroke * scale))
                shadow = tuple(round(offset * scale) for offset in shadow)
                configured_size = self.config[f"{role}_font_size"]
                minimum = max(1, round(min(minimum, configured_size) * scale))
                size = max(minimum, round(configured_size * scale * (1 - reduction * 0.05)))
                font = self._load_font(role, size)

                def measure(line, font=font):
                    box = self._ink_bbox(draw, line, font, stroke, shadow)
                    return box[2] - box[0]

                lines = None
                if "\n" not in text:
                    # Small adjustments keep ordinary short copy on one row;
                    # long copy wraps before we make the headline unreadable.
                    for candidate_size in range(size, max(minimum, round(size * 0.76)) - 1, -2):
                        candidate = self._load_font(role, candidate_size)
                        if measure(text, candidate) <= layout["max_width"]:
                            font, lines = candidate, [text]
                            break
                if lines is None:
                    lines = self._wrap_text(text, measure, layout["max_width"])
                if not lines or len(lines) > (2 if kicker else 4):
                    break
                for line in lines:
                    bbox = self._ink_bbox(draw, line, font, stroke, shadow)
                    gap = round((18 if rows and rows[-1]["role"] != role else 10) * scale) if rows else 0
                    used_height += gap
                    rows.append({"role": role, "text": line, "font": font, "fill": fill,
                                 "stroke_width": stroke, "shadow_offset": shadow,
                                 "relative_bbox": bbox, "top": used_height})
                    used_height += bbox[3] - bbox[1]
            else:
                if used_height <= layout["bottom"] - layout["top"]:
                    top = layout["bottom"] - used_height if text_position == "bottom" else layout["top"]
                    for row in rows:
                        left = layout[f'{row["role"]}_x']
                        y = top + row["top"]
                        x0, y0, x1, y1 = row.pop("relative_bbox")
                        row["position"] = (left - x0, y - y0)
                        row["bbox"] = (left, y, left + x1 - x0, y + y1 - y0)
                    return rows
        raise ValueError("Cover text is too long to fit legibly; supply shorter coverText (封面文案过长，请精简).")

    def extract_frame(self, video_path: str, timestamp: float = 0.0, output_path: str = None) -> str:
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"视频文件不存在: {video_path}")
        if output_path is None:
            output_path = os.path.join(os.path.dirname(video_path), f"_cover_frame_{int(timestamp)}.jpg")
        cmd = [
            "ffmpeg",
            "-ss",
            str(timestamp),
            "-i",
            video_path,
            "-vframes",
            "1",
            "-q:v",
            "2",
            "-loglevel",
            "error",
            output_path,
            "-y",
        ]
        try:
            subprocess.run(cmd, check=True, timeout=30, **hidden_subprocess_kwargs())
            print(f"[INFO] 已截取视频帧: {output_path} (time={timestamp}s)")
            return output_path
        except Exception as error:
            raise RuntimeError(f"截取视频帧失败: {error}") from error

    def find_key_frame(self, video_path: str, duration_ratio: float = 0.1) -> float:
        try:
            result = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", video_path],
                capture_output=True,
                text=True,
                timeout=10,
                check=True,
                **hidden_subprocess_kwargs(),
            )
            duration = float(json.loads(result.stdout)["format"]["duration"])
            timestamp = duration * duration_ratio
            print(f"[INFO] 视频时长: {duration:.1f}s, 关键帧位置: {timestamp:.1f}s")
            return timestamp
        except Exception as error:
            print(f"[WARN] 获取视频时长失败: {error}，使用第一帧")
            return 0.0

    @staticmethod
    def _score_frame(image: Image.Image) -> float:
        """Prefer a clear, colourful, normally exposed frame over fades/blur."""
        preview = image.convert("RGB")
        preview.thumbnail((384, 216), Image.Resampling.BILINEAR)
        gray = preview.convert("L")
        gray_stat = ImageStat.Stat(gray)
        brightness = gray_stat.mean[0]
        contrast = gray_stat.stddev[0]
        edge_mean = ImageStat.Stat(gray.filter(ImageFilter.FIND_EDGES)).mean[0]
        saturation = ImageStat.Stat(preview.convert("HSV")).mean[1]
        exposure_penalty = abs(brightness - 138.0) * 0.18
        return contrast * 1.15 + edge_mean * 1.8 + saturation * 0.22 - exposure_penalty

    def select_best_frame(
        self,
        video_path: str,
        clip_start: float = 0.0,
        clip_duration: Optional[float] = None,
        preferred_time: Optional[float] = None,
        sample_count: int = 7,
        output_path: Optional[str] = None,
    ) -> Tuple[str, float]:
        """Sample a clip range and materialise its best-looking candidate.

        Times are absolute in ``video_path``.  ``preferred_time`` normally comes
        from the danmaku peak and receives a modest bonus; visual scoring can
        still reject a fade, blur or badly exposed peak frame.
        """
        start = max(0.0, float(clip_start or 0.0))
        if clip_duration is None or float(clip_duration) <= 0:
            duration = max(0.1, self.find_key_frame(video_path, 1.0) - start)
        else:
            duration = max(0.1, float(clip_duration))
        count = max(3, min(12, int(sample_count or 7)))
        low = start + min(1.0, duration * 0.08)
        high = start + duration - min(0.6, duration * 0.05)
        if high <= low:
            low, high = start, start + duration

        timestamps = [low + (high - low) * index / (count - 1) for index in range(count)]
        preferred = float(preferred_time) if preferred_time is not None else None
        if preferred is not None and low <= preferred <= high:
            timestamps.extend([
                max(low, preferred - 1.5),
                preferred,
                min(high, preferred + 1.5),
            ])
        timestamps = sorted({round(timestamp, 3) for timestamp in timestamps})

        best_image = None
        best_timestamp = timestamps[0]
        best_score = float("-inf")
        with tempfile.TemporaryDirectory(prefix="cover_candidates_") as directory:
            for index, timestamp in enumerate(timestamps):
                candidate_path = os.path.join(directory, f"candidate_{index:02d}.jpg")
                try:
                    self.extract_frame(video_path, timestamp, candidate_path)
                    with Image.open(candidate_path) as candidate:
                        score = self._score_frame(candidate)
                        if preferred is not None:
                            distance = abs(timestamp - preferred)
                            score += max(0.0, 20.0 - distance * 3.0)
                        if score > best_score:
                            best_score = score
                            best_timestamp = timestamp
                            best_image = candidate.convert("RGB").copy()
                except Exception as error:
                    print(f"[WARN] 候选帧 {timestamp:.2f}s 读取失败: {error}")

        if best_image is None:
            raise RuntimeError("未能从切片范围提取任何候选封面帧")
        if output_path is None:
            handle = tempfile.NamedTemporaryFile(prefix="cover_best_", suffix=".jpg", delete=False)
            output_path = handle.name
            handle.close()
        best_image.save(output_path, "JPEG", quality=95, subsampling=0)
        print(f"[INFO] 最佳封面帧: {best_timestamp:.2f}s (候选 {len(timestamps)} 帧, score={best_score:.1f})")
        return output_path, best_timestamp

    def _prepare_canvas(self, image_path: str) -> Image.Image:
        img = Image.open(image_path).convert("RGB")
        target_w, target_h = self.config["output_size"]
        src_w, src_h = img.size
        target_ratio = target_w / target_h
        src_ratio = src_w / src_h
        if abs(src_ratio - target_ratio) > 0.01:
            if src_ratio > target_ratio:
                new_w = int(src_h * target_ratio)
                left = max(0, (src_w - new_w) // 2)
                img = img.crop((left, 0, left + new_w, src_h))
            else:
                new_h = int(src_w / target_ratio)
                top = max(0, (src_h - new_h) // 2)
                img = img.crop((0, top, src_w, top + new_h))
        img = img.resize((target_w, target_h), Image.Resampling.LANCZOS)
        img = ImageEnhance.Contrast(img).enhance(1.06)
        img = ImageEnhance.Color(img).enhance(1.08)
        return ImageEnhance.Sharpness(img).enhance(1.04)

    @staticmethod
    def _draw_outlined_text(
        draw: ImageDraw.ImageDraw,
        position: tuple[int, int],
        text: str,
        font,
        fill: tuple[int, int, int],
        stroke_width: int,
        shadow_offset: tuple[int, int] = (7, 8),
    ) -> None:
        """Draw the direct-on-image outlined type used by clip channels."""
        x, y = position
        shadow_x, shadow_y = shadow_offset
        draw.text(
            (x + shadow_x, y + shadow_y),
            text,
            font=font,
            fill=(12, 8, 18),
            stroke_width=stroke_width + 5,
            stroke_fill=(12, 8, 18),
            anchor="lm",
        )
        draw.text(
            (x, y),
            text,
            font=font,
            fill=fill,
            stroke_width=stroke_width,
            stroke_fill=(16, 12, 20),
            anchor="lm",
        )

    def add_text_to_cover(
        self,
        image_path: str,
        title: str,
        subtitle: Optional[str] = None,
        output_path: Optional[str] = None,
        text_position: str = "center",
        with_shadow: bool = False,
        with_bg_bar: bool = False,
    ) -> str:
        """Add two wrapping text levels with no panel or backing bar."""
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"图片不存在: {image_path}")

        img = self._prepare_canvas(image_path).convert("RGB")
        width, height = img.size
        draw = ImageDraw.Draw(img)

        rows = self._layout_text(draw, title, width, height, text_position)
        # High-performing clip covers in the supplied references use a simple
        # hierarchy: white setup, yellow hook, heavy black outline, no panel.
        for row in rows:
            self._draw_outlined_text(
                draw, row["position"], row["text"], row["font"], row["fill"],
                row["stroke_width"], row["shadow_offset"],
            )

        if output_path is None:
            output_path = os.path.join(os.path.dirname(image_path), "_cover_with_text.jpg")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        img.save(output_path, "JPEG", quality=95, subsampling=0)
        print(f"[INFO] 封面文案: {' / '.join(row['text'] for row in rows)}")
        print(f"[INFO] 封面已生成: {output_path}")
        return output_path

    def generate_cover(
        self,
        video_path: str,
        title: str,
        subtitle: Optional[str] = None,
        output_path: Optional[str] = None,
        use_key_frame: bool = True,
        clip_start: float = 0.0,
        clip_duration: Optional[float] = None,
        preferred_time: Optional[float] = None,
        sample_count: int = 7,
        text_position: str = "center",
    ) -> str:
        if use_key_frame:
            frame_path, _ = self.select_best_frame(
                video_path,
                clip_start=clip_start,
                clip_duration=clip_duration,
                preferred_time=preferred_time,
                sample_count=sample_count,
            )
        else:
            frame_path = self.extract_frame(video_path, max(0.0, clip_start))
        try:
            return self.add_text_to_cover(frame_path, title, subtitle, output_path=output_path, text_position=text_position)
        finally:
            if os.path.exists(frame_path):
                try:
                    os.remove(frame_path)
                except OSError:
                    pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Bilibili 切片封面生成器")
    parser.add_argument("video", help="视频文件路径")
    parser.add_argument("--title", required=True, help="封面文案；两行时用换行分隔，否则从投稿标题降级生成")
    parser.add_argument("--subtitle", default=None, help="兼容旧参数；当前样式不绘制固定品牌字")
    parser.add_argument("--output", default=None, help="输出 JPG 路径")
    parser.add_argument("--font-size", type=int, default=None, help="兼容旧参数：主钩子字体大小")
    parser.add_argument("--position", default="center", choices=["top", "center", "bottom"], help="文字区域；默认使用画面上部，兼容旧调用")
    parser.add_argument("--no-shadow", action="store_true", help="兼容旧参数")
    parser.add_argument("--no-bg", action="store_true", help="兼容旧参数")
    parser.add_argument("--key-frame", action="store_true", help="在切片范围内多帧采样并自动选优")
    parser.add_argument("--clip-start", type=float, default=0.0, help="在输入视频中的切片绝对起点（秒）")
    parser.add_argument("--clip-duration", type=float, default=None, help="切片持续时间（秒）")
    parser.add_argument("--preferred-time", type=float, default=None, help="弹幕/事件峰值的绝对时间（秒）")
    parser.add_argument("--sample-count", type=int, default=7, help="全段均匀采样候选帧数量")
    args = parser.parse_args()

    config = {"headline_font_size": args.font_size} if args.font_size else {}
    generator = CoverGenerator(config)
    output = generator.generate_cover(
        video_path=args.video,
        title=args.title,
        subtitle=args.subtitle,
        output_path=args.output,
        use_key_frame=args.key_frame,
        clip_start=args.clip_start,
        clip_duration=args.clip_duration,
        preferred_time=args.preferred_time,
        sample_count=args.sample_count,
        text_position=args.position,
    )
    print(f"\n✅ 封面生成成功: {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
