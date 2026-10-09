"""Local music/cinema cover templates for stream-activity submissions."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

WIDTH, HEIGHT = 1920, 1080
PALETTES = {
    "songs": {"background": "#191b25", "panel": "#282b37", "accent": "#e6bc74", "ink": "#fff5e5", "muted": "#bcb5a9"},
    "watch": {"background": "#101f25", "panel": "#1a333a", "accent": "#92d4c4", "ink": "#f2f8f3", "muted": "#a6bebc"},
}


def font(size, bold=False):
    candidates = (["C:/Windows/Fonts/msyhbd.ttc"] if bold else ["C:/Windows/Fonts/msyh.ttc"]) + [
        "C:/Windows/Fonts/NotoSansSC-VF.ttf", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]
    for candidate in candidates:
        if Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise ValueError("A Chinese font is required for stream-activity covers")


def fit_lines(draw, value, width, max_lines=2, maximum=62, minimum=30, max_height=None):
    """Fit measured text without truncating a supplied name or dropping quotes."""
    for size in range(maximum, minimum - 1, -2):
        chosen, lines = font(size, True), []
        for paragraph in value.splitlines():
            current = ""
            for char in paragraph:
                if current and draw.textlength(current + char, font=chosen) > width:
                    boundary = current.rfind(" ")
                    if boundary > 0:
                        lines.append(current[:boundary])
                        current = current[boundary+1:]
                    else:
                        lines.append(current)
                        current = ""
                current += char
            if current.strip():
                lines.append(current.strip())
        height = len(lines) * (size + 14) - 14
        if lines and len(lines) <= max_lines and (max_height is None or height <= max_height):
            return chosen, lines, size
    raise ValueError("Activity cover subject is too long; review the public title")


def render(frame_path, presentation, output_path):
    kind = presentation["kind"]
    if kind not in PALETTES or presentation.get("version") not in (1, 2):
        raise ValueError("Unsupported stream-activity cover template")
    palette = PALETTES[kind]
    canvas = Image.new("RGB", (WIDTH, HEIGHT), palette["background"])
    draw = ImageDraw.Draw(canvas)
    with Image.open(frame_path) as source:
        frame = source.convert("RGB")
    accent, ink, muted = (palette[key] for key in ("accent", "ink", "muted"))

    if kind == "watch" and presentation["version"] == 2:
        image = ImageOps.contain(frame, (WIDTH, HEIGHT), method=Image.Resampling.LANCZOS)
        canvas.paste(image, ((WIDTH-image.width)//2, (HEIGHT-image.height)//2))
        draw = ImageDraw.Draw(canvas)
        title_font, lines, size = fit_lines(draw, str(presentation["subject"]), 1220,
            max_lines=2, maximum=100, minimum=40, max_height=220)
        panel_height = len(lines)*(size+14) + 90
        top = HEIGHT - panel_height - 40
        overlay = Image.new("RGBA", canvas.size)
        panel = ImageDraw.Draw(overlay)
        panel.rounded_rectangle((570, top-22, 1870, 1040), radius=14, fill=(12, 20, 24, 215))
        canvas = Image.alpha_composite(canvas.convert("RGBA"), overlay).convert("RGB")
        draw = ImageDraw.Draw(canvas)
        for index, line in enumerate(lines):
            draw.text((605, top + index*(size+14)), line, font=title_font, fill=ink, anchor="lt")
        draw.text((610, 990), f'{presentation["streamerName"]} · {presentation["date"]}', font=font(32), fill=accent, anchor="lt")
        return save_cover(canvas, output_path)

    draw.line((90, 90, 350, 90), fill=accent, width=6)
    draw.text((90, 132), presentation["streamerName"], font=font(45, True), fill=ink)
    draw.text((90, 204), presentation["edition"], font=font(27), fill=accent)
    if kind == "songs":
        # A portrait sleeve and record grooves give music its own visual identity.
        for radius in range(275, 460, 22):
            draw.ellipse((1420-radius, 560-radius, 1420+radius, 560+radius), outline=palette["panel"], width=4)
        image = ImageOps.fit(frame, (880, 880), method=Image.Resampling.LANCZOS, centering=(0.52, 0.45))
        canvas.paste(image, (950, 100))
        draw = ImageDraw.Draw(canvas)
        draw.line((950, 100, 1830, 100), fill=accent, width=6)
        if presentation["version"] == 2:
            subject_font, lines, size = fit_lines(draw, str(presentation["subject"]), 780,
                max_lines=5, maximum=216, minimum=40, max_height=464)
            for index, line in enumerate(lines):
                draw.text((90, 322 + index*(size+14)), line, font=subject_font, fill=ink, anchor="lt")
            date_y = 322 + len(lines)*(size+14) + 40
            draw.line((90, date_y-18, 850, date_y-18), fill=accent, width=3)
            draw.text((90, date_y), presentation["date"], font=font(70, True), fill=accent, anchor="lt")
            draw.text((90, 954), presentation.get("caption") or "直播演唱", font=font(31), fill=muted)
        else:
            draw.text((78, 310), "歌切", font=font(216, True), fill=ink)
            label_y, subject_y, subject_width = 630, 696, 780
    else:
        # Preserve the full viewing frame in a widescreen cinema aperture.
        draw.rounded_rectangle((776, 166, 1832, 914), radius=18, fill=palette["panel"])
        image = ImageOps.contain(frame, (1024, 576), method=Image.Resampling.LANCZOS)
        canvas.paste(image, (792 + (1024-image.width)//2, 252 + (576-image.height)//2))
        draw = ImageDraw.Draw(canvas)
        for x in range(808, 1820, 60):
            draw.rounded_rectangle((x, 189, x+26, 211), radius=4, fill=palette["background"])
            draw.rounded_rectangle((x, 865, x+26, 887), radius=4, fill=palette["background"])
        draw.text((84, 302), "同步", font=font(166, True), fill=ink)
        draw.text((84, 472), "视听", font=font(166, True), fill=ink)
        label_y, subject_y, subject_width = 700, 756, 630
    if kind != "songs" or presentation["version"] == 1:
        draw.text((90, label_y), "直播演唱" if kind == "songs" else "一起看 · 一起聊", font=font(31), fill=accent)
        subject_font, lines, size = fit_lines(draw, str(presentation["subject"]), subject_width)
        for index, line in enumerate(lines):
            draw.text((90, subject_y + index*(size+14)), line, font=subject_font, fill=ink)
        draw.line((90, 936, 682 if kind == "watch" else 850, 936), fill=palette["panel"], width=2)
        draw.text((90, 972), presentation["date"], font=font(40, True), fill=ink)
        time = str(presentation.get("time") or "")
        draw.text((398, 981), time, font=font(28), fill=muted)
    if kind == "watch":
        draw.text((1610, 958), f'{presentation["parts"]:02d} PARTS', font=font(30), fill=accent)
    return save_cover(canvas, output_path)


def save_cover(canvas, output_path):
    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(".tmp.jpg")
    canvas.save(temporary, "JPEG", quality=93, subsampling=0, optimize=True)
    temporary.replace(destination)
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frame", required=True)
    parser.add_argument("--presentation", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    presentation = json.loads(Path(args.presentation).read_text(encoding="utf-8-sig"))
    print(f"[OK] activity cover: {render(args.frame, presentation, args.output)}")


if __name__ == "__main__":
    main()
