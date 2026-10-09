import copy
import unittest
from unittest.mock import patch

from src.scripts.bilibili_collection_edit import rename_episode


class CollectionEditTests(unittest.TestCase):
    def setUp(self):
        self.episode = {'id': 11, 'aid': 22, 'cid': 33, 'seasonId': 44, 'sectionId': 55,
                        'title': '旧标题', 'order': 2}
        self.credential = type('CredentialStub', (), {'bili_jct': 'fixture', 'sessdata': 'fixture'})()

    @patch('src.scripts.bilibili_collection_edit.requests.post')
    @patch('src.scripts.bilibili_collection_edit.list_collection_seasons')
    def test_title_edit_retains_episode_video_identity_and_omits_reordering(self, listing, post):
        listing.return_value = [{'part_episodes': [self.episode]}]
        post.return_value.json.return_value = {'code': 0}
        rename_episode(self.episode, '《雷神3》｜2026.10.4', self.credential)
        payload = post.call_args.kwargs['json']
        self.assertEqual(payload, {'id': 11, 'aid': 22, 'cid': 33, 'seasonId': 44, 'sectionId': 55,
                                  'title': '《雷神3》｜2026.10.4'})
        self.assertTrue(post.call_args.args[0].endswith('/season/section/episode/edit'))

    @patch('src.scripts.bilibili_collection_edit.requests.post')
    @patch('src.scripts.bilibili_collection_edit.list_collection_seasons')
    def test_changed_or_already_correct_episode_does_not_write(self, listing, post):
        for field, value in (('title', '人工改名'), ('aid', 99), ('order', 1)):
            changed = copy.deepcopy(self.episode)
            changed[field] = value
            listing.return_value = [{'part_episodes': [changed]}]
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                rename_episode(self.episode, '新标题', self.credential)
        listing.return_value = [{'part_episodes': [self.episode]}]
        self.assertTrue(rename_episode(self.episode, self.episode['title'], self.credential)['unchanged'])
        post.assert_not_called()
