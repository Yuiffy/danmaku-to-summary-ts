"""Expire disposable project temp evidence without following links."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import time

DAY = 86400


def is_link(path: Path) -> bool:
    """Treat symlinks and Windows junctions as protected links."""
    try:
        metadata = os.lstat(path)
        if path.is_symlink():
            return True
        return bool(getattr(metadata, 'st_file_attributes', 0) & 0x400)
    except OSError:
        return True


def has_keep_marker(path: Path) -> bool:
    try:
        return any(child.name == '.keep' for child in path.rglob('*') if child.is_file())
    except OSError:
        return True


def force_remove_dir(path: Path):
    def onerror(function, target, exc_info):
        try:
            os.chmod(target, stat.S_IWRITE | stat.S_IREAD)
            function(target)
        except OSError:
            raise exc_info[1]

    shutil.rmtree(path, onerror=onerror)


def safe_direct_children(root: Path):
    root = root.absolute()
    if is_link(root) or not root.is_dir():
        raise ValueError('temp root must be a physical directory')
    yield from root.iterdir()


def _age_reason(path: Path, cutoff: float, protected: set[str]):
    key = os.path.normcase(str(path.absolute()))
    if key in protected:
        return 'protected path'
    if is_link(path):
        return 'symlink or junction'
    if path.is_dir() and has_keep_marker(path):
        return '.keep marker'
    try:
        if path.stat().st_mtime >= cutoff:
            return 'recently modified'
    except OSError as error:
        return f'stat failed: {error}'
    return None


def plan(root: Path, *, now: float, keep_days: int = 7, protected=()):
    if keep_days < 1:
        raise ValueError('keep_days must be positive')
    root = Path(root).absolute()
    cutoff = now - keep_days * DAY
    protected_keys = {os.path.normcase(str(Path(p).absolute())) for p in protected}
    planned, skipped = [], []
    for child in safe_direct_children(root):
        reason = _age_reason(child, cutoff, protected_keys)
        if reason:
            skipped.append({'path': child.name, 'reason': reason})
            continue
        try:
            size = sum(item.stat().st_size for item in child.rglob('*') if item.is_file()) if child.is_dir() else child.stat().st_size
            planned.append({'path': child.name, 'bytes': size, 'kind': 'directory' if child.is_dir() else 'file'})
        except OSError as error:
            skipped.append({'path': child.name, 'reason': f'size failed: {error}'})
    return planned, skipped


def sweep(root, *, apply=False, keep_days=7, protected=(), now=None, remove_dir=None, remove_file=None):
    now = time.time() if now is None else now
    root = Path(root).absolute()
    report = {
        'version': 1,
        'apply': apply,
        'root': str(root),
        'keepDays': keep_days,
        'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
        'plannedBytes': 0,
        'deletedBytes': 0,
        'deletedEntries': 0,
        'skipped': [],
        'errors': [],
    }
    planned, skipped = plan(root, now=now, keep_days=keep_days, protected=protected)
    report['skipped'] = skipped
    report['plannedBytes'] = sum(item['bytes'] for item in planned)
    if not apply:
        report['planned'] = planned
        return report
    remove_dir = remove_dir or force_remove_dir
    remove_file = remove_file or Path.unlink
    for item in planned:
        path = root / item['path']
        try:
            # Recheck immediately before mutation so a newly used task is kept.
            reason = _age_reason(path, now - keep_days * DAY, {os.path.normcase(str(Path(p).absolute())) for p in protected})
            if reason:
                report['skipped'].append({'path': item['path'], 'reason': reason})
                continue
            if item['kind'] == 'directory':
                remove_dir(path)
            else:
                remove_file(path)
            report['deletedBytes'] += item['bytes']
            report['deletedEntries'] += 1
        except OSError as error:
            report['errors'].append({'path': item['path'], 'reason': str(error)})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[2] / 'temp'))
    parser.add_argument('--keep-days', type=int, default=7)
    parser.add_argument('--protect', action='append', default=[])
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--report')
    args = parser.parse_args()
    result = sweep(args.root, apply=args.apply, keep_days=args.keep_days, protected=args.protect)
    if args.report:
        report_path = Path(args.report)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result['errors'] else 0


if __name__ == '__main__':
    sys.exit(main())
