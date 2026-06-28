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
        self.mentioned = self.root / "mizuki.png"
        self.cover = self.root / "25788785_20260101_120000.cover.jpg"
        self.highlight = self.root / "25788785_20260101_120000_AI_HIGHLIGHT.txt"
        for file_path in [self.host, self.extra, self.mentioned, self.cover, self.highlight]:
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
                    "mizuki": {
                        "displayName": "Mizuki",
                        "speakerLabels": ["Mizuki"],
                        "aliases": ["Mizuki-chan"],
                        "referenceImages": [str(self.mentioned)],
                        "characterDescription": "Mizuki, heterochromia and mechanical rabbit ears.",
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

    def write_sidecar(self, extra_ids, speakers=None):
        sidecar = self.root / "25788785_20260101_120000.asr_speakers.json"
        sidecar.write_text(json.dumps({
            "hostRoomId": "25788785",
            "speakers": speakers or [],
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

    def test_low_confidence_short_asr_extra_streamer_is_filtered(self):
        self.write_sidecar(["shiori"], speakers=[{
            "label": "Shiori",
            "totalSpeechSeconds": 78.46,
            "segmentCount": 15,
            "avgScore": 0.5336,
            "maxScore": 0.6439,
            "isUnknown": False,
        }])

        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))

        self.assertEqual(extras, [])

    def test_host_streamer_registry_reference_image_fills_missing_room_image(self):
        self.config["roomSettings"].pop("25788785")

        image = comic.get_room_reference_image("25788785", str(self.highlight))
        images = comic.collect_all_images("25788785", str(self.highlight))

        self.assertEqual(Path(image).name, "host.png")
        self.assertEqual(Path(images[0]).name, "host.png")

    def test_mentioned_streamer_adds_description_and_reference_image_without_sidecar(self):
        self.highlight.write_text("Tonight the host mentioned Mizuki during the stream.", encoding="utf-8")

        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))
        images = comic.collect_all_images("25788785", str(self.highlight), extra_streamers=extras)
        desc = comic.get_multi_character_description("25788785", extras)

        self.assertEqual([item["id"] for item in extras], ["mizuki"])
        self.assertEqual(extras[0]["_comicReferenceReason"], "mentioned")
        self.assertEqual([Path(item).name for item in images[:2]], ["host.png", "mizuki.png"])
        self.assertIn("Mizuki, heterochromia", desc)
        self.assertIn("文本提到", desc)

    def test_alias_only_label_does_not_trigger_mentioned_streamer(self):
        self.config["ai"]["streamerRegistry"]["alias_only"] = {
            "displayName": "AliasOnly",
            "aliases": ["小岁"],
            "referenceImages": [str(self.mentioned)],
        }
        self.highlight.write_text("The transcript contains 小岁 from noisy ASR.", encoding="utf-8")

        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))

        self.assertEqual(extras, [])

    def test_explicit_mention_label_triggers_mentioned_streamer(self):
        self.config["ai"]["streamerRegistry"]["izayoi"] = {
            "displayName": "十六萤Izayoi",
            "mentionLabels": ["十六"],
            "referenceImages": [str(self.extra)],
        }
        self.highlight.write_text("Today Liko talked about 十六, and 十六 was part of the story.", encoding="utf-8")

        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))

        self.assertEqual([item["id"] for item in extras], ["izayoi"])
        self.assertEqual(extras[0]["_matchedMentionLabel"], "十六")

    def test_short_danmaku_noise_does_not_trigger_mentioned_streamer(self):
        self.config["ai"]["streamerRegistry"]["sui_other_room"] = {
            "displayName": "岁己SUI",
            "mentionLabels": ["岁己"],
            "referenceImages": [str(self.mentioned)],
        }
        self.highlight.write_text(
            "[19m] Host talks about waiting. (💬 岁己吧(x5) / 岁己(x3))\n"
            "[107m] Host says one noisy ASR line with 岁己 once.",
            encoding="utf-8",
        )

        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))

        self.assertEqual(extras, [])

    def test_allowed_extra_streamers_skip_asr_mislabels_and_keep_mentions(self):
        kloa_highlight = self.root / "1986461465_20260101_AI_HIGHLIGHT.txt"
        kloa_highlight.write_text("克罗雅提到了莉蔻莉蔻和十六，十六也在故事里。", encoding="utf-8")
        sidecar = self.root / "1986461465_20260101.asr_speakers.json"
        sidecar.write_text(json.dumps({
            "hostRoomId": "1986461465",
            "speakers": [
                {"label": "栞栞", "totalSpeechSeconds": 300, "avgScore": 0.8, "maxScore": 0.9},
                {"label": "瑞娅", "totalSpeechSeconds": 300, "avgScore": 0.8, "maxScore": 0.9},
            ],
            "appearedStreamerIds": ["kloa", "shiori", "rhea"],
            "extraAppearedStreamerIds": ["shiori", "rhea"],
        }, ensure_ascii=False), encoding="utf-8")
        self.config["ai"]["streamerRegistry"]["kloa"] = {
            "displayName": "克罗雅Kloa",
            "roomIds": ["1986461465"],
            "mentionLabels": ["克罗雅"],
        }
        self.config["ai"]["streamerRegistry"]["liko"] = {
            "displayName": "莉蔻Liko",
            "mentionLabels": ["莉蔻"],
            "referenceImages": [str(self.mentioned)],
        }
        self.config["ai"]["streamerRegistry"]["izayoi"] = {
            "displayName": "十六萤Izayoi",
            "mentionLabels": ["十六"],
            "referenceImages": [str(self.extra)],
        }
        self.config["ai"]["streamerRegistry"]["rhea"] = {
            "displayName": "瑞娅",
            "speakerLabels": ["瑞娅"],
            "referenceImages": [str(self.extra)],
        }
        self.config["roomSettings"]["1986461465"] = {
            "multiReferenceImages": {
                "enabled": True,
                "maxExtraCharacters": 3,
                "maxMentionedContextCharacters": 3,
                "allowedExtraStreamerIds": ["hazel", "liko", "kloa", "izayoi"],
            }
        }

        extras = comic.resolve_extra_appeared_streamers(self.config, "1986461465", str(kloa_highlight))

        self.assertEqual([item["id"] for item in extras], ["liko", "izayoi"])

    def test_277_allowlist_skips_sui_asr_mislabel_for_izayoi_room(self):
        izayoi_highlight = self.root / "1741667419_20260101_AI_HIGHLIGHT.txt"
        izayoi_highlight.write_text(
            "十六萤在讲线下时光。 (💬 莉蔻莉蔻莉蔻莉蔻莉蔻莉蔻莉蔻莉蔻 / 克罗雅克罗雅克罗雅克罗雅克罗雅克罗雅克罗雅克罗雅)",
            encoding="utf-8",
        )
        sidecar = self.root / "1741667419_20260101.asr_speakers.json"
        sidecar.write_text(json.dumps({
            "hostRoomId": "1741667419",
            "speakers": [
                {"label": "岁己SUI", "totalSpeechSeconds": 594, "avgScore": 0.506, "maxScore": 0.6234},
            ],
            "appearedStreamerIds": ["sui"],
            "extraAppearedStreamerIds": ["sui"],
        }, ensure_ascii=False), encoding="utf-8")
        self.config["ai"]["streamerRegistry"]["izayoi"] = {
            "displayName": "十六萤Izayoi",
            "roomIds": ["1741667419"],
            "mentionLabels": ["十六"],
        }
        self.config["ai"]["streamerRegistry"]["liko"] = {
            "displayName": "莉蔻Liko",
            "mentionLabels": ["莉蔻"],
            "referenceImages": [str(self.mentioned)],
        }
        self.config["ai"]["streamerRegistry"]["kloa"] = {
            "displayName": "克罗雅Kloa",
            "mentionLabels": ["克罗雅"],
            "referenceImages": [str(self.extra)],
        }
        self.config["roomSettings"]["1741667419"] = {
            "multiReferenceImages": {
                "enabled": True,
                "maxExtraCharacters": 3,
                "maxMentionedContextCharacters": 3,
                "allowedExtraStreamerIds": ["hazel", "liko", "kloa", "izayoi"],
                "filterExtraImagesByComicScript": False,
                "filterMentionedImagesByComicScript": False,
            }
        }

        extras = comic.resolve_extra_appeared_streamers(self.config, "1741667419", str(izayoi_highlight))

        self.assertEqual([item["id"] for item in extras], ["liko", "kloa"])

    def test_mentioned_streamer_reference_is_filtered_when_absent_from_comic_script(self):
        mentioned = self.config["ai"]["streamerRegistry"]["mizuki"] | {
            "id": "mizuki",
            "_comicReferenceReason": "mentioned",
            "_matchedMentionLabel": "Mizuki",
        }
        appeared = self.config["ai"]["streamerRegistry"]["shiori"] | {
            "id": "shiori",
            "_comicReferenceReason": "appeared",
        }

        filtered = comic.filter_extra_streamers_for_image_prompt(
            [appeared, mentioned],
            "Panel 1: Shiori talks with the host.",
            self.config,
            "25788785",
        )

        self.assertEqual([item["id"] for item in filtered], ["shiori"])

    def test_appeared_streamer_reference_is_filtered_when_absent_from_comic_script(self):
        appeared = self.config["ai"]["streamerRegistry"]["shiori"] | {
            "id": "shiori",
            "_comicReferenceReason": "appeared",
        }

        filtered = comic.filter_extra_streamers_for_image_prompt(
            [appeared],
            "Panel 1: The host talks alone.",
            self.config,
            "25788785",
        )

        self.assertEqual(filtered, [])

    def test_room_can_disable_extra_image_script_filter(self):
        self.config["roomSettings"]["1986461465"] = {
            "multiReferenceImages": {
                "enabled": True,
                "filterExtraImagesByComicScript": False,
                "filterMentionedImagesByComicScript": False,
            }
        }
        mentioned = self.config["ai"]["streamerRegistry"]["mizuki"] | {
            "id": "mizuki",
            "_comicReferenceReason": "mentioned",
            "_matchedMentionLabel": "Mizuki",
        }

        filtered = comic.filter_extra_streamers_for_image_prompt(
            [mentioned],
            "Panel 1: The host talks alone.",
            self.config,
            "1986461465",
        )

        self.assertEqual([item["id"] for item in filtered], ["mizuki"])

    def test_mentioned_streamer_reference_is_kept_when_present_in_comic_script(self):
        mentioned = self.config["ai"]["streamerRegistry"]["mizuki"] | {
            "id": "mizuki",
            "_comicReferenceReason": "mentioned",
            "_matchedMentionLabel": "Mizuki",
        }

        filtered = comic.filter_extra_streamers_for_image_prompt(
            [mentioned],
            "Panel 1: Mizuki appears beside the host.",
            self.config,
            "25788785",
        )

        self.assertEqual([item["id"] for item in filtered], ["mizuki"])
        self.assertEqual(filtered[0]["_matchedComicLabel"], "Mizuki")

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
        self.assertIn("额外实际出声/文本提到主播", desc)
        self.assertIn("栞栞，浅黄色头发", desc)


if __name__ == "__main__":
    unittest.main()
