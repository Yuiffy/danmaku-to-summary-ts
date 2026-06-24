#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

QUEUE_PATH = Path(r"D:\files\Pictures\AI图保存\seedance\近期岁己居家下载\seedance_queue.json")


def main() -> int:
    data = json.loads(QUEUE_PATH.read_text(encoding="utf-8"))
    print(data.get("tasks", [{}])[0].get("id", "NO_TASK"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
