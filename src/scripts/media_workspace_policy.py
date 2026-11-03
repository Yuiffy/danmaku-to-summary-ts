"""Pure retention rules for explicitly managed media workspaces."""
import math
from pathlib import PurePosixPath

DAY = 86400
MEDIA_EXTENSIONS = {'.mp4', '.mkv', '.flv', '.mov', '.webm', '.wav', '.mp3', '.opus', '.f32'}


def workspace_expiry(manifest, now):
    if not isinstance(manifest, dict):
        raise ValueError('workspace manifest must be an object')
    if manifest.get('version') != 1:
        raise ValueError('unsupported workspace manifest')
    days = manifest.get('keepDays', 7)
    completed = manifest.get('completedAt')
    if isinstance(days, bool) or not isinstance(days, (int, float)) or not math.isfinite(days) or days < 7:
        raise ValueError('keepDays must be at least 7')
    if manifest.get('status') != 'completed':
        return False
    if isinstance(completed, bool) or not isinstance(completed, (int, float)) or not math.isfinite(completed):
        raise ValueError('completedAt must be a finite UTC timestamp')
    return now >= completed + days * DAY


def cache_relative_path(entry):
    if not isinstance(entry, dict):
        raise ValueError('cache entry must be an object')
    text = entry.get('path', '')
    if not isinstance(text, str) or not text or '\\' in text or ':' in text:
        raise ValueError('cache path must use relative forward slashes')
    path = PurePosixPath(text)
    if path.is_absolute() or any(part in {'', '.', '..'} for part in text.split('/')):
        raise ValueError('unsafe cache path')
    if path.suffix.lower() not in MEDIA_EXTENSIONS:
        raise ValueError('only disposable media may expire')
    kind = entry.get('kind')
    if kind == 'scratch':
        if path.parts[0] != 'scratch' or len(path.parts) < 2:
            raise ValueError('scratch entries must stay inside scratch/')
    elif kind == 'remux':
        recipe = entry.get('rebuild') or {}
        origin = recipe.get('origin')
        if (not entry.get('source') or not entry.get('sourceIdentity')
                or isinstance(origin, bool) or not isinstance(origin, (int, float))
                or not math.isfinite(origin) or origin < 0
                or recipe.get('method') != 'stream-copy-from-origin'):
            raise ValueError('remux requires a bound source and stream-copy recipe')
    else:
        raise ValueError('unknown disposable cache kind')
    if not isinstance(entry.get('identity'), dict):
        raise ValueError('cache identity is required')
    return text
