import unittest

from src.scripts.batch_upload import infer_room_id
from src.scripts.bilibili_upload import extract_room_id, get_collection_section_id


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
