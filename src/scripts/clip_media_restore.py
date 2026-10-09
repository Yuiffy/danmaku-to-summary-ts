"""Local-only replay of retained clip windows through the existing media renderers."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess

from clip_media_retention import (ROOT, atomic_json, checked_window, file_identity,
                                  load_json, locate_source, sha256)

# A fixed call adapter only; all rendering algorithms remain in their existing owners.
CALL_ADAPTER = """
const p=JSON.parse(require('fs').readFileSync(0,'utf8'));
Promise.resolve(require(p.module)[p.method](...p.args)).then(r=>
 console.log('MEDIA_RESTORE_RESULT:'+JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1;});
"""


def render_existing(module, method, args):
    result = subprocess.run(['node', '-e', CALL_ADAPTER], cwd=ROOT,
                            env={**os.environ, 'NODE_ENV': 'production'},
                            input=json.dumps({'module': module, 'method': method, 'args': args}, ensure_ascii=False),
                            capture_output=True, encoding='utf-8', errors='replace',
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode:
        raise RuntimeError((result.stderr + result.stdout)[-6000:])
    lines = [line for line in result.stdout.splitlines() if line.startswith('MEDIA_RESTORE_RESULT:')]
    if len(lines) != 1:
        raise RuntimeError('renderer did not return its result')
    return json.loads(lines[0].split(':', 1)[1])


def replay(recipe, output_dir, render=render_existing):
    if recipe.get('version') != 1:
        raise ValueError('unsupported recipe version')
    source = locate_source(recipe['sourceMediaPath'], recipe['sourceRoot'], recipe['archiveRoot'])
    identity = file_identity(source) if source else None
    saved = recipe['sourceIdentity']
    # The existing cross-volume archive copies mtime through a JavaScript Date,
    # which preserves milliseconds and drops the original sub-millisecond ticks.
    archived = source is not None and source != Path(recipe['sourceMediaPath']).resolve()
    timestamp_matches = identity is not None and (identity['mtimeNs'] == saved['mtimeNs']
        or archived and abs(int(identity['mtimeNs']) - int(saved['mtimeNs'])) < 1_000_000)
    if not identity or identity['bytes'] != saved['bytes'] or not timestamp_matches:
        raise ValueError('original recording missing or changed; restore that recording first')
    output_dir = Path(output_dir).resolve()
    # Exclusive directory creation prevents accidental replacement of published artifacts.
    output_dir.mkdir(parents=True, exist_ok=False)
    settings = recipe['renderSettings']
    result = {'clipId': recipe['clipId'], 'bvid': recipe['bvid'], 'outputs': [], 'uploaded': False}
    atomic_json(output_dir / 'REPLAY_RECIPE.json', recipe)
    for index, target in enumerate(recipe['targets'], 1):
        window = checked_window(target['window'])
        media = output_dir / f'{index:02d}_{Path(target["mediaPath"]).name}'
        srt = media.with_suffix('.srt')
        if target.get('srtContent') is not None:
            srt.write_text(target['srtContent'], encoding='utf-8')
        elif target.get('srtPath'):
            original_srt = locate_source(target['srtPath'], recipe['sourceRoot'], recipe['archiveRoot'])
            if not original_srt or sha256(original_srt) != target['srtSha256']:
                raise ValueError('final reviewed subtitles missing or changed')
            srt.write_bytes(original_srt.read_bytes())
        if recipe['kind'] in {'stream_activity_submission', 'stream_game_submission'}:
            method = 'renderGamePart' if recipe['kind'] == 'stream_game_submission' else 'renderActivityPart'
            module = './src/scripts/clipping/stream_game_media' if method == 'renderGamePart' else './src/scripts/clipping/stream_activity_media'
            rendered = render(module, method, [str(source), window, str(media), settings, {'mode': 'idle', 'ffmpegThreads': 2}])
        else:
            metadata = recipe['metadata']
            output = metadata.get('output') or {}
            cut_config = output.get('renderSettings')
            if not cut_config:
                cut_config = dict(settings.get('clipTopics') or {})
                if recipe['kind'] == 'own_stream_fun_review':
                    cut_config.update(settings.get('ownStreamClips') or {})
                elif recipe['kind'] == 'manual_clip_queue':
                    own = settings.get('ownStreamClips') or {}
                    for key in ('subtitleVideoEncoder', 'subtitleVideoPreset', 'subtitleVideoCrf', 'subtitleVideoCq', 'subtitleHwaccel'):
                        if key in own:
                            cut_config[key] = own[key]
                cut_config.update({k: output[k] for k in ('twoStageMode', 'twoStageSubtitleBurn') if output.get(k) is not None})
            cut_config = {**cut_config, 'burnSubtitles': target['burnedSubtitles'], 'preserveCoverSource': False,
                          'ffmpegPath': settings.get('audio', {}).get('ffmpeg', {}).get('path') or 'ffmpeg',
                          'ffmpegThreads': 2}
            rendered = render('./src/scripts/topic_clipper', 'cutClipMedia',
                              [{'kind': 'video', 'mediaPath': str(source)}, window,
                               str(srt) if srt.is_file() else None, str(media), cut_config])
            if target['burnedSubtitles'] and rendered.get('burnedSubtitles') is not True:
                raise RuntimeError('replay did not preserve burned subtitles')
        if not media.is_file() or media.stat().st_size == 0:
            raise RuntimeError('renderer did not produce a video')
        result['outputs'].append({'mediaPath': str(media), 'window': window, 'rendered': rendered})
        atomic_json(output_dir / 'REPLAY_RESULT.json', result)
    return result


def restore(clip_id, output_dir, config):
    import clip_upload_registry as api
    clip = load_json(api.REGISTRY_PATH).get('clips', {}).get(str(clip_id))
    if not clip or not clip.get('metadataPath'):
        raise ValueError('unknown clip metadata')
    path = Path(clip['metadataPath']).with_suffix('.media-retention.json')
    path = locate_source(path, config['sourceRoot'], config['archiveRoot'])
    if not path:
        raise ValueError('no retained recipe for this clip')
    recipe = load_json(path)
    if recipe.get('clipId') != clip_id:
        raise ValueError('retained recipe clip ID differs')
    return replay(recipe, output_dir)
