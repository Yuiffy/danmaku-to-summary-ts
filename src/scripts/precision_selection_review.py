"""Explicit user acceptance of a rendered precision artifact, never automatic approval."""
import copy
import hashlib
import json
import math
from pathlib import Path


def artifact_digests(metadata):
    try:
        from .clip_qa import _file_digest
    except ImportError:
        from clip_qa import _file_digest
    output = metadata.get('output') or {}
    result = {name: _file_digest(output[field]) for name, field in
              [('video', 'mediaPath'), ('subtitles', 'srtPath'), ('cover', 'coverPath')]}
    result['copy'] = hashlib.sha256('\0'.join(str((metadata.get('copy') or {}).get(key) or '')
        for key in ('title', 'coverText', 'description')).encode('utf-8')).hexdigest()
    return result


def _source_window_unresolved(creative):
    """Treat an earlier source-window hold as resolved after a later expansion pass."""
    if 'source_window_incomplete' in str(creative.get('reason') or ''):
        return True
    unresolved = False
    saw_incomplete = False
    for row in creative.get('history') or []:
        if not isinstance(row, dict):
            continue
        stage = row.get('stage')
        if stage == 'source_window_incomplete':
            saw_incomplete = True
            unresolved = True
        elif stage == 'source_expanded' and saw_incomplete:
            unresolved = False
    return unresolved


def validate_feedback_artifact(metadata, baseline):
    """Check current rendered QA; inherited ordinary subtitle drafts are provenance only."""
    qa, creative, output = (metadata.get(key) or {} for key in ('qaResult', 'creativeResult', 'output'))
    if (qa.get('version') != 1 or qa.get('status') != 'passed' or qa.get('issues')
            or creative.get('status') != 'edited' or metadata.get('qaRequired') is not True
            or metadata.get('publicCopyPending') or not output.get('burnedSubtitles')
            or output.get('mediaError') or output.get('coverError')):
        raise ValueError('Precision selection requires current passed rendered-media QA')
    audio = metadata.get('audioQa') or {}
    if (metadata.get('preRenderHold') or metadata.get('sourceExpansionRequest') or metadata.get('storyRepairRequest')
            or _source_window_unresolved(creative)
            or audio and (audio.get('status') != 'passed' or audio.get('issues'))):
        raise ValueError('Precision source or audio review is unresolved')
    window = metadata.get('window') or {}
    if (any(isinstance(window.get(key), bool) or not isinstance(window.get(key), (int, float))
            or not math.isfinite(window[key]) for key in ('start', 'end'))
            or window['start'] < 0 or window['end'] <= window['start']):
        raise ValueError('Precision source window is invalid')
    if artifact_digests(metadata) != qa.get('digests'):
        raise ValueError('Precision artifacts changed after AI quality review')
    draft = metadata.get('renderedSubtitles')
    if draft:
        inherited = baseline.get('renderedSubtitles')
        if (draft != inherited or metadata.get('rebuildRequired')
                or draft.get('renderedSha256') != draft.get('sha256')
                or draft.get('renderedRevision') != draft.get('revision')
                or hashlib.sha256(Path(draft['path']).read_bytes()).hexdigest() != draft.get('sha256')):
            raise ValueError('Inherited baseline subtitle revision changed or needs rendering')


def prepare_feedback_selection(metadata, directory, note, approved_at, cover_image=None):
    """Create a separate human-bound publication copy; keep original AI QA immutable."""
    approved = copy.deepcopy(metadata)
    if not str(note).strip():
        raise ValueError('Explicit user acceptance note is required')
    baseline = json.loads((directory / 'original.json').read_text(encoding='utf-8'))
    for flag in ('qaRequired', 'attributionRequired', 'humanReviewRequired', 'automaticPublicationRequired'):
        if baseline.get(flag) is True:
            approved[flag] = True
    if approved.get('renderedSubtitles'):
        approved['precisionBaselineSubtitles'] = approved.pop('renderedSubtitles')
    if cover_image:
        from PIL import Image, ImageOps
        source = Path(cover_image).resolve()
        image_digest = hashlib.sha256(source.read_bytes()).hexdigest()
        target = directory / 'publication_covers' / f'image-{image_digest[:24]}.jpg'
        target.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(source) as image:
            if image.format not in ('PNG', 'JPEG', 'WEBP') or image.width < 400 or image.height < 225 or image.width * image.height > 20_000_000:
                raise ValueError('Prepared cover must be a valid PNG/JPEG/WebP of at least 400x225 pixels')
            image = ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((1920, 1080))
            image.save(target, 'JPEG', quality=95, optimize=True)
        approved['output']['coverPath'] = str(target)
        approved['preparedCover'] = {'sourcePath': str(source), 'sourceSha256': image_digest,
            'authority': 'user', 'note': note, 'importedAt': approved_at}
        approved['qaResult'] = {**approved['qaResult'], 'status': 'superseded_by_human_review'}
    approved['uploadReady'] = True
    approved['ownStreamHumanReview'] = {'version': 1, 'status': 'approved', 'authority': 'human',
        'clipId': approved['precisionRevision']['clipId'], 'acceptanceMode': 'feedback', 'audioVisualReviewed': False,
        'reviewedAt': approved_at, 'note': note, 'sourceKind': (approved.get('grounding') or {}).get('sourceKind'),
        'source': copy.deepcopy(approved['precisionRevision']['sourceSnapshot']),
        'artifactWindow': {key: approved['window'][key] for key in ('start', 'end')},
        'digests': artifact_digests(approved)}
    return approved
