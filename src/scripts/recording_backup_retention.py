"""Expire old bak videos only when a current merged source map proves coverage."""
from __future__ import annotations

import argparse
from contextlib import nullcontext
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

from clip_media_retention import atomic_json, file_identity, load_json, runtime_config
from media_workspace_retention import checked_child, referenced_workspace_paths

DAY = 86400
VIDEO = {'.flv', '.mp4', '.mkv', '.ts'}


def recording_identity(media):
    """Keep parity with core/media/RecordingCoverage.recordingIdentity (v1)."""
    size = media.stat().st_size
    digest = hashlib.sha256(f'{media.name}:{size}:'.encode('utf-8'))
    with media.open('rb') as handle:
        for offset in (0, max(0, size - 65536)):
            handle.seek(offset)
            digest.update(handle.read(min(size, 65536)))
    return digest.hexdigest()


def probe_duration(media):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
                             'format=duration:stream=codec_type', '-of', 'json', str(media)],
                            capture_output=True, text=True, encoding='utf-8', timeout=60,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), check=True)
    value = json.loads(result.stdout)
    duration = float(value['format']['duration'])
    if not math.isfinite(duration) or duration <= 0 or not any(
            stream.get('codec_type') == 'video' for stream in value.get('streams', [])):
        raise ValueError('invalid video duration or missing video stream')
    return duration


def coverage(map_value, output_identity, output_duration):
    """Validate the existing merger receipt; absent or ambiguous maps never authorize expiry."""
    if (not isinstance(map_value, dict) or isinstance(map_value.get('version'), bool)
            or map_value.get('version') != 1 or map_value.get('outputIdentity') != output_identity):
        raise ValueError('merged source map missing or identity changed')
    spans = map_value.get('spans')
    if not isinstance(spans, list) or not spans:
        raise ValueError('empty source map')
    identities, previous_end = {}, 0
    for span in spans:
        if not isinstance(span, dict):
            raise ValueError('source span must be an object')
        identity, start, duration = span.get('identity'), span.get('start'), span.get('duration')
        if (not isinstance(identity, str) or not re.fullmatch('[a-f0-9]{64}', identity)
                or identity in identities or any(isinstance(v, bool) or not isinstance(v, (int, float))
                or not math.isfinite(v) for v in (start, duration))
                or start < previous_end - .05 or duration <= 0):
            raise ValueError('invalid or overlapping source map')
        previous_end = start + duration
        identities[identity] = duration
    if abs(previous_end - output_duration) > 2:
        raise ValueError('merged duration differs from source map')
    return identities


def path_key(path):
    return os.path.normcase(os.path.abspath(path))


def protected_media(media, protected):
    key = path_key(media)
    return any(key == path_key(p) or key.startswith(path_key(p).rstrip(os.sep) + os.sep)
               for p in protected)


def document_references(file, roots):
    return set(referenced_workspace_paths(load_json(file), roots))


def runtime_backup_protection(root, read=load_json, references=document_references):
    import clip_upload_registry as api
    registry, queue = read(api.REGISTRY_PATH), read(api.QUEUE_PATH)
    roots = {path_key(root)}
    protected = set(references(api.REGISTRY_PATH, roots))
    protected.update(references(api.QUEUE_PATH, roots))
    for record in registry.get('clips', {}).values():
        metadata = record.get('metadataPath')
        if metadata and Path(metadata).is_file():
            protected.update(references(metadata, roots))
    manual = api.RUNTIME_DIR / 'manual_clip_queue.json'
    if manual.is_file():
        protected.update(references(manual, roots))
    return protected


