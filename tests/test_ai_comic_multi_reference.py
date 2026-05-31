import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_DIR = ROOT / "src" / "scripts"
MODULE_PATH = SCRIPT_DIR / "ai_comic_generator.py"

import sys
sys.path.insert(0, str(SCRIPT_DIR))

spec = importlib.util.spec_from_file_location("ai_comic_generator", MODULE_PATH)
comic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comic)


class MultiReferenceComicTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.host = self.root / "host.png"
        self.extra = self.root / "shiori.png"
        self.cover = self.root / "25788785_20260101_120000.cover.jpg"
        self.highlight = self.root / "25788785_20260101_120000_AI_HIGHLIGHT.txt"
        for file_path in [self.host, self.extra, self.cover, self.highlight]:
            file_path.write_bytes(b"x")

        self.config = {
            "ai": {
                "comic": {
                    "multiReferenceImages": {
                        "enabled": True,
                        "maxExtraCharacters": 2,
                        "minSpeakerScore": 0.5,
                        "minSpeechSeconds": 8,
                    }
                },
                "streamerRegistry": {
                    "sui": {
                        "displayName": "岁己SUI",
                        "roomIds": ["25788785"],
                        "speakerLabels": ["岁己SUI"],
                        "referenceImages": [str(self.host)],
                        "characterDescription": "岁己SUI，白发红瞳女生。",
                    },
                    "shiori": {
                        "displayName": "栞栞",
                        "speakerLabels": ["栞栞", "Shiori"],
                        "referenceImages": [str(self.extra)],
                        "characterDescription": "栞栞，浅黄色头发。",
                    },
                },
                "roomSettings": {
                    "25788785": {
                        "referenceImage": str(self.host),
                        "characterDescription": "房间主人描述",
                    }
                },
            },
            "roomSettings": {
                "25788785": {
                    "referenceImage": str(self.host),
                    "characterDescription": "房间主人描述",
                }
            },
            "aiServices": {},
        }
        self.original_load_config = comic.load_config
        self.original_project_root = comic.get_project_root
        comic.load_config = lambda: self.config
        comic.get_project_root = lambda: str(self.root)

    def tearDown(self):
        comic.load_config = self.original_load_config
        comic.get_project_root = self.original_project_root
        self.tmp.cleanup()

    def write_sidecar(self, extra_ids):
        sidecar = self.root / "25788785_20260101_120000.asr_speakers.json"
        sidecar.write_text(json.dumps({
            "hostRoomId": "25788785",
            "speakers": [],
            "appearedStreamerIds": ["sui", *extra_ids],
            "extraAppearedStreamerIds": extra_ids,
        }, ensure_ascii=False), encoding="utf-8")

    def test_disabled_collect_all_images_matches_original_behavior(self):
        self.config["ai"]["comic"]["multiReferenceImages"]["enabled"] = False
        with_extra = comic.collect_all_images("25788785", str(self.highlight), extra_streamers=[
            self.config["ai"]["streamerRegistry"]["shiori"]
        ])
        without_extra = comic.collect_all_images("25788785", str(self.highlight))

        self.assertEqual(with_extra, without_extra)
        self.assertNotIn(str(self.extra), with_extra)

    def test_enabled_without_sidecar_does_not_error(self):
        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))
        self.assertEqual(extras, [])

    def test_unknown_and_host_are_not_extra_streamers(self):
        self.write_sidecar(["sui", "UNKNOWN"])
        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))
        self.assertEqual(extras, [])

    def test_high_confidence_extra_streamer_adds_reference_image(self):
        self.write_sidecar(["shiori"])
        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))
        images = comic.collect_all_images("25788785", str(self.highlight), extra_streamers=extras)

        self.assertEqual([Path(item).name for item in images[:2]], ["host.png", "shiori.png"])

    def test_max_extra_characters_applies(self):
        second = self.root / "rhea.png"
        second.write_bytes(b"x")
        self.config["ai"]["streamerRegistry"]["rhea"] = {
            "displayName": "瑞娅",
            "speakerLabels": ["瑞娅"],
            "referenceImages": [str(second)],
        }
        self.config["ai"]["comic"]["multiReferenceImages"]["maxExtraCharacters"] = 1
        self.write_sidecar(["shiori", "rhea"])

        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))
        self.assertEqual([item["id"] for item in extras], ["shiori"])

    def test_multi_character_description_appends_extra_description(self):
        desc = comic.get_multi_character_description("25788785", [
            self.config["ai"]["streamerRegistry"]["shiori"] | {"id": "shiori"}
        ])

        self.assertIn("房间主人描述", desc)
        self.assertIn("额外实际出声主播", desc)
        self.assertIn("栞栞，浅黄色头发", desc)


if __name__ == "__main__":
    unittest.main()
