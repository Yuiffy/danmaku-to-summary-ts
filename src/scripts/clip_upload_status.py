"""Read-only upload progress presentation for the registry facade."""
import json
try:
    from .clip_upload_progress import read_progress, format_progress
except ImportError:
    from clip_upload_progress import read_progress, format_progress


def show_clips(args, api):
    ids = api.parse_int_list(args.ids)
    registry = api.load_json(api.REGISTRY_PATH, api.default_registry())
    api.normalize_registry_media_paths(registry)
    api.sync_clip_statuses(registry, ids)
    api.save_json(api.REGISTRY_PATH, registry)
    for clip_id in ids:
        clip = registry.get('clips', {}).get(str(clip_id))
        if not clip:
            print(f'[MISSING] {clip_id}')
            continue
        progress = read_progress(clip)
        print(json.dumps({**clip, **({'uploadProgress': progress} if progress else {})},
                         ensure_ascii=False, indent=2))
    return 0


def show_job_progress(job, registry):
    for clip_id in job.get('clipIds', []):
        clip = registry.get('clips', {}).get(str(clip_id)) or {}
        progress = read_progress(clip)
        if progress:
            print(f'  progress ID {clip_id}: {format_progress(progress)}')
