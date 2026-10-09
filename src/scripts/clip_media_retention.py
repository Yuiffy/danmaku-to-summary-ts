"""Expire reproducible, successfully submitted Sui media; never mutate upload state."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DAY = 86400
VIDEO_EXTENSIONS = {'.mp4', '.flv', '.mkv', '.mov', '.ts', '.webm'}
SIMPLE_MODES = {'own_stream_fun_review', 'manual_clip_queue', 'topic_candidate_manual_cut'}
PART_TYPES = {'stream_activity_submission', 'stream_game_submission'}
MEDIA_SETTINGS = {
    'subtitleVideoEncoder', 'subtitleVideoPreset', 'subtitleVideoCrf', 'subtitleVideoCq',
    'subtitleHwaccel', 'subtitleCpuFallbackPreset', 'subtitleFontName', 'subtitleFontSizeRatio',
    'subtitlePortraitFontSizeRatio', 'subtitleMinFontSize', 'subtitleMaxFontSize', 'subtitlePlayResX',
    'subtitlePlayResY', 'subtitleMarginV', 'subtitleMarginL', 'subtitleMarginR', 'subtitleMarginHorizontal',
    'subtitleGlyphWidthRatio', 'subtitleMaxCharsPerLine', 'twoStagePreRollSeconds', 'twoStagePostRollSeconds',
    'twoStageMode', 'twoStageSubtitleBurn', 'burnSubtitles', 'clipFfmpegThreads', 'ffmpegTimeoutMs',
}


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + '.writing')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def stamp(value):
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, TypeError, OverflowError):
        return None


def successful_at(clip):
    state = clip.get('uploadState') or {}
    if clip.get('status') != 'uploaded' or not re.fullmatch(r'BV[0-9A-Za-z]+', str(state.get('bvid') or '')):
        return None
    # Historical title-only search_dup records are insufficient deletion evidence.
    if state.get('source') != 'ok' or not state.get('mediaPath'):
        return None
    if Path(state['mediaPath']).resolve() != Path(clip.get('mediaPath') or '').resolve():
        return None
    values = [stamp(state.get('submittedAt')), stamp(clip.get('uploadedAt'))]
    values = [value for value in values if value is not None]
    return max(values) if values else None


def active_ids(queue):
    return {str(i) for job in queue.get('jobs', [])
            if job.get('status') not in {'done', 'cancelled', 'failed'}
            for i in job.get('clipIds', [])}


def path_strings(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from path_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from path_strings(item)
    elif isinstance(value, str) and '\n' not in value and (Path(value).is_absolute()):
        yield str(Path(value).resolve())


def protected_paths(registry, queue, extra=(), now=None, days=3):
    pending = active_ids(queue)
    protected = set(extra)
    for key, record in registry.get('clips', {}).items():
        uploaded = successful_at(record)
        if uploaded is None or str(key) in pending or (now is not None and now - uploaded < days * DAY):
            protected.update(path_strings(record))
            metadata = record.get('metadataPath')
            if metadata and Path(metadata).is_file():
                protected.update(path_strings(load_json(metadata)))
    return protected


def strict_child(path, root):
    path, root = Path(path).resolve(), Path(root).resolve()
    return path != root and root in path.parents


def locate_source(path, source_root, archive_root):
    path = Path(path)
    if path.is_file():
        return path.resolve()
    try:
        alternative = Path(archive_root) / path.relative_to(source_root)
    except ValueError:
        return None
    return alternative.resolve() if alternative.is_file() else None


def file_identity(path):
    stat = Path(path).stat()
    return {'bytes': stat.st_size, 'mtimeNs': str(stat.st_mtime_ns)}


def checked_window(window):
    start, end = window.get('start'), window.get('end')
    if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
        raise ValueError('missing exact source window')
    if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
        raise ValueError('invalid source window')
    return {'start': start, 'end': end, 'duration': end - start}


def build_recipe(clip, metadata, settings, source_root, archive_root, previous=None):
    kind = metadata.get('type') or metadata.get('mode')
    if kind not in SIMPLE_MODES | PART_TYPES:
        raise ValueError('unsupported render recipe')
    if str(metadata.get('roomId') or clip.get('roomId')) != '25788785':
        raise ValueError('outside Sui room')
    if (any(metadata.get(key) for key in ('editPlan', 'creativePlan', 'enhancements', 'enhancementResult'))
        or any(metadata.get(key) and metadata[key].get('status') != 'kept_original'
               for key in ('creativeResult', 'pacingResult'))
        or (metadata.get('precisionExperiment') or {}).get('selected') is True):
        raise ValueError('edited media needs a dedicated replay recipe')
    source = metadata.get('source') or {}
    source_file = locate_source(source.get('mediaPath') or '', source_root, archive_root)
    if not source_file or source_file.suffix.lower() not in VIDEO_EXTENSIONS:
        raise ValueError('original video unavailable')
    if not any(strict_child(source_file, root) and len(source_file.relative_to(Path(root).resolve()).parts) == 3
               for root in (source_root, archive_root)):
        raise ValueError('source is not an original room/date recording')
    if previous and (previous.get('clipId') != clip['id'] or previous.get('submittedAt') != successful_at(clip)
                     or previous.get('metadataSha256') != sha256(clip['metadataPath'])
                     or previous.get('sourceIdentity') != file_identity(source_file)):
        raise ValueError('retained recipe no longer matches submission')
    output = metadata.get('output') or {}
    parts = output.get('parts') if kind in PART_TYPES else None
    if kind in PART_TYPES and not parts:
        raise ValueError('missing multipart timeline')
    if kind == 'stream_game_submission' and clip.get('uploadState', {}).get('subtitleStatus') != 'complete':
        raise ValueError('game subtitle publication unfinished')
    targets = []
    for part in parts or [output]:
        media = Path(part.get('mediaPath') or '')
        if re.search(r'\.(?:creative|edited)(?:\.|$)', media.name, re.IGNORECASE):
            raise ValueError('edited output needs a dedicated replay recipe')
        saved = next((t for t in (previous or {}).get('targets', []) if Path(t['mediaPath']) == media.resolve()), None)
        if (not media.is_file() and not saved) or media.suffix.lower() not in VIDEO_EXTENSIONS:
            raise ValueError('missing media in submission')
        if media.is_file() and saved and file_identity(media) != saved['identity']:
            raise ValueError('media replaced since retained recipe')
        if not strict_child(media, source_root) or source_file == media.resolve():
            raise ValueError('unsafe derived media path')
        relative = media.resolve().relative_to(Path(source_root).resolve())
        # Room/date/source is the recording itself, never an expirable derived clip.
        if len(relative.parts) < 4 or not relative.parts[0].startswith('25788785_'):
            raise ValueError('not a Sui derived video')
        window = checked_window(part if parts else metadata.get('window') or {})
        srt = part.get('srtPath') or (output.get('srtPath') or clip.get('srtPath') if not parts or len(parts) == 1 else None)
        burned = bool(output.get('burnedSubtitles')) if not parts else False
        if burned and (not srt or not Path(srt).is_file()):
            raise ValueError('final reviewed subtitles unavailable')
        # External subtitles are also retained and verified before deleting game media.
        if kind == 'stream_game_submission' and (not srt or not Path(srt).is_file()):
            raise ValueError('external subtitles unavailable')
        targets.append({'mediaPath': str(media.resolve()), 'identity': saved['identity'] if saved else file_identity(media),
                        'window': window, 'part': part if parts else None, 'burnedSubtitles': burned,
                        'srtPath': str(Path(srt).resolve()) if srt and Path(srt).is_file() else None,
                        'srtSha256': sha256(srt) if srt and Path(srt).is_file() else None,
                        'srtContent': Path(srt).read_text(encoding='utf-8-sig') if srt and Path(srt).is_file() else None})
    if Path(clip.get('mediaPath') or '').resolve() not in {Path(p['mediaPath']) for p in targets}:
        raise ValueError('registered media differs from metadata')
    return {'version': 1, 'clipId': clip['id'], 'kind': kind, 'bvid': clip['uploadState']['bvid'],
            'submittedAt': successful_at(clip), 'sourceMediaPath': str(source_file),
            'sourceIdentity': file_identity(source_file), 'sourceRoot': str(source_root),
            'archiveRoot': str(archive_root), 'metadataPath': clip['metadataPath'],
            'metadataSha256': sha256(clip['metadataPath']), 'metadata': metadata,
            'renderSettings': (previous or {}).get('renderSettings') or settings, 'targets': targets}


def plan_candidates(registry, queue, settings, source_root, archive_root, now, days=3, extra=()):
    protected = protected_paths(registry, queue, extra, now, days)
    candidates, skipped = [], []
    for key, clip in registry.get('clips', {}).items():
        uploaded = successful_at(clip)
        if uploaded is None or now - uploaded < days * DAY or str(key) in active_ids(queue):
            continue
        metadata = clip.get('metadataPath')
        if not metadata or not Path(metadata).is_file():
            continue
        try:
            receipt = Path(metadata).with_suffix('.media-retention.json')
            if not Path(clip.get('mediaPath') or '').is_file() and not receipt.is_file():
                continue
            recipe = build_recipe(clip, load_json(metadata), settings, source_root, archive_root,
                                  load_json(receipt) if receipt.is_file() else None)
            if not any(Path(t['mediaPath']).is_file() for t in recipe['targets']):
                continue
            if any(p['mediaPath'] in protected for p in recipe['targets']):
                raise ValueError('referenced by an unfinished clip')
            candidates.append(recipe)
        except (ValueError, OSError, TypeError, KeyError) as error:
            skipped.append({'id': clip.get('id'), 'reason': str(error)})
    return candidates, skipped


def receipt_path(recipe):
    return Path(recipe['metadataPath']).with_suffix('.media-retention.json')


def apply_recipe(recipe, current_registry, current_queue, remove=Path.unlink, extra=(), now=None, days=3, protected=None):
    now = now if now is not None else dt.datetime.now(dt.timezone.utc).timestamp()
    clip = current_registry.get('clips', {}).get(str(recipe['clipId'])) or {}
    if successful_at(clip) != recipe['submittedAt'] or clip.get('uploadState', {}).get('bvid') != recipe['bvid']:
        raise ValueError('upload identity changed during retention')
    if now - recipe['submittedAt'] < days * DAY:
        raise ValueError('upload retention period has not elapsed')
    if str(recipe['clipId']) in active_ids(current_queue):
        raise ValueError('clip has an unfinished upload job')
    if str(clip.get('metadataPath')) != recipe['metadataPath'] or sha256(recipe['metadataPath']) != recipe['metadataSha256']:
        raise ValueError('metadata changed during retention')
    if protected is None:
        protected = protected_paths(current_registry, current_queue, extra, now, days)
    if file_identity(recipe['sourceMediaPath']) != recipe['sourceIdentity']:
        raise ValueError('source changed during retention')
    previous = load_json(receipt_path(recipe)) if receipt_path(recipe).is_file() else None
    if previous and any(previous.get(k) != recipe.get(k) for k in ('clipId', 'metadataSha256', 'submittedAt', 'targets')):
        raise ValueError('receipt changed during retention')
    for target in recipe['targets']:
        path = Path(target['mediaPath'])
        if not strict_child(path, recipe['sourceRoot']) or str(path.resolve()) in protected:
            raise ValueError('unsafe or newly referenced media')
        if not path.is_file() and previous:
            continue
        if file_identity(path) != target['identity']:
            raise ValueError('media changed during retention')
        if target['srtPath'] and sha256(target['srtPath']) != target['srtSha256']:
            raise ValueError('subtitles changed during retention')
    receipt = previous or {**recipe, 'status': 'prepared', 'preparedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'deleted': []}
    atomic_json(receipt_path(recipe), receipt)
    # Recipe and metadata exist before the first unlink, including after an interrupted run.
    deleted_bytes = 0
    for target in recipe['targets']:
        path = Path(target['mediaPath'])
        if path.is_file():
            remove(path)
            deleted_bytes += target['identity']['bytes']
        if target['mediaPath'] not in receipt['deleted']:
            receipt['deleted'].append(target['mediaPath'])
        atomic_json(receipt_path(recipe), receipt)
    receipt.update(status='deleted', deletedAt=dt.datetime.now(dt.timezone.utc).isoformat())
    atomic_json(receipt_path(recipe), receipt)
    return deleted_bytes


CONFIG_ADAPTER = """
const c=require('./src/scripts/config-loader').getConfig();
console.log(JSON.stringify({sourceRoot:c.webhook.endpoints.mikufans.basePath,
 archiveRoot:c.audio.storage.archiveTargetBasePath,policy:c.audio.storage.publishedClipRetention,
 settings:{clipTopics:c.clipTopics,ownStreamClips:c.ownStreamClips,
 streamGameClips:{requireOriginalStreamCopy:c.streamGameClips?.requireOriginalStreamCopy},
 audio:{ffmpeg:{path:c.audio.ffmpeg.path}}}}));
