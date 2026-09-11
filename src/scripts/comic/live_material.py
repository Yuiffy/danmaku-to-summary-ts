"""Use validated original excerpts, falling back to the complete source."""
import hashlib
import json
import math
from pathlib import Path


def _sha(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def select_comic_material(highlight_path, room_id, config, full_source, log=print):
    experiment = (config or {}).get('ai', {}).get('roomSettings', {}).get(str(room_id), {}).get('fullLiveContextExperiment') or {}
    recipe = experiment.get('replySummary') or {}
    if not experiment.get('enabled') or not recipe.get('enabled') or not (recipe.get('sharedMaterial') or {}).get('enabled'):
        return full_source
    stem = Path(highlight_path).stem.removesuffix('_AI_HIGHLIGHT')
    state_path = Path(highlight_path).with_name(stem + '_REPLY_SUMMARY.json')
    try:
        state = json.loads(state_path.read_text(encoding='utf-8-sig'))
        material = state.get('sharedMaterial') or {}
        if state.get('status') != 'success' or material.get('status') != 'ready':
            raise ValueError('No accepted material pool')
        if str(state.get('roomId')) != str(room_id) or str(material.get('roomId')) != str(room_id):
            raise ValueError('Material belongs to another room')
        if material.get('version') != 1 or state.get('semanticReview', {}).get('verdict') not in ('pass', 'corrected'):
            raise ValueError('Material requires accepted evidence review')
        if material.get('fullSourceSha256') != full_source.get('sourceSha256') or state.get('sourceSha256') != full_source.get('sourceSha256'):
            raise ValueError('Material source changed')
        if material.get('fullPrefixSha256') != full_source.get('sharedPrefixSha256'):
            raise ValueError('Material prefix changed')
        evidence = full_source.get('evidence') or {}
        by_id = {row['id']: row for row in evidence.get('speech', []) + evidence.get('audience', [])}
        ids = material.get('sourceIds')
        if not isinstance(ids, list) or not ids or any(not isinstance(key, str) or key not in by_id for key in ids) or len(set(ids)) != len(ids):
            raise ValueError('Invalid material source IDs')
        rows = [by_id[key] for key in ids]
        rendered = '\n'.join(f"{row['id']} {math.floor(row['start'])}-{math.ceil(row['end'])} {row['source']}"
                             + (f" [{row['speaker']}]" if row.get('speaker') else '') + f": {row['text']}" for row in rows)
        if rendered != material.get('sourceText') or _sha(rendered) != material.get('sourceSha256'):
            raise ValueError('Material is not the exact original evidence')
        prefix = material.get('sharedPrefix')
        # Verify every byte surrounding the original text as well as its digest.
        full_prefix = full_source['sharedPrefix']
        start_marker, end_marker = full_prefix.split('\n', 1)[0], full_prefix.rsplit('\n', 1)[-1]
        expected = '\n'.join([start_marker, 'Original live excerpts selected from a full-stream reading.',
            'These are partial original sources, not a complete transcript. Missing material is unknown, not absent.',
            'T IDs are speech; D IDs are audience, never speaker identities. Preserve named/unknown speakers, negation and nearby context.',
            'Use only these original excerpts as event evidence. Watched videos, lyrics, imagined scenes and audience comments are not host actions.',
            'Excerpts keep their original timestamps. Across gaps, do not imply adjacent dialogue or a continuous event.',
            rendered, end_marker])
        if prefix != expected or _sha(prefix) != material.get('sharedPrefixSha256'):
            raise ValueError('Material prefix integrity mismatch')
        limits = recipe['sharedMaterial']
        if len(prefix) > float(limits.get('maxSourceChars', 45000)) or len(prefix) >= len(full_prefix) * float(limits.get('maxSourceRatio', 0.7)):
            raise ValueError('Material exceeds input budget')
        log(f'[LIVE_MATERIAL] room={room_id} sourceChars={len(full_prefix)} selectedChars={len(prefix)} sourceRows={len(rows)}')
        return {**full_source, 'sourceText': rendered, 'sharedPrefix': prefix,
                'sourceSha256': material['sourceSha256'], 'sharedPrefixSha256': material['sharedPrefixSha256'],
                'fullSourceSha256': full_source['sourceSha256'], 'coverage': 'selected_original_excerpts_with_context',
                'materialGenerationId': state.get('generationId')}
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as error:
        log(f'[LIVE_MATERIAL_FALLBACK] room={room_id} reason={error}; using complete source')
        return full_source
