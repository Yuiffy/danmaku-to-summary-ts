#!/usr/bin/env python
"""Generate readable, editorial-style Bilibili clip covers from a video frame.

The public upload title can be 18-42 Chinese characters long.  A cover cannot:
it needs one short setup line and one large punchline.  New clip planners should
pass ``--title`` as two lines (``coverText``); older callers can keep passing the
full upload title and this module will derive a conservative two-line fallback.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional, Tuple

try:
    from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont, ImageStat
except ImportError:
    print("[ERROR] 请安装 Pillow: pip install Pillow")
    sys.exit(1)


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
        return re.sub(r"\s+", "", str(value or "")).strip(" \t\r\n\"'“”‘’【】")

    @classmethod
    def _shorten_line(cls, value: str, limit: int) -> str:
        """Shorten only expendable connective words; do not invent new copy."""
        text = cls._clean_line(value)
        if len(text) <= limit:
            return text
        for pattern in ("身残志坚的", "终于还是", "从我身上", "这个", "这种", "直接", "当场"):
            candidate = text.replace(pattern, "")
            if len(candidate) >= 4:
                text = candidate
            if len(text) <= limit:
                return text
        return text[: max(1, limit - 1)].rstrip("，、：:；;") + "…"

    @classmethod
    def build_cover_lines(cls, title: str) -> Tuple[str, str]:
        """Return a setup and punchline for the cover.

        ``title`` may already contain a deliberate newline from the AI planner.
        Explicit copy is respected (with only hard display limits); otherwise the
        fallback prefers the two clauses after a colon, then the first/last
        sentence.  This keeps legacy jobs usable without silently making up text.
        """
        raw = str(title or "").replace("\\n", "\n")
        supplied = [cls._clean_line(line) for line in raw.splitlines()]
        supplied = [line for line in supplied if line]
        if len(supplied) >= 2:
            return cls._shorten_line(supplied[0], 11), cls._shorten_line(supplied[1], 12)

        source = cls._clean_line(raw)
        source = re.sub(r"^【[^】]+】", "", source)
        source = re.sub(r"^(?:小岁|岁己SUI|岁己)[：:，,\s]*", "", source)
        if not source:
            return "直播里发生了什么", "点进来看看"

        before_colon, separator, after_colon = source.rpartition("：")
        if not separator:
            before_colon, separator, after_colon = source.rpartition(":")

        if separator and after_colon:
            tail_parts = [cls._clean_line(part) for part in re.split(r"[，,。！!?？；;]", after_colon)]
            tail_parts = [part for part in tail_parts if part]
            if len(tail_parts) >= 2:
                kicker, headline = tail_parts[-2], tail_parts[-1]
            else:
                prefix_parts = [cls._clean_line(part) for part in re.split(r"[，,。！!?？；;]", before_colon)]
                kicker = next((part for part in reversed(prefix_parts) if part), before_colon)
                headline = tail_parts[0] if tail_parts else after_colon
        else:
            parts = [cls._clean_line(part) for part in re.split(r"(?<=[，,。！!?？；;])", source)]
            parts = [part for part in parts if part]
            if len(parts) >= 2:
                kicker, headline = parts[0], parts[-1]
            else:
                pivot = max(4, len(source) // 2)
                kicker, headline = source[:pivot], source[pivot:]

        kicker = re.sub(r"^(?:小岁|岁己SUI|岁己)[：:，,\s]*", "", kicker)
        headline = re.sub(r"^(?:小岁|岁己SUI|岁己)[：:，,\s]*", "", headline)
        if not headline:
            headline = kicker
        if not kicker or kicker == headline:
            kicker = cls._shorten_line(source, 11)
        return cls._shorten_line(kicker, 11), cls._shorten_line(headline, 12)

    @staticmethod
    def _fit_font(draw: ImageDraw.ImageDraw, text: str, font_loader, size: int, max_width: int):
        """Reduce type size only when necessary; never crop a headline."""
        for candidate_size in range(size, 47, -4):
            font = font_loader(candidate_size)
            bbox = draw.textbbox((0, 0), text, font=font, stroke_width=0)
            if bbox[2] - bbox[0] <= max_width:
                return font
        return font_loader(48)

    def extract_frame(self, video_path: str, timestamp: float = 0.0, output_path: str = None) -> str:
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"视频文件不存在: {video_path}")
        if output_path is None:
            output_path = os.path.join(os.path.dirname(video_path), f"_cover_frame_{int(timestamp)}.jpg")
        cmd = ["ffmpeg", "-i", video_path, "-ss", str(timestamp), "-vframes", "1", "-q:v", "2", "-loglevel", "error", output_path, "-y"]
        try:
            subprocess.run(cmd, check=True, timeout=30)
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
        """Add two direct-on-image text levels with no panel or backing bar."""
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"图片不存在: {image_path}")

        img = self._prepare_canvas(image_path).convert("RGB")
        width, height = img.size
        draw = ImageDraw.Draw(img)

        kicker, headline = self.build_cover_lines(title)
        max_width = min(self.config["text_max_width"], width - 150)
        kicker_font = self._fit_font(
            draw, kicker, lambda size: self._load_font("kicker", size), self.config["kicker_font_size"], max_width
        )
        headline_font = self._fit_font(
            draw, headline, lambda size: self._load_font("headline", size), self.config["headline_font_size"], max_width
        )

        kicker_y = 106 if text_position != "bottom" else 570
        headline_y = kicker_y + 146
        # High-performing clip covers in the supplied references use a simple
        # hierarchy: white setup, yellow hook, heavy black outline, no panel.
        self._draw_outlined_text(
            draw, (62, kicker_y), kicker, kicker_font,
            fill=(255, 255, 255), stroke_width=10,
        )
        self._draw_outlined_text(
            draw, (88, headline_y), headline, headline_font,
            fill=(255, 222, 52), stroke_width=14,
            shadow_offset=(10, 11),
        )

        if output_path is None:
            output_path = os.path.join(os.path.dirname(image_path), "_cover_with_text.jpg")
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        img.save(output_path, "JPEG", quality=95, subsampling=0)
        print(f"[INFO] 封面文案: {kicker} / {headline}")
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
            return self.add_text_to_cover(frame_path, title, subtitle, output_path=output_path)
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
    parser.add_argument("--position", default="center", choices=["top", "center", "bottom"], help="兼容旧调用；默认使用左下排版")
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
    )
    print(f"\n✅ 封面生成成功: {output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
