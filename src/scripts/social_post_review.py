"""Screenshot-video artifact review. Does not authorize or perform publication."""
import hashlib
import math
from pathlib import Path


def _digest(file):
    result = hashlib.sha256()
    with Path(file).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def validate_social_post_review(metadata):
    review = metadata.get('socialPostReview') or {}
    if (metadata.get('type') != 'social_post_video' or metadata.get('publicationKind') != 'social_post'
            or metadata.get('uploadReady') is not True or review.get('version') != 1
            or review.get('status') != 'passed' or not str(review.get('reviewer') or '').strip()
            or not str(review.get('note') or '').strip()):
        raise ValueError('social post needs a completed local source/video/copy review')
    evidence = {key: metadata.get(key) for key in ('source', 'plan', 'inputHashes', 'copy', 'window', 'upload')}
    if evidence != review.get('evidence'):
        raise ValueError('social post evidence or publishing copy changed after review')
    source, plan = metadata['source'], metadata['plan']
    if source.get('sourceKind') != 'social_post' or {k: v for k, v in source.items() if k != 'sourceKind'} != plan['source']:
        raise ValueError('social post source does not match its render plan')
    actual_inputs = {'screenshot': _digest(source['image'])}
    if plan.get('music'):
        actual_inputs['music'] = _digest(plan['music']['path'])
    for index, page in enumerate(source.get('pages') or [], 1):
        actual_inputs[f'page{index}'] = _digest(page['image'])
    if actual_inputs != metadata['inputHashes']:
        raise ValueError('social post source screenshot/music changed after rendering')
    output = metadata['output']
    if review.get('digests') != {'video': _digest(output['mediaPath']), 'cover': _digest(output['coverPath'])}:
        raise ValueError('social post video/cover changed after review')


def social_registry_errors(clip, metadata):
    """Preserve the source-specific gate when registry records are refreshed."""
    if not clip.get('socialReviewRequired') and metadata.get('type') != 'social_post_video':
        return []
    try:
        validate_social_post_review(metadata)
        if not clip.get('socialReviewRequired'):
            raise ValueError('required social-post review flag was removed')
        expected = {**{key: metadata['copy'][key] for key in ('title', 'description')},
                    **metadata['output'], **{key: metadata['upload'][key] for key in ('prefix', 'tags', 'source', 'tid')},
                    'publicationKind': 'social_post'}
        for key, value in expected.items():
            actual = clip.get(key)
            same = Path(actual).resolve() == Path(value).resolve() if key.endswith('Path') and actual else actual == value
            if not same:
                raise ValueError(f'registry {key} differs from reviewed social post')
    except (OSError, ValueError, TypeError, KeyError) as error:
        return [str(error)]
    return []


def validate_social_post_revision(original, revision):
    """Bind a reviewed timing/presentation revision to the same post, pages and copy."""
    validate_social_post_review(original)
    validate_social_post_review(revision)
    for key in ('inputHashes', 'copy', 'upload'):
        if original[key] != revision[key]:
            raise ValueError('Social-post revision must preserve source assets and publishing copy')
    def content(plan):
        value = {**plan, 'source': {k: v for k, v in plan['source'].items() if k != 'image'}}
        if 'pages' in value['source']:
            value['source']['pages'] = [{k: v for k, v in page.items() if k != 'image'} for page in value['source']['pages']]
        if plan.get('music'):
            value['music'] = {k: v for k, v in plan['music'].items() if k != 'path'}
        value['scenes'] = [{k: v for k, v in scene.items() if k != 'seconds'} for scene in plan['scenes']]
        return value
    if content(original['plan']) != content(revision['plan']):
        raise ValueError('Social-post revision must preserve all scene content and ordering')
    old = [scene['seconds'] for scene in original['plan']['scenes']]
    new = [scene['seconds'] for scene in revision['plan']['scenes']]
    if not old or len(old) != len(new) or any(not isinstance(t, (int, float)) or not math.isfinite(t) or t <= 0 for t in old + new):
        raise ValueError('Social-post revision has invalid scene durations')
    if revision['window'] != {'start': 0, 'end': sum(new), 'duration': sum(new)}:
        raise ValueError('Social-post revision duration does not match its scenes')
    if Path(original['output']['mediaPath']).resolve() == Path(revision['output']['mediaPath']).resolve():
        raise ValueError('Social-post revision must retain the original media separately')


def validate_speed_revision(original, revision):
    """Compatibility entry for a strictly uniform speed increase."""
    validate_social_post_revision(original, revision)
    old = [scene['seconds'] for scene in original['plan']['scenes']]
    new = [scene['seconds'] for scene in revision['plan']['scenes']]
    factor = old[0] / new[0]
    if factor <= 1 or any(not math.isclose(a / b, factor) for a, b in zip(old, new)):
        raise ValueError('Speed revision must uniformly shorten every scene')
