import unittest

from src.scripts.bilibili_upload import get_collection_section_id


class CollectionRoutingTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "bilibili": {
                "upload": {
                    "collectionSectionId": 9974272,
                    "collectionRouting": {
                        "sui": {
                            "sectionId": 9482593,
                            "roomIds": ["25788785"],
                            "markers": ["岁己", "小岁", "sui"],
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