"""


def runtime_config():
    env = {**os.environ, 'NODE_ENV': 'production'}
    result = subprocess.run(['node', '-e', CONFIG_ADAPTER], cwd=ROOT, env=env,
                            capture_output=True, encoding='utf-8', check=True,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    config = json.loads(result.stdout)
    for section in ('clipTopics', 'ownStreamClips'):
        config['settings'][section] = {k: v for k, v in (config['settings'].get(section) or {}).items() if k in MEDIA_SETTINGS}
    return config


def sweep(config, apply=False, now=None, limit=None):
    import clip_upload_registry as api
    now = now or dt.datetime.now(dt.timezone.utc).timestamp()
    policy = config.get('policy') or {}
    if policy.get('enabled') is not True:
        return {'enabled': False, 'deletedBytes': 0}
    days = policy.get('afterUploadDays', 3)
    if isinstance(days, bool) or not isinstance(days, (int, float)) or not math.isfinite(days) or days < 3:
        raise ValueError('afterUploadDays must be at least 3')
    registry, queue = load_json(api.REGISTRY_PATH), load_json(api.QUEUE_PATH)
    def manual_paths():
        extra = set()
        manual = api.RUNTIME_DIR / 'manual_clip_queue.json'
        if manual.is_file():
            for task in load_json(manual).get('tasks', []):
                if task.get('status') not in {'uploaded', 'cancelled', 'done'}:
                    extra.update(path_strings(task))
        return extra
    extra = manual_paths()
    candidates, skipped = plan_candidates(registry, queue, config['settings'], config['sourceRoot'],
                                          config['archiveRoot'], now, days, extra)
    if limit is not None:
        candidates = candidates[:limit]
    report: dict[str, Any] = {'enabled': True, 'apply': apply, 'startedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'plannedClips': len(candidates),
                            'plannedBytes': sum(t['identity']['bytes'] for r in candidates for t in r['targets'] if Path(t['mediaPath']).is_file()),
                            'candidateIds': [r['clipId'] for r in candidates],
                            'deletedClips': 0, 'deletedBytes': 0, 'skipped': skipped, 'errors': []}
    for offset in range(0, len(candidates), 20):
        if not apply:
            break
        handle = api.acquire_queue_mutation_lock()
        try:
            current, current_queue = load_json(api.REGISTRY_PATH), load_json(api.QUEUE_PATH)
            extra = manual_paths()
            protected = protected_paths(current, current_queue, extra, now, days)
            for recipe in candidates[offset:offset + 20]:
                try:
                    report['deletedBytes'] += apply_recipe(recipe, current, current_queue, extra=extra, now=now, days=days, protected=protected)
                    report['deletedClips'] += 1
                except (ValueError, OSError) as error:
                    report['errors'].append({'id': recipe['clipId'], 'error': str(error)})
        finally:
            api.release_queue_mutation_lock(handle)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    command = sub.add_parser('sweep')
    command.add_argument('--apply', action='store_true')
    command.add_argument('--limit', type=int)
    command.add_argument('--report')
    command = sub.add_parser('restore')
    command.add_argument('--id', type=int, required=True)
    command.add_argument('--output-dir', required=True)
    args = parser.parse_args()
    if args.command == 'restore':
        from clip_media_restore import restore
        result = restore(args.id, Path(args.output_dir), runtime_config())
    else:
        result = sweep(runtime_config(), args.apply, limit=args.limit)
    if getattr(args, 'report', None):
        atomic_json(args.report, result)
    print(json.dumps(result, ensure_ascii=False))
    return int(bool(result.get('errors')))


if __name__ == '__main__':
    sys.exit(main())
