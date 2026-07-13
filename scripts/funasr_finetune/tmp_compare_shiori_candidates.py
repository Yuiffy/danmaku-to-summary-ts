from __future__ import annotations

import difflib
import re
from pathlib import Path

BASE = Path(r"D:\files\videos\DDTV录播\26966466_栞栞Shiori\2026_07_12\录制-26966466-20260712-202117-248-小栞来.srt")
NEW = Path(r"D:\files\videos\DDTV录播\26966466_栞栞Shiori\2026_07_12\录制-26966466-20260712-202117-248-小栞来_timestamp_avg10.srt")


def to_ms(v: str) -> int:
    h, m, s = v.split(":")
    s, ms = s.split(",")
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(ms)


def fmt_ms(value: int) -> str:
    h = value // 3600000
    value %= 3600000
    m = value // 60000
    value %= 60000
    s = value // 1000
    ms = value % 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse(path: Path):
    txt = path.read_text(encoding="utf-8", errors="ignore")
    blocks = re.split(r"\n\s*\n", txt.strip())
    out = []
    for b in blocks:
        lines = [x.strip() for x in b.splitlines() if x.strip()]
        if len(lines) < 3:
            continue
        m = re.match(r"(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})", lines[1])
        if not m:
            continue
        out.append({
            "start_ms": to_ms(m.group(1)),
            "end_ms": to_ms(m.group(2)),
            "text": " ".join(lines[2:]).strip(),
        })
    return out


def overlap(a, b) -> int:
    return max(0, min(a["end_ms"], b["end_ms"]) - max(a["start_ms"], b["start_ms"]))


def main() -> None:
    base = parse(BASE)
    new = parse(NEW)
    rows = []
    for a in base:
        best = None
        bestov = 0
        for b in new:
            o = overlap(a, b)
            if o > bestov:
                bestov = o
                best = b
        if not best:
            continue
        sim = difflib.SequenceMatcher(None, a["text"], best["text"]).ratio()
        if bestov >= 3000 and len(a["text"]) >= 6 and len(best["text"]) >= 6 and sim < 0.35:
            rows.append({
                "start_ms": a["start_ms"],
                "end_ms": a["end_ms"],
                "overlap_ms": bestov,
                "similarity": round(sim, 3),
                "base_text": a["text"],
                "new_text": best["text"],
            })
    rows.sort(key=lambda x: (x["similarity"], -x["overlap_ms"]))
    for i, row in enumerate(rows[:15], start=1):
        print(f"[{i}] {fmt_ms(row['start_ms'])} --> {fmt_ms(row['end_ms'])} | sim={row['similarity']} | overlap={row['overlap_ms']}ms")
        print(f"  原版: {row['base_text']}")
        print(f"  微调: {row['new_text']}")
        print()


if __name__ == "__main__":
    main()
