import unittest
from unittest.mock import patch
import asyncio

from src.scripts.batch_upload import infer_room_id
from src.scripts.bilibili_upload import (extract_room_id, get_collection_section_id,
                                        resolve_auto_collection_section, attach_video_to_collection,
                                        create_collection_season, list_collection_seasons)


def volume(number, section_id, count):
    return {'season': {'id': 800 + number, 'title': f'岁己AI自动切片{number}',
                       'cover': 'https://example.com/cover.jpg', 'desc': '自动切片'},
            'sections': {'sections': [{'id': section_id, 'epCount': count}]}}


class AutoCollectionRolloverTests(unittest.TestCase):
    def setUp(self):
        self.credential = type('CredentialStub', (), {'bili_jct': 'csrf', 'sessdata': 'cookie'})()

    @patch('src.scripts.bilibili_upload.requests.get')
    def test_list_paginates_and_reads_live_shape(self, get):
        get.side_effect = [type('Response', (), {'raise_for_status': lambda self: None,
            'json': lambda self: {'code': 0, 'data': {'total': 2, 'seasons': [volume(1, 11, 1000)]}}})(),
            type('Response', (), {'raise_for_status': lambda self: None,
            'json': lambda self: {'code': 0, 'data': {'total': 2, 'seasons': [volume(2, 22, 1)]}}})()]
        self.assertEqual(len(list_collection_seasons(self.credential)), 2)

    @patch('src.scripts.bilibili_upload.requests.post')
    def test_create_uses_season_add_contract(self, post):
        post.return_value.raise_for_status.return_value = None
        post.return_value.json.return_value = {'code': 0, 'data': 802}
        self.assertEqual(create_collection_season('岁己AI自动切片2', '',
                         'https://example.com/cover.jpg', self.credential), 802)
        self.assertEqual(post.call_args.kwargs['data']['csrf'], 'csrf')

    @patch('src.scripts.bilibili_upload.create_collection_season')
    @patch('src.scripts.bilibili_upload.list_collection_seasons')
    def test_full_first_volume_creates_second_and_uses_its_section(self, listing, create):
        listing.side_effect = [[volume(1, 11, 1000)], [volume(1, 11, 1000), volume(2, 22, 0)]]
        create.return_value = 802
        self.assertEqual(resolve_auto_collection_section(11, self.credential, enabled=True), 22)
        create.assert_called_once_with('岁己AI自动切片2', '自动切片',
                                       'https://example.com/cover.jpg', self.credential)

    @patch('src.scripts.bilibili_upload.create_collection_season')
    @patch('src.scripts.bilibili_upload.list_collection_seasons')
    def test_reuses_second_then_rolls_to_third(self, listing, create):
        listing.return_value = [volume(1, 11, 1000), volume(2, 22, 999)]
        self.assertEqual(resolve_auto_collection_section(11, self.credential, enabled=True), 22)
        create.assert_not_called()
        listing.side_effect = [[volume(1, 11, 1000), volume(2, 22, 1000)],
                               [volume(1, 11, 1000), volume(2, 22, 1000), volume(3, 33, 0)]]
        create.return_value = 803
        self.assertEqual(resolve_auto_collection_section(11, self.credential, enabled=True), 33)

    @patch('src.scripts.bilibili_upload.list_collection_seasons')
    def test_other_collection_is_unchanged(self, listing):
        listing.return_value = [volume(1, 11, 1000)]
        self.assertEqual(resolve_auto_collection_section(99, self.credential), 99)
        listing.assert_not_called()

    @patch('src.scripts.bilibili_upload.create_collection_season')
    @patch('src.scripts.bilibili_upload.list_collection_seasons')
    def test_unknown_count_does_not_create(self, listing, create):
        item = volume(1, 11, 1000)
        del item['sections']['sections'][0]['epCount']
        listing.return_value = [item]
        with self.assertRaisesRegex(RuntimeError, '视频数量不可用'):
            resolve_auto_collection_section(11, self.credential, enabled=True)
        create.assert_not_called()

    @patch('src.scripts.bilibili_upload.create_collection_season')
    @patch('src.scripts.bilibili_upload.list_collection_seasons')
    def test_new_season_missing_section_does_not_create_again(self, listing, create):
        listing.return_value = [volume(1, 11, 1000)]
        create.return_value = 802
        with patch('src.scripts.bilibili_upload.time.sleep'):
            with self.assertRaisesRegex(RuntimeError, '尚未查询到小节 ID'):
                resolve_auto_collection_section(11, self.credential, enabled=True)
        create.assert_called_once()

    @patch('src.scripts.bilibili_upload.add_episode_to_section')
    @patch('src.scripts.bilibili_upload.resolve_auto_collection_section')
    def test_attachment_records_new_section(self, resolve, add):
        resolve.return_value = 22
        add.return_value = {'code': 0}
        result = {'aid': 1, 'cid': 2, 'title': 'clip'}
        config = {'bilibili': {'upload': {'autoCollectionRollover': {'enabled': True, 'sectionId': 11}}}}
        asyncio.run(attach_video_to_collection(result, self.credential, 11, config=config))
        self.assertEqual((result['collectionStatus'], result['collectionSectionId']), ('ok', 22))
        add.assert_called_once_with(22, 1, 2, 'clip', self.credential)
        resolve.assert_called_once_with(11, self.credential, enabled=True)

    @patch('src.scripts.bilibili_upload.add_episode_to_section')
    @patch('src.scripts.bilibili_upload.resolve_auto_collection_section')
    def test_unrelated_add_failure_does_not_retry(self, resolve, add):
        resolve.return_value = 11
        add.return_value = {'code': -1, 'message': 'permission denied'}
        result = {'aid': 1, 'cid': 2, 'title': 'clip'}
        config = {'bilibili': {'upload': {'autoCollectionRollover': {'enabled': True, 'sectionId': 11}}}}
        asyncio.run(attach_video_to_collection(result, self.credential, 11, config=config))
        self.assertEqual(result['collectionStatus'], 'failed')
        resolve.assert_called_once()
        add.assert_called_once()

    @patch('src.scripts.bilibili_upload.add_episode_to_section')
    @patch('src.scripts.bilibili_upload.resolve_auto_collection_section')
    def test_live_full_error_rechecks_and_retries_next_volume(self, resolve, add):
        resolve.side_effect = [11, 22]
        add.side_effect = [{'code': 20091, 'message': '您在这个合集中添加的单集太多了。'}, {'code': 0}]
        config = {'bilibili': {'upload': {'autoCollectionRollover': {'enabled': True, 'sectionId': 11}}}}
        result = {'aid': 1, 'cid': 2, 'title': 'clip'}
        asyncio.run(attach_video_to_collection(result, self.credential, 11, config=config))
        self.assertEqual((result['collectionStatus'], result['collectionSectionId']), ('ok', 22))
        self.assertEqual(add.call_count, 2)


class CollectionRoutingTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "bilibili": {
                "upload": {
                    "collectionSectionId": 10015117,
                    "collectionRouting": {
                        "fuyasoul": {
                            "seasonId": 8956269,
                            "sectionId": 9991476,
                            "roomIds": [
                                "1820703922",
                                "1713546334",
                                "1727074031",
                                "23771092",
                            ],
                            "markers": [
                                "花礼Harei",
                                "灰泽满Hazel",
                                "羽啾chu2u",
                                "又一充电中",
                            ],
                        },
                        "sui": {
                            "sectionId": 9482593,
                            "roomIds": ["25788785"],
                            "markers": ["岁己", "小岁", "sui"],
                        },
                        "yua": {
                            "seasonId": 8977005,
                            "sectionId": 10015117,
                            "roomIds": ["22470216"],
                            "markers": ["悠亚Yua", "悠亚", "小悠", "Yua"],
                        },
                        "other": {"sectionId": 9974272},
                    },
                }
            }
        }

    def test_sui_room_routes_to_sui_section(self):
        self.assertEqual(
            get_collection_section_id(self.config, room_id="25788785"),
            9482593,
        )

    def test_unconfigured_context_uses_ai_auto_collection_fallback(self):
        config = {
            "bilibili": {
                "upload": {
                    "collectionSectionId": 10015117,
                }
            }
        }
        self.assertEqual(
            get_collection_section_id(config, streamer_name="未配置主播"),
            10015117,
        )

    def test_yua_room_routes_to_standalone_collection(self):
        self.assertEqual(
            get_collection_section_id(self.config, room_id="22470216"),
            10015117,
        )

    def test_yua_route_wins_when_source_mentions_sui(self):
        self.assertEqual(
            get_collection_section_id(
                self.config,
                room_id="22470216",
                streamer_name="小悠",
                source_desc="小悠 直播《提到岁己的聊天》2026-08-31",
            ),
            10015117,
        )

    def test_activity_rooms_route_to_new_collection(self):
        for room_id in ("1820703922", "1713546334", "1727074031", "23771092"):
            with self.subTest(room_id=room_id):
                self.assertEqual(
                    get_collection_section_id(self.config, room_id=room_id),
                    9991476,
                )

    def test_activity_streamer_name_routes_to_new_collection(self):
        self.assertEqual(
            get_collection_section_id(self.config, streamer_name="羽啾chu2u"),
            9991476,
        )

    def test_generated_harei_media_path_provides_activity_room_context(self):
        media_path = (
            r"D:\files\videos\DDTV录播\1820703922_花礼Harei\2026_08_28\own_stream_fun_clips"
            r"\录制-1820703922-20260828-140230-865_fun_04.mp4"
        )
        room_id = extract_room_id(media_path)
        self.assertEqual(room_id, "1820703922")
        self.assertEqual(infer_room_id([{"path": media_path}]), "1820703922")
        self.assertEqual(
            get_collection_section_id(
                self.config,
                room_id=room_id,
                prefix="【礼礼】",
                source_desc="礼礼 直播《小鼠看lpl》2026-08-28 14:02:30",
            ),
            9991476,
        )

    def test_activity_prefix_wins_over_sui_topic_mention(self):
        self.assertEqual(
            get_collection_section_id(
                self.config,
                prefix="【又一充电中】",
                source_desc="岁己SUI 直播《提及又一充电中》2026-08-28",
            ),
            9991476,
        )

    def test_activity_source_fallback_uses_leading_streamer_name(self):
        self.assertEqual(
            get_collection_section_id(
                self.config,
                source_desc="灰泽满Hazel 直播《测试》2026-08-28",
            ),
            9991476,
        )

    def test_other_streamer_prefix_wins_over_sui_topic_mention(self):
        self.assertEqual(
            get_collection_section_id(
                self.config,
                prefix="【小栞】",
                source_desc="话题切片（小栞提及岁己）直播 2026-07-08",
            ),
            9974272,
        )

    def test_sui_source_fallback_uses_leading_streamer_name(self):
        self.assertEqual(
            get_collection_section_id(
                self.config,
                source_desc="岁己SUI 直播《测试》2026-08-27",
            ),
            9482593,
        )

    def test_old_sui_prefix_falls_back_to_sui_source(self):
        self.assertEqual(
            get_collection_section_id(
                self.config,
                prefix="【老岁片】",
                source_desc="岁己SUI 老岁片合集《测试》2025-06-19、2025-06-25",
            ),
            9482593,
        )

    def test_old_sui_title_falls_back_to_sui_source(self):
        self.assertEqual(
            get_collection_section_id(
                self.config,
                title="【AI老岁片】岁己回顾旧预言",
                source_desc="岁己SUI 老岁片合集《测试》2025-06-19",
            ),
            9482593,
        )

    def test_unknown_streamer_uses_other_section(self):
        self.assertEqual(
            get_collection_section_id(self.config, streamer_name="栞栞"),
            9974272,
        )


if __name__ == "__main__":
    unittest.main()
