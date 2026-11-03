"""Manage media workspaces beside recordings; expire only declared, completed caches."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import sys
import time

from clip_media_retention import active_ids, atomic_json, file_identity, load_json, runtime_config
from media_workspace_policy import MEDIA_EXTENSIONS, cache_relative_path, workspace_expiry

MANIFEST = 'WORKSPACE.json'


def checked_child(root, relative):
    """Reject traversal and every symlink/junction below the real workspace root."""
    root = Path(root).absolute()
    candidate = root / relative
    if root.is_symlink() or root.resolve() != root:
        raise ValueError('workspace root must be a physical directory')
    if candidate.absolute() == root or root not in candidate.absolute().parents:
        raise ValueError('path outside workspace root')
    current = candidate
    while current != root:
        if current.is_symlink() or (current.exists() and current.resolve() != current.absolute()):
            raise ValueError('workspace cache path contains a link')
        current = current.parent
    if root not in candidate.resolve().parents:
        raise ValueError('resolved cache path outside workspace root')
    return candidate


def workspace_path(root, name):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,159}', name):
        raise ValueError('workspace name must be a simple ASCII directory name')
    return checked_child(root, name)


def create_workspace(root, name):
    root = Path(root).absolute()
    root.mkdir(parents=True, exist_ok=True)
    workspace = workspace_path(root, name)
    workspace.mkdir(exist_ok=False)
    (workspace / 'scratch').mkdir()
    manifest = {'version': 1, 'status': 'active', 'keepDays': 7,
                'createdAt': time.time(), 'cacheEntries': []}
    atomic_json(workspace / MANIFEST, manifest)
    return {'workspace': str(workspace), 'scratch': str(workspace / 'scratch')}


def close_workspace(root, name, keep_days=7):
    workspace = workspace_path(root, name)
    manifest = load_json(workspace / MANIFEST)
    # Validate policy before changing anything; completion always starts a fresh retention period.
    manifest.update(status='completed', completedAt=time.time(), keepDays=keep_days)
    workspace_expiry(manifest, time.time())
    entries = [entry for entry in manifest.get('cacheEntries', []) if entry.get('kind') != 'scratch']
    for media in (workspace / 'scratch').rglob('*'):
        if media.is_file() and media.suffix.lower() in MEDIA_EXTENSIONS:
            relative = media.relative_to(workspace).as_posix()
            checked_child(workspace, relative)
            entries.append({'kind': 'scratch', 'path': relative, 'identity': file_identity(media)})
    manifest['cacheEntries'] = entries
    atomic_json(workspace / MANIFEST, manifest)
    return {'workspace': str(workspace), 'expiresAt': manifest['completedAt'] + keep_days * 86400,
            'cacheFiles': len(entries)}


def plan_workspace(root, manifest, now, protected=()):
    if not workspace_expiry(manifest, now):
        return [], []
    protected = {os.path.normcase(str(Path(p).resolve())) for p in protected}
    targets, skipped = [], []
    for entry in manifest.get('cacheEntries', []):
        try:
            relative = cache_relative_path(entry)
            media = checked_child(root, relative)
            if not media.exists():
                continue
            if not media.is_file() or file_identity(media) != entry['identity']:
                raise ValueError('cache identity changed')
            if media.stat().st_mtime > now - 7 * 86400:
                raise ValueError('cache was recently modified')
            media_key = os.path.normcase(str(media.resolve()))
            # A queued directory reference protects every child too.
            if any(media_key == p or media_key.startswith(p.rstrip(os.sep) + os.sep) for p in protected):
                raise ValueError('referenced by registry or unfinished work')
            if entry['kind'] == 'remux':
                source = Path(entry['source'])
                if (not source.is_absolute() or not source.is_file() or source.resolve() == media.resolve()
                        or file_identity(source) != entry['sourceIdentity']):
                    raise ValueError('original recording missing or changed')
            targets.append(entry)
        except (ValueError, OSError, KeyError, TypeError) as error:
            skipped.append({'path': entry.get('path') if isinstance(entry, dict) else None, 'reason': str(error)})
    return targets, skipped


def sweep_workspaces(root, protected_provider, apply=False, now=None, remove=None):
    """IO adapters are injected; tests never inspect or mutate the real queues."""
    now = time.time() if now is None else now
    remove = remove or (lambda p: p.unlink())
    root = Path(root).absolute()
    report = {'apply': apply, 'root': str(root), 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
              'plannedBytes': 0, 'deletedBytes': 0, 'deletedFiles': 0, 'skipped': [], 'errors': []}
    if not root.exists():
        return report
    for workspace in sorted(root.iterdir()):
        if not workspace.is_dir() or workspace.is_symlink():
            continue
        try:
            workspace = workspace_path(root, workspace.name)
            manifest_path = checked_child(workspace, MANIFEST)
            if not manifest_path.is_file():
                continue
            manifest = load_json(manifest_path)
            targets, skipped = plan_workspace(workspace, manifest, now, protected_provider())
            report['skipped'].extend({'workspace': workspace.name, **row} for row in skipped)
            report['plannedBytes'] += sum(entry['identity']['bytes'] for entry in targets)
            if not apply:
                continue
            for entry in targets:
                # Re-read manifest/source/identities and recheck the injected reference snapshot.
                current = load_json(manifest_path)
                if current != manifest:
                    raise ValueError('workspace manifest changed during cleanup')
                allowed, reasons = plan_workspace(workspace, {**current, 'cacheEntries': [entry]}, now,
                                                  protected_provider())
                if not allowed:
                    report['skipped'].extend({'workspace': workspace.name, **row} for row in reasons)
                    continue
                journal = workspace / 'RETENTION.json'
                history = load_json(journal) if journal.is_file() else {'version': 1, 'deleted': []}
                history['pending'] = entry
                atomic_json(journal, history)
                remove(checked_child(workspace, entry['path']))
                history['deleted'].append({'path': entry['path'], 'bytes': entry['identity']['bytes'], 'at': now})
                history.pop('pending')
                atomic_json(journal, history)
                report['deletedBytes'] += entry['identity']['bytes']
                report['deletedFiles'] += 1
        except (ValueError, OSError, KeyError, TypeError) as error:
            report['errors'].append({'workspace': workspace.name, 'reason': str(error)})
    return report


def referenced_workspace_paths(value, roots):
    """Filter unrelated archive paths before filesystem resolution (the registry is large)."""
    if isinstance(value, dict):
        for child in value.values():
            yield from referenced_workspace_paths(child, roots)
    elif isinstance(value, list):
        for child in value:
            yield from referenced_workspace_paths(child, roots)
    elif isinstance(value, str) and '\n' not in value and Path(value).is_absolute():
        lexical = os.path.normcase(os.path.abspath(value))
        if any(lexical == root or lexical.startswith(root + os.sep)
               or root.startswith(lexical.rstrip(os.sep) + os.sep) for root in roots):
            yield str(Path(value).resolve())


def runtime_protection(root):
    import clip_upload_registry as api
    registry, queue = load_json(api.REGISTRY_PATH), load_json(api.QUEUE_PATH)
    roots = {os.path.normcase(os.path.abspath(root))}
    if Path(root).exists():
        for workspace in Path(root).iterdir():
            if not workspace.is_dir() or workspace.is_symlink():
                continue
            manifest_path = checked_child(workspace, MANIFEST)
            if manifest_path.is_file():
                old = (load_json(manifest_path).get('legacy') or {}).get('oldPath')
                if old and Path(old).is_absolute():
                    roots.add(os.path.normcase(os.path.abspath(old)))
    # Published outputs also stay protected; expiry is only for explicitly disposable cache entries.
    protected = set(referenced_workspace_paths(registry, roots))
    protected.update(referenced_workspace_paths(queue, roots))
    pending = active_ids(queue)
    for key, record in registry.get('clips', {}).items():
        if record.get('status') != 'uploaded' or str(key) in pending:
            metadata = record.get('metadataPath')
            if metadata and Path(metadata).is_file():
                protected.update(referenced_workspace_paths(load_json(metadata), roots))
    manual = api.RUNTIME_DIR / 'manual_clip_queue.json'
    if manual.is_file():
        for task in load_json(manual).get('tasks', []):
            if task.get('status') not in {'uploaded', 'cancelled', 'done'}:
                protected.update(referenced_workspace_paths(task, roots))
    return protected


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', help='Explicit managed media root; default: recording root/_workspaces')
    commands = parser.add_subparsers(dest='command', required=True)
    create = commands.add_parser('new')
    create.add_argument('--name', required=True)
    close = commands.add_parser('close')
    close.add_argument('--name', required=True)
    close.add_argument('--keep-days', type=int, default=7)
    sweep = commands.add_parser('sweep')
    sweep.add_argument('--apply', action='store_true')
    sweep.add_argument('--report')
    args = parser.parse_args()
    root = Path(args.root) if args.root else Path(runtime_config()['sourceRoot']) / '_workspaces'
    if args.command == 'new':
        result = create_workspace(root, args.name)
    elif args.command == 'close':
        result = close_workspace(root, args.name, args.keep_days)
    else:
        import clip_upload_registry as api
        # Use the existing short queue lock so enqueue admission cannot race cache deletion.
        handle = api.acquire_queue_mutation_lock() if args.apply else None
        try:
            cached_protection = runtime_protection(root)
            result = sweep_workspaces(root, lambda: cached_protection, args.apply)
        finally:
            if handle is not None:
                api.release_queue_mutation_lock(handle)
        if args.report:
            atomic_json(args.report, result)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result.get('errors') else 0


if __name__ == '__main__':
    sys.exit(main())