def plan_day(day, protected, now, keep_days=7, probe=probe_duration, read=load_json,
             references=document_references):
    if not math.isfinite(keep_days) or keep_days < 7:
        raise ValueError('backup retention must be at least seven days')
    bak = checked_child(day, 'bak')
    if not bak.is_dir() or (day / '.keep').exists() or (bak / '.keep').exists():
        return [], []
    videos = sorted(source for source in bak.iterdir() if source.suffix.lower() in VIDEO)
    if not videos:
        return [], []
    if all(protected_media(source, protected) for source in videos):
        return [], [{'path': str(source), 'reason': 'backup referenced by registry or queue'} for source in videos]
    if all(source.stat().st_mtime > now - keep_days * DAY for source in videos):
        return [], [{'path': str(bak), 'reason': 'backups are recent'}]
    candidates, skipped, maps = [], [], []
    for merged in sorted(day.glob('*_merged.*')):
        if merged.suffix.lower() not in VIDEO:
            continue
        try:
            checked_child(day, merged.name)
            sidecar = checked_child(day, merged.name + '.sources.json')
            if merged.stat().st_mtime > now - keep_days * DAY:
                continue
            if not sidecar.is_file():
                raise ValueError('merged source map missing')
            snapshot = read(sidecar)
            if not isinstance(snapshot, dict) or snapshot.get('version') != 1 or not snapshot.get('spans'):
                raise ValueError('unsupported or empty merged source map')
            identities = coverage(snapshot, recording_identity(merged), probe(merged))
            maps.append((merged, sidecar, snapshot, identities, file_identity(merged)))
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            skipped.append({'path': str(merged), 'reason': str(error)})
    if not maps:
        return [], skipped + [{'path': str(bak), 'reason': 'no eligible merged source map'}]
    # Receipts/plans inside this day may refer directly to bak sources, even after upload.
    roots = {path_key(bak)}
    protected = set(protected)
    for directory, dirs, files in os.walk(day, followlinks=False):
        dirs[:] = [name for name in dirs if name != 'bak' and not Path(directory, name).is_symlink()
                   and Path(directory, name).resolve() == Path(directory, name).absolute()]
        for name in files:
            if not name.endswith('.json') or name.endswith('.sources.json') or name == 'BAK-RETENTION.json':
                continue
            record = checked_child(day, str(Path(directory, name).relative_to(day)))
            try:
                protected.update(references(record, roots))
            except (OSError, ValueError, TypeError):
                # Unreadable editorial evidence can hide references: retain the day.
                return [], skipped + [{'path': str(record), 'reason': 'unreadable reference evidence'}]
    for source in videos:
        try:
            checked_child(day, str(source.relative_to(day)))
            if not source.is_file() or source.stat().st_mtime > now - keep_days * DAY:
                raise ValueError('backup is recent or not a regular file')
            if protected_media(source, protected):
                raise ValueError('backup referenced by registry, queue, recipe or plan')
            identity = recording_identity(source)
            matches = [entry for entry in maps if identity in entry[3]]
            if not matches:
                raise ValueError('no current merged source map covers this backup')
            merged, sidecar, snapshot, identities, output_stat = matches[0]
            if abs(probe(source) - identities[identity]) > 2:
                raise ValueError('backup duration differs from source map')
            candidates.append({'path': str(source), 'identity': file_identity(source),
                               'recordingIdentity': identity, 'merged': str(merged),
                               'mergedIdentity': output_stat, 'map': str(sidecar), 'mapSnapshot': snapshot})
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            skipped.append({'path': str(source), 'reason': str(error)})
    return candidates, skipped


