from __future__ import annotations

import argparse
import difflib
import json
import re
from pathlib import Path


def parse_srt(path: Path):
    content = path.read_text(encoding="utf-8", errors="ignore")
    blocks = re.split(r"\n\s*\n", content.strip())
    entries = []
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        if len(lines) < 3:
            continue
        time_line = lines[1]
        m = re.match(r"(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})", time_line)
        if not m:
            continue
        text = " ".join(lines[2:]).strip()
        entries.append({
            "start_ms": to_ms(m.group(1)),
            "end_ms": to_ms(m.group(2)),
            "text": text,
        })
    return entries


def to_ms(value: str) -> int:
    hh, mm, rest = value.split(":")
    ss, ms = rest.split(",")
    return ((int(hh) * 60 + int(mm)) * 60 + int(ss)) * 1000 + int(ms)


def ms_to_srt(value: int) -> str:
    value = max(0, int(value))
    hh = value // 3600000
    value %= 3600000
    mm = value // 60000
    value %= 60000
    ss = value // 1000
    ms = value % 1000
    return f"{hh:02d}:{mm:02d}:{ss:02d},{ms:03d}"


def overlap(a, b) -> int:
    return max(0, min(a["end_ms"], b["end_ms"]) - max(a["start_ms"], b["start_ms"]))


def compare(base_entries, new_entries):
    rows = []
    for base in base_entries:
        best = None
        best_overlap = 0
        for cand in new_entries:
            ov = overlap(base, cand)
            if ov > best_overlap:
                best_overlap = ov
                best = cand
        if not best:
            continue
        ratio = difflib.SequenceMatcher(None, base["text"], best["text"]).ratio()
        rows.append({
            "start": ms_to_srt(base["start_ms"]),
            "end": ms_to_srt(base["end_ms"]),
            "overlap_ms": best_overlap,
            "similarity": round(ratio, 3),
            "base_text": base["text"],
            "new_text": best["text"],
        })
    rows.sort(key=lambda item: (item["similarity"], -item["overlap_ms"]))
    return rows


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", required=True)
    parser.add_argument("--new", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--top", type=int, default=50)
    args = parser.parse_args()

    base_entries = parse_srt(Path(args.base))
    new_entries = parse_srt(Path(args.new))
    rows = compare(base_entries, new_entries)[: args.top]

    out_path = Path(args.output)
    out_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(rows[:10], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
