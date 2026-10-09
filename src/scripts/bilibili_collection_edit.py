"""Rename an existing collection episode without replacing or reordering its video."""
from __future__ import annotations

import time
import requests

try:
    from .bilibili_upload import _build_cookie_str, list_collection_seasons
except ImportError:
    from bilibili_upload import _build_cookie_str, list_collection_seasons


def rename_episode(episode, title, credential):
    if not str(title).strip() or len(title) > 80:
        raise ValueError('Invalid collection episode title')
    seasons = list_collection_seasons(credential)
    current = next((row for season in seasons for row in season.get('part_episodes') or []
                    if row.get('id') == episode.get('id')), None)
    fields = ('id', 'aid', 'cid', 'seasonId', 'sectionId', 'title', 'order')
    if not current or any(current.get(key) != episode.get(key) for key in fields):
        raise RuntimeError('Collection episode changed while preparing its title update')
    if current['title'] == title:
        return {'code': 0, 'unchanged': True}
    csrf = credential.bili_jct
    response = requests.post('https://member.bilibili.com/x2/creative/web/season/section/episode/edit',
        params={'csrf': csrf, 't': str(int(time.time()*1000))},
        json={**{key: current[key] for key in ('id', 'aid', 'cid', 'seasonId', 'sectionId')}, 'title': title},
        headers={'Cookie': _build_cookie_str(credential), 'User-Agent': 'Mozilla/5.0',
                 'Content-Type': 'application/json', 'Origin': 'https://member.bilibili.com',
                 'Referer': 'https://member.bilibili.com/platform/upload-manager'}, timeout=20)
    response.raise_for_status()
    payload = response.json()
    if payload.get('code') != 0:
        raise RuntimeError(f"Collection episode edit failed: {payload.get('code')} {payload.get('message', '')}")
    return payload