def sweep(root, protected_provider, apply=False, now=None, keep_days=7, probe=probe_duration,
          remove=None, mutation_guard=nullcontext, read=load_json, references=document_references,
          progress=None):
    now = time.time() if now is None else now
    root = Path(root).absolute()
    if not math.isfinite(keep_days) or keep_days < 7:
        raise ValueError('backup retention must be at least seven days')
    if root.resolve() != root or root.is_symlink():
        raise ValueError('recording root must be physical')
    remove = remove or (lambda file: file.unlink())
    report = {'apply': apply, 'root': str(root), 'keepDays': keep_days, 'startedAt': now,
              'plannedBytes': 0, 'deletedBytes': 0, 'deletedFiles': 0,
              'candidates': [], 'skipped': [], 'errors': []}
    initial_protected = protected_provider()
    for room in sorted(root.iterdir()):
        if not re.match(r'^\d+_', room.name) or not room.is_dir():
            continue
        try:
            checked_child(root, room.name)
            for day in sorted(room.iterdir()):
                if not re.fullmatch(r'\d{4}_\d{2}_\d{2}', day.name) or not day.is_dir():
                    continue
                if day.is_symlink() or day.resolve() != day.absolute():
                    report['skipped'].append({'path': str(day), 'reason': 'linked date directory'})
                    continue
                checked_child(root, str(day.relative_to(root)))
                if (root / '.keep').exists() or (room / '.keep').exists():
                    continue
                targets, skipped = plan_day(day, initial_protected, now, keep_days, probe, read, references)
                report['skipped'].extend(skipped)
                report['plannedBytes'] += sum(row['identity']['bytes'] for row in targets)
                report['candidates'].extend({k: v for k, v in row.items() if k != 'mapSnapshot'} for row in targets)
                for row in targets if apply else []:
                    source, merged = Path(row['path']), Path(row['merged'])
                    # Re-read all references/receipts and file identities immediately before each deletion.
                    with mutation_guard():
                        if (root / '.keep').exists() or (room / '.keep').exists():
                            raise ValueError('recording root or room was marked keep')
                        fresh, _ = plan_day(day, protected_provider(), now, keep_days, probe, read, references)
                        if row not in fresh or file_identity(source) != row['identity'] or file_identity(merged) != row['mergedIdentity']:
                            raise ValueError('backup, replacement, map or references changed during cleanup')
                        journal_path = checked_child(day, 'BAK-RETENTION.json')
                        journal = load_json(journal_path) if journal_path.exists() else {'version': 1, 'entries': []}
                        entry = {**row, 'status': 'pending', 'at': time.time()}
                        journal['entries'].append(entry)
                        atomic_json(journal_path, journal)
                        checked_child(root, str(source.relative_to(root)))
                        remove(source)
                        entry['status'] = 'deleted'
                        atomic_json(journal_path, journal)
                    report['deletedFiles'] += 1
                    report['deletedBytes'] += row['identity']['bytes']
                    if progress:
                        progress(report)
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
            report['errors'].append({'path': str(room), 'reason': str(error)})
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root')
    parser.add_argument('--keep-days', type=float, default=7)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--report')
    args = parser.parse_args()
    root = Path(args.root or runtime_config()['sourceRoot'])
    from contextlib import contextmanager
    import clip_upload_registry as api

    @contextmanager
    def guard():
        lock = api.acquire_queue_mutation_lock()
        try:
            yield
        finally:
            api.release_queue_mutation_lock(lock)

    # Per-run caches reuse expensive decoding only while the current file identity is unchanged.
    # Fresh directory listings and stat checks still detect new/changed reference documents.
    documents, durations, reference_cache = {}, {}, {}

    def cached(adapter, cache, file):
        file = Path(file)
        identity = file_identity(file)
        key = str(file)
        if key not in cache or cache[key][0] != identity:
            if len(cache) >= 128:
                cache.pop(next(iter(cache)))
            cache[key] = (identity, adapter(file))
        return cache[key][1]

    def read(file):
        return cached(load_json, documents, file)

    def probe(file):
        return cached(probe_duration, durations, file)

    def references(file, roots):
        identity = file_identity(file)
        key = (str(file), tuple(sorted(roots)))
        if key not in reference_cache or reference_cache[key][0] != identity:
            reference_cache[key] = (identity, document_references(file, roots))
        return reference_cache[key][1]

    result = sweep(root, lambda: runtime_backup_protection(root, read, references), args.apply,
                   keep_days=args.keep_days, mutation_guard=guard, read=read, probe=probe,
                   references=references, progress=lambda report: print(
                       f"Backup retention: deleted {report['deletedFiles']} files, {report['deletedBytes']} bytes",
                       file=sys.stderr, flush=True))
    if args.report:
        atomic_json(args.report, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result['errors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
