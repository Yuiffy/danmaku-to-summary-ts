import copy
import hashlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'scripts'))
from activity_song_identity import check_catalog_title


class SongIdentityTest(unittest.TestCase):
    def fixture(self):
        texts = ['沿着安静的小路走到山坡那一头', '晚风把云朵悄悄推到我的窗口', '明天把这些故事写进新画册里头']
        rows = [{'start': 110 + i * 15, 'end': 114 + i * 15, 'text': text} for i, text in enumerate(texts)]
        lyrics = '\n'.join(texts)
        item = {'name': '测试之歌', 'segments': [dict(index=i + 1, **row) for i, row in enumerate(rows)],
                'catalog': {'provider': 'netease', 'id': '123', 'name': '测试之歌', 'lyrics': lyrics,
                            'lyricSha256': hashlib.sha256(lyrics.encode()).hexdigest(), 'url': 'https://music.163.com/song?id=123'},
                'matches': [{'segmentIndices': [i + 1], 'lyric': text, 'quote': text, 'matchedCharacters': len(text)} for i, text in enumerate(texts)]}
        return item, {'start': 100, 'end': 180}, rows

    def test_accepts_three_bound_lyric_citations_without_granting_approval(self):
        item, event, rows = self.fixture()
        self.assertIsNone(check_catalog_title(item, event, rows))
        self.assertNotIn('approved', item)

    def test_rejects_tampered_lyrics_title_reference_or_source(self):
        item, event, rows = self.fixture()
        for field, value in [('name', '另一个歌名'), ('segments', []), ('matches', item['matches'][:2])]:
            changed = copy.deepcopy(item)
            changed[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                check_catalog_title(changed, event, rows)
        changed = copy.deepcopy(item)
        changed['catalog']['lyrics'] += '\n篡改的歌词'
        with self.assertRaises(ValueError):
            check_catalog_title(changed, event, rows)
        with self.assertRaises(ValueError):
            check_catalog_title(item, {'start': 135, 'end': 180}, rows)
        changed = copy.deepcopy(rows)
        changed[0]['text'] = '原录播内容已经变化'
        with self.assertRaises(ValueError):
            check_catalog_title(item, event, changed)


if __name__ == '__main__':
    unittest.main()
