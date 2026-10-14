"""Revalidate song-catalog lyric citations; these never approve a singer or boundary."""
import hashlib
import re
import unicodedata


def normalized(text):
    return ''.join(c for c in unicodedata.normalize('NFKC', str(text)).lower() if c.isalnum())


def lyric_lines(lyrics):
    return set(line for raw in lyrics.splitlines() if (line := re.sub(r'\[[^\]]*\]', '', raw).strip())
               and len(normalized(line)) >= 6 and not re.match(r'^(作词|作曲|编曲|制作|演唱|词|曲|lyricist|composer)\s*[:：]', line, re.I))


def match_length(quote, lyric):
    left, right = normalized(quote), normalized(lyric)
    if min(len(left), len(right)) < 6 or max(len(left), len(right)) > 500:
        return 0
    previous, best = [0] * (len(right) + 1), 0
    for char in left:
        for i in range(len(right), 0, -1):
            previous[i] = previous[i - 1] + 1 if char == right[i - 1] else 0
            best = max(best, previous[i])
    return best if best >= 6 and best / min(len(left), len(right)) >= .85 else 0


def check_catalog_title(item, event, rows):
    catalog = item.get('catalog') or {}
    name = str(catalog.get('name') or '').strip()
    prefix = re.match(r'^【([^】]+)】', name)
    if prefix and all(any(normalized(artist) == normalized(label) for artist in catalog.get('artists', [])) for label in re.split(r'[/、&]', prefix[1])):
        name = name[len(prefix[0]):].strip()
    cover = re.fullmatch(r'《([^《》]+)》\s*(?:(?:\d+[pP])?多人)?(?:翻唱|合唱|cover)', name, re.I)
    name = cover[1] if cover else re.sub(r'\s*[（(](?:[^）)]*\b(?:cover|live)\b[^）)]*|现场版|翻唱)[）)]\s*$', '', name, flags=re.I).strip()
    lyrics = catalog.get('lyrics')
    if (catalog.get('provider') != 'netease' or not re.fullmatch(r'[1-9]\d{0,14}', str(catalog.get('id') or ''))
            or item.get('name') != name or not isinstance(lyrics, str) or len(lyrics) > 50000
            or hashlib.sha256(lyrics.encode('utf-8')).hexdigest() != catalog.get('lyricSha256')
            or catalog.get('url') != f"https://music.163.com/song?id={catalog['id']}"):
        raise ValueError('invalid song catalog identity')
    matches, lines, cited = item.get('matches'), lyric_lines(lyrics), set()
    if not isinstance(matches, list) or len(matches) > 300:
        raise ValueError('invalid catalog lyric matches')
    for match in matches:
        indices = match.get('segmentIndices')
        if (not isinstance(indices, list) or not 1 <= len(indices) <= 3 or match.get('lyric') not in lines
                or any(type(i) is not int or not 1 <= i <= len(rows) for i in indices)):
            raise ValueError('invalid catalog lyric citation')
        selected = [dict(index=i, **rows[i - 1]) for i in indices]
        if (any(s['start'] < event['start'] or s['end'] > event['end']
                or j > 0 and (s['index'] != selected[j - 1]['index'] + 1 or s['start'] - selected[j - 1]['end'] > 3)
                for j, s in enumerate(selected)) or selected[-1]['end'] - selected[0]['start'] > 25
                or ' '.join(s['text'] for s in selected) != match.get('quote')
                or not (size := match_length(match['quote'], match['lyric'])) or size != match.get('matchedCharacters')):
            raise ValueError('catalog lyric match differs from current source')
        cited.update(indices)
    segments = [dict(index=i, **rows[i - 1]) for i in sorted(cited)]
    unique = {normalized(m['lyric']): m for m in matches}
    if (item.get('segments') != segments or len(unique) < 3 or len(cited) < 3
            or len({normalized(m['quote']) for m in matches}) < 3
            or sum(m['matchedCharacters'] for m in unique.values()) < 30
            or max(s['end'] for s in segments) - min(s['start'] for s in segments) < min(15, (event['end'] - event['start']) / 3)):
        raise ValueError('insufficient independent lyric evidence')
