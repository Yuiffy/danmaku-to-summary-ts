"""Wrap long lines in SRT files for narrow (portrait) video.

Chinese characters are ~1em wide, so in a 720px video with PlayResX=384
(default for ffmpeg subtitles filter) and FontSize=28, roughly 13-14 chars fit.
We wrap at MAX_CHARS to prevent truncation.

Usage:
    python wrap_srt_lines.py input.srt [--max-chars 15] [-o output.srt]
    python wrap_srt_lines.py input.srt --inplace
"""
import re
import sys
import argparse

MAX_CHARS = 15  # conservative for 720px portrait + FontSize=28


def wrap_line(text: str, max_chars: int) -> str:
    """Wrap a text line at max_chars boundaries for CJK text."""
    text = text.strip()
    if len(text) <= max_chars:
        return text
    lines = []
    while len(text) > max_chars:
        # Try to break at a natural pause (comma, period, etc.)
        break_at = max_chars
        for i in range(max_chars, max(0, max_chars - 3), -1):
            if text[i] in "，。！？、；：…—·）】」》":
                break_at = i + 1
                break
        else:
            # No natural break, just hard-wrap
            break_at = max_chars
        lines.append(text[:break_at])
        text = text[break_at:]
    if text:
        lines.append(text)
    return "\n".join(lines)


def process_srt(input_path: str, output_path: str, max_chars: int, inplace: bool):
    with open(input_path, "r", encoding="utf-8") as f:
        content = f.read()

    blocks = re.split(r"\n\s*\n", content.strip())
    new_blocks = []

    for block in blocks:
        lines = block.strip().split("\n")
        if len(lines) < 3:
            new_blocks.append(block)
            continue

        # lines[0] = index, lines[1] = timestamp, lines[2:] = text
        ts_line = lines[1]
        text_lines = "\n".join(lines[2:])
        wrapped = wrap_line(text_lines, max_chars)
        new_block = f"{lines[0]}\n{ts_line}\n{wrapped}"
        new_blocks.append(new_block)

    result = "\n\n".join(new_blocks) + "\n"

    if inplace:
        output_path = input_path

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(result)

    return output_path


def main():
    parser = argparse.ArgumentParser(description="Wrap long SRT lines for portrait video")
    parser.add_argument("input", help="Input SRT file")
    parser.add_argument("--max-chars", type=int, default=MAX_CHARS, help="Max chars per line (default: 15)")
    parser.add_argument("-o", "--output", help="Output file (default: overwrite with _wrapped suffix)")
    parser.add_argument("--inplace", action="store_true", help="Modify file in place")
    args = parser.parse_args()

    if args.output:
        out = args.output
    elif args.inplace:
        out = args.input
    else:
        base, ext = args.input.rsplit(".", 1)
        out = f"{base}_wrapped.{ext}"

    result = process_srt(args.input, out, args.max_chars, args.inplace)
    print(f"Wrapped SRT -> {result}")


if __name__ == "__main__":
    main()
