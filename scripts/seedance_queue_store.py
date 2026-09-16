#!/usr/bin/env python3
"""Atomic, locked access to the shared Seedance queue JSON."""
from __future__ import annotations

import json
import os
import socket
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

DEFAULT_QUEUE_PATH = Path(r"D:\files\Pictures\AI图保存\seedance\近期岁己居家下载\seedance_queue.json")
LOCK_STALE_SECONDS = 10 * 60
LOCK_WAIT_SECONDS = 15


class QueueLockError(RuntimeError):
    pass


class QueueStore:
    def __init__(self, path: Path | str = DEFAULT_QUEUE_PATH, *, lock_wait_seconds: int = LOCK_WAIT_SECONDS) -> None:
        self.path = Path(path)
        self.lock_path = self.path.with_name(f"{self.path.name}.lock")
        self.lock_wait_seconds = lock_wait_seconds
        self._owner = uuid.uuid4().hex

    def load(self) -> dict[str, Any]:
        return json.loads(self.path.read_text(encoding="utf-8"))

    def _lock_is_stale(self) -> bool:
        try:
            raw = json.loads(self.lock_path.read_text(encoding="utf-8"))
            created_at = float(raw.get("created_at", 0))
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            created_at = 0
        return time.time() - created_at > LOCK_STALE_SECONDS

    def acquire(self) -> None:
        deadline = time.monotonic() + self.lock_wait_seconds
        payload = json.dumps({
            "owner": self._owner,
            "pid": os.getpid(),
            "host": socket.gethostname(),
            "created_at": time.time(),
        }, ensure_ascii=False)
        while True:
            try:
                fd = os.open(str(self.lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(payload)
                    f.flush()
                    os.fsync(f.fileno())
                return
            except FileExistsError:
                if self._lock_is_stale():
                    try:
                        self.lock_path.unlink()
                        continue
                    except FileNotFoundError:
                        continue
                if time.monotonic() >= deadline:
                    raise QueueLockError(f"queue is locked: {self.lock_path}")
                time.sleep(0.1)

    def release(self) -> None:
        try:
            raw = json.loads(self.lock_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            return
        if raw.get("owner") == self._owner:
            try:
                self.lock_path.unlink()
            except FileNotFoundError:
                pass

    def save(self, data: dict[str, Any]) -> None:
        if not self.lock_path.exists():
            raise QueueLockError("save requires an acquired queue lock")
        tmp = self.path.with_name(f".{self.path.name}.{self._owner}.tmp")
        try:
            with tmp.open("w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
        finally:
            try:
                tmp.unlink()
            except FileNotFoundError:
                pass

    @contextmanager
    def transaction(self) -> Iterator[dict[str, Any]]:
        self.acquire()
        try:
            yield self.load()
        finally:
            self.release()
