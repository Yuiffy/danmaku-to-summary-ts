import builtins
import importlib.util
import json
import os
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


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
        self.host_voice = self.root / "sui.wav"
        self.cover = self.root / "25788785_20260101_120000.cover.jpg"
        self.highlight = self.root / "25788785_20260101_120000_AI_HIGHLIGHT.txt"
        for file_path in [self.host, self.extra, self.mentioned, self.host_voice, self.cover, self.highlight]:
            file_path.write_bytes(b"x")

        self.config = {
            "asr": {
                "paraformer": {
                    "speaker_references": [
                        {
                            "speaker": "岁己SUI",
                            "audio_path": str(self.host_voice),
                        }
                    ]
                }
            },
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

    def test_missing_host_speaker_reference_skips_asr_appeared_but_keeps_mentions(self):
        self.config["asr"]["paraformer"]["speaker_references"] = []
        self.highlight.write_text("Tonight the host mentioned Mizuki during the stream.", encoding="utf-8")
        self.write_sidecar(["shiori"])

        log_lines = []
        original_print = comic.print
        comic.print = lambda *args, **kwargs: log_lines.append(" ".join(str(arg) for arg in args))
        try:
            extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))
        finally:
            comic.print = original_print

        self.assertEqual([item["id"] for item in extras], ["mizuki"])
        self.assertEqual(extras[0]["_comicReferenceReason"], "mentioned")
        output = "\n".join(log_lines)
        self.assertIn("跳过 ASR 出声触发漫画参考图", output)
        self.assertIn("未配置 ASR speaker_references", output)

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

    def test_moderate_confidence_short_asr_mislabel_is_filtered(self):
        self.write_sidecar(["shiori"], speakers=[{
            "label": "Shiori",
            "totalSpeechSeconds": 556.905,
            "segmentCount": 65,
            "avgScore": 0.5911,
            "maxScore": 0.7451,
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

    def test_kloa_common_nickname_triggers_and_survives_script_filter(self):
        self.config["ai"]["streamerRegistry"]["kloa"] = {
            "displayName": "克罗雅Kloa",
            "mentionLabels": ["雅小妹"],
            "aliases": ["雅小妹", "雅雅"],
            "referenceImages": [str(self.extra)],
        }
        self.highlight.write_text("今天十六在雅小妹电脑前直播，还翻了雅小妹的文件夹。", encoding="utf-8")

        extras = comic.resolve_extra_appeared_streamers(self.config, "25788785", str(self.highlight))
        filtered = comic.filter_extra_streamers_for_image_prompt(
            extras,
            "分镜一：十六萤坐在雅小妹的电脑前。",
            self.config,
            "25788785",
        )

        self.assertEqual([item["id"] for item in extras], ["kloa"])
        self.assertEqual(extras[0]["_matchedMentionLabel"], "雅小妹")

    def test_comic_script_mentions_can_add_liko_without_highlight_mention(self):
        self.config["ai"]["streamerRegistry"]["kloa"] = {
            "displayName": "克罗雅Kloa",
            "mentionLabels": ["雅小妹"],
            "aliases": ["雅小妹", "雅雅"],
            "referenceImages": [str(self.extra)],
        }
        self.config["ai"]["streamerRegistry"]["liko"] = {
            "displayName": "莉蔻Liko",
            "mentionLabels": ["莉蔻", "Liko", "侏儒兔"],
            "referenceImages": [str(self.mentioned)],
        }
        self.config["roomSettings"]["25788785"] = {
            "multiReferenceImages": {
                "enabled": True,
                "maxExtraCharacters": 3,
                "maxMentionedContextCharacters": 3,
                "allowedExtraStreamerIds": ["kloa", "liko"],
            }
        }

        comic_text = "分镜1：十六萤把莉蔻按在桌上，同时和雅小妹掰手腕。"
        mentioned = comic.resolve_mentioned_streamers(
            self.config,
            "25788785",
            None,
            {"kloa"},
            highlight_text=comic_text,
            strict_short_mentions=False,
        )

        self.assertEqual([item["id"] for item in mentioned], ["liko"])
        self.assertEqual(mentioned[0]["_matchedMentionLabel"], "莉蔻")

    def test_storyboard_members_choose_their_own_references_not_other_highlight_mentions(self):
        self.config["asr"]["corrections"] = {
            "safe": {
                "花里": "花礼",
                "难亭": "南町",
            }
        }
        self.config["ai"]["streamerRegistry"].update({
            "harei": {
                "displayName": "花礼Harei",
                "mentionLabels": ["花礼"],
                "referenceImages": [str(self.extra)],
                "characterDescription": "花礼，黑发蓝瞳鼠耳。",
            },
            "nightin": {
                "displayName": "南町Nightin",
                "mentionLabels": ["南町"],
                "referenceImages": [],
                "characterDescription": "南町，歌势主播。",
            },
            "kloa": {
                "displayName": "克罗雅Kloa",
                "mentionLabels": ["克罗雅"],
                "referenceImages": [str(self.mentioned)],
            },
            "hazel": {
                "displayName": "灰泽满Hazel",
                "mentionLabels": ["灰泽满"],
                "referenceImages": [str(self.mentioned)],
            },
        })
        self.config["roomSettings"]["25788785"] = {
            "multiReferenceImages": {
                "enabled": True,
                "maxExtraCharacters": 3,
                "maxMentionedContextCharacters": 3,
                "allowedExtraStreamerIds": ["harei", "nightin", "kloa", "hazel"],
            }
        }
        self.highlight.write_text(
            "矮人帮成员是花里和难亭。顺便说，克罗雅和灰泽满的动态也很好笑。",
            encoding="utf-8",
        )
        storyboard = "分镜二：矮人帮名单上写着花礼和南町，莉蔻与两人分工合作。"

        selected = comic.resolve_image_prompt_extra_streamers(
            self.config,
            "25788785",
            str(self.highlight),
            storyboard,
        )
        prompt, _, _ = comic.build_comic_prompt(
            "",
            room_id="25788785",
            existing_comic=storyboard,
            extra_streamers=selected,
        )

        self.assertEqual([item["id"] for item in selected], ["harei", "nightin"])
        self.assertIn("花礼", prompt)
        self.assertIn("南町", prompt)
        self.assertNotIn("克罗雅Kloa", prompt)
        self.assertNotIn("灰泽满Hazel", prompt)
        self.assertIn("不要套用任一已有参考图的外观", prompt)

    def test_asr_confirmed_speaker_remains_an_image_candidate_after_storyboard_generation(self):
        self.write_sidecar(["shiori"])

        selected = comic.resolve_image_prompt_extra_streamers(
            self.config,
            "25788785",
            str(self.highlight),
            "分镜一：房间主人独自聊天。",
        )

        self.assertEqual([item["id"] for item in selected], ["shiori"])
        self.assertEqual(selected[0]["_comicReferenceReason"], "appeared")

    def test_asr_confirmed_speaker_is_injected_into_first_storyboard_prompt(self):
        self.highlight.write_text(
            "岁己和栞栞一起玩双人自行车，互相提醒左右方向。",
            encoding="utf-8",
        )
        self.write_sidecar(["shiori"])
        appeared = comic.resolve_extra_appeared_streamers(
            self.config,
            "25788785",
            str(self.highlight),
            include_mentioned_streamers=False,
        )

        prompt = comic.build_comic_generation_prompt(
            "房间主人描述",
            self.highlight.read_text(encoding="utf-8"),
            "25788785",
            appeared_streamers=appeared,
        )
        script = comic.postprocess_generated_comic_script(
            "分镜一：岁己与嘉宾栞栞一起骑双人自行车，互相提醒方向。",
            self.highlight.read_text(encoding="utf-8"),
            "25788785",
            appeared_streamers=appeared,
        )

        self.assertIn("栞栞：ASR 已确认在本场直播中实际出声", prompt)
        self.assertNotIn("栞栞：仅在原文中被提到", prompt)
        self.assertIn("栞栞", script)

    def test_comic_script_meta_records_appeared_streamers(self):
        output = self.root / "story_COMIC_SCRIPT.txt"

        comic.write_comic_script_meta(
            str(output),
            {"status": "success", "provider": "test", "model": "test"},
            "25788785",
            "highlight",
            ["shiori", "shiori"],
        )
        meta = json.loads(
            Path(comic.comic_script_meta_path(str(output))).read_text(encoding="utf-8")
        )

        self.assertEqual(meta["schemaVersion"], comic.COMIC_SCRIPT_META_SCHEMA_VERSION)
        self.assertEqual(meta["policyVersion"], comic.COMIC_SCRIPT_POLICY_VERSION)
        self.assertEqual(meta["appearedStreamerIds"], ["shiori"])

    def test_live_context_constrains_storyboard_and_final_image_prompt(self):
        live_context = {
            "schemaVersion": 1,
            "liveTitle": "明日方舟代抽⭐",
            "recordingStartTime": "2026-08-01T03:57:16.000Z",
            "recordingStartLocalTime": "2026-08-01 11:57:16 UTC+8",
            "recentDynamics": [{
                "id": "1231444441815842852",
                "publishTime": "2026-08-01T03:53:22.000Z",
                "content": "来了来了来了！代抽明日方舟咯！",
            }],
            "contentHints": [
                "孤立的“启动”在没有冲突证据时可理解为“原神启动”，但不能据此判断本场游戏。"
            ],
        }

        storyboard_prompt = comic.build_comic_generation_prompt(
            "兔耳亚麻发异瞳少女",
            "主播说今天来代抽，正文多次出现明日方舟。",
            "30655190",
            live_context=live_context,
        )
        image_prompt, _, _ = comic.build_comic_prompt(
            "正文多次出现明日方舟。",
            room_id="30655190",
            existing_comic="分镜一：电脑上写着原神启动。",
            live_context=live_context,
        )

        self.assertIn("直播标题：明日方舟代抽⭐", storyboard_prompt)
        self.assertIn("开播时间（北京时间）：2026-08-01 11:57:16 UTC+8", storyboard_prompt)
        self.assertIn("代抽明日方舟咯", storyboard_prompt)
        self.assertIn("直播标题与明确语音 > 同场弹幕", storyboard_prompt)
        self.assertIn("至少两类证据一致确认具体游戏/活动", storyboard_prompt)
        self.assertIn("若下方漫画脚本与 live_facts 冲突", image_prompt)
        self.assertIn("不要绘制错误的游戏界面", image_prompt)

    def test_comic_script_meta_hashes_live_context(self):
        output = self.root / "context_story_COMIC_SCRIPT.txt"
        live_context = {
            "liveTitle": "明日方舟代抽⭐",
            "recentDynamics": [],
            "contentHints": [],
        }

        comic.write_comic_script_meta(
            str(output),
            {"status": "success", "provider": "test", "model": "test"},
            "30655190",
            "highlight",
            [],
            live_context,
        )
        meta = json.loads(
            Path(comic.comic_script_meta_path(str(output))).read_text(encoding="utf-8")
        )

        self.assertEqual(meta["liveContextSha256"], comic.hash_live_generation_context(live_context))

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

    def configure_shiori_incident(self):
        self.config["ai"]["streamerRegistry"]["shiori"]["roomIds"] = ["26966466"]
        self.config["ai"]["streamerRegistry"]["mizuki"]["displayName"] = "弥月Mizuki"
        self.config["ai"]["streamerRegistry"]["mizuki"]["mentionLabels"] = ["弥月"]
        self.config["ai"]["streamerRegistry"]["mizuki"]["aliases"] = ["弥月"]
        self.config["ai"]["streamerRegistry"]["miting"] = {
            "displayName": "米汀",
            "speakerLabels": ["米汀"],
            "mentionLabels": ["米汀"],
            "referenceImages": [str(self.extra)],
        }
        self.config["ai"]["roomSettings"]["26966466"] = {
            "referenceImage": str(self.host),
            "characterDescription": "栞栞Shiori，浅黄色头发兽耳女生。",
            "multiReferenceImages": {
                "enabled": True,
                "maxExtraCharacters": 2,
                "requirePlannedRosterForAppearedCharacters": True,
            },
        }

    def test_emotion_summary_and_annotations_survive_comic_sanitizing(self):
        source = (
            "【情感概览】开心12段、惊讶2段；明显声音事件: 笑声3次\n"
            "[12m] 突然笑起来了  [情感: 惊讶；声音: 笑声]"
        )
        cleaned = comic.sanitize_highlight_for_comic_script(
            source,
            room_id="25788785",
            config=self.config,
        )
        self.assertIn("【情感概览】", cleaned)
        self.assertIn("情感: 惊讶", cleaned)
        self.assertIn("声音: 笑声", cleaned)

    def test_shiori_mention_is_context_not_live_guest(self):
        self.configure_shiori_incident()
        source = "小栞今天下午带弥月打第五人格，把任务过了。"

        prompt = comic.build_comic_generation_prompt("小栞", source, "26966466")
        script = comic.postprocess_generated_comic_script(
            "分镜一：主播 诗璃(Shiori)和嘉宾 瑞姬Mizuki 连麦合唱。\n"
            "分镜二：小栞带弥月通关第五人格任务。",
            source,
            "26966466",
        )

        self.assertIn("弥月Mizuki", prompt)
        self.assertIn("不是本场嘉宾、连麦者或合唱者", prompt)
        self.assertNotIn("诗璃", script)
        self.assertNotIn("嘉宾", script)
        self.assertNotIn("连麦", script)
        self.assertIn("小栞带弥月通关第五人格任务", script)

    def test_second_prompt_build_preserves_fresh_script_provenance(self):
        comic.reset_comic_script_meta()
        comic.set_comic_script_meta(provider="daiYu", model="gpt-5.6-luna", status="success")

        comic.build_comic_prompt(
            "",
            room_id="25788785",
            existing_comic="分镜一：房间主人独自聊天，观众在旁边欢呼。",
        )

        meta = comic.get_comic_script_meta()
        self.assertEqual(meta["provider"], "daiYu")
        self.assertEqual(meta["model"], "gpt-5.6-luna")

    def test_shiori_unconstrained_asr_miting_cannot_select_image_reference(self):
        self.configure_shiori_incident()
        incident_highlight = self.root / "26966466_incident_AI_HIGHLIGHT.txt"
        incident_highlight.write_text("小栞今天下午带弥月打第五人格。", encoding="utf-8")
        (self.root / "26966466_incident.asr_speakers.json").write_text(json.dumps({
            "constrainedToRoster": False,
            "extraAppearedStreamerIds": ["miting"],
            "speakers": [{"label": "米汀", "totalSpeechSeconds": 1600, "avgScore": 0.74, "maxScore": 0.74}],
        }, ensure_ascii=False), encoding="utf-8")

        extras = comic.resolve_extra_appeared_streamers(self.config, "26966466", str(incident_highlight))

        self.assertEqual([item["id"] for item in extras], ["mizuki"])
        self.assertNotIn("miting", [item["id"] for item in extras])

    def test_storytelling_variant_assignment_is_stable_and_forceable(self):
        self.config["ai"]["comic"]["storytellingExperiment"] = {
            "enabled": True,
            "immersivePercent": 30,
            "salt": "test-v1",
        }

        first = comic.select_comic_storytelling_variant(
            self.config, "25788785", "同一场直播内容"
        )
        second = comic.select_comic_storytelling_variant(
            self.config, "25788785", "同一场直播内容"
        )
        forced = comic.select_comic_storytelling_variant(
            self.config, "25788785", "同一场直播内容", override="immersive_v1"
        )

        self.assertEqual(first, second)
        self.assertIn(first["variant"], {"control", "immersive_v1"})
        self.assertEqual(first["immersivePercent"], 30)
        self.assertEqual(
            first["variant"],
            "immersive_v1" if first["bucket"] < 3000 else "control",
        )
        self.assertEqual(forced["variant"], "immersive_v1")
        self.assertEqual(forced["assignmentReason"], "forced")
        self.assertEqual(forced["screenshotMode"], "individual")

    def test_immersive_prompt_requires_structured_shots_and_non_grid_composition(self):
        storytelling = {"variant": "immersive_v1"}
        prompt = comic.build_comic_generation_prompt(
            "亚麻发异瞳兔耳少女",
            "[12m] 弥月在明日方舟代抽时遇到双黄全歪。",
            "30655190",
            storytelling=storytelling,
        )
        image_prompt, _, _ = comic.build_comic_prompt(
            "明日方舟代抽",
            room_id="30655190",
            existing_comic=(
                '{"format":"immersive_v1","composition":"战场长卷"}\n'
                '{"timestampSeconds":720,"scene":"弥月冲入战场抽卡",'
                '"visualIntent":"低机位","referenceUsage":"核对明日方舟抽卡界面"}'
            ),
            storytelling=storytelling,
        )

        self.assertIn('"timestampSeconds":数值', prompt)
        self.assertIn('"visualIntent"', prompt)
        self.assertIn('"referenceUsage"', prompt)
        self.assertIn("禁止默认规则2x2四宫格", prompt)
        self.assertIn("主动进入本场明确出现的游戏", prompt)
        self.assertIn("不要画成规则的2x2四宫格", image_prompt)
        self.assertIn("整张图最多允许一个小区域出现直播桌面", image_prompt)

    def test_control_and_immersive_prompts_stay_separate(self):
        control_script_prompt = comic.build_comic_generation_prompt(
            "亚麻发异瞳兔耳少女",
            "主播看电影并聊旅行计划。",
            "30655190",
            storytelling={"variant": "control"},
        )
        immersive_script_prompt = comic.build_comic_generation_prompt(
            "亚麻发异瞳兔耳少女",
            "主播看电影并聊旅行计划。",
            "30655190",
            storytelling={"variant": "immersive_v1"},
        )
        control_image_prompt, _, _ = comic.build_comic_prompt(
            "主播看电影并聊旅行计划。",
            room_id="30655190",
            existing_comic="分镜一：主播坐在桌前聊电影。",
            storytelling={"variant": "control"},
        )
        immersive_image_prompt, _, _ = comic.build_comic_prompt(
            "主播看电影并聊旅行计划。",
            room_id="30655190",
            existing_comic=(
                '{"format":"immersive_v1","composition":"电影感主画面"}\n'
                '{"timestampSeconds":60,"scene":"想象旅行",'
                '"visualIntent":"想象气泡","referenceUsage":"核对主播表情"}'
            ),
            storytelling={"variant": "immersive_v1"},
        )

        self.assertIn("多个剪贴画风格分镜", control_script_prompt)
        self.assertNotIn('"timestampSeconds":数值', control_script_prompt)
        self.assertIn('"timestampSeconds":数值', immersive_script_prompt)
        self.assertNotIn("沉浸式画面策略", control_image_prompt)
        self.assertIn("沉浸式画面策略", immersive_image_prompt)

    def test_immersive_prompts_preserve_future_and_imagined_modality(self):
        storytelling = {"variant": "immersive_v1"}
        script_prompt = comic.build_comic_generation_prompt(
            "白发红瞳少女",
            "[18m] 主播计划以后去香港，脑补被店员很凶地提醒。",
            "25788785",
            storytelling=storytelling,
        )
        image_prompt, _, _ = comic.build_comic_prompt(
            "计划以后去香港。",
            room_id="25788785",
            existing_comic=(
                '{"format":"immersive_v1","composition":"现实与想象交叠"}\n'
                '{"timestampSeconds":1080,"scene":"Q版分身在香港想象气泡里遇到凶店员",'
                '"visualIntent":"幻想小剧场","referenceUsage":"核对主播讲述时的表情"}'
            ),
            storytelling=storytelling,
        )

        for prompt in (script_prompt, image_prompt):
            self.assertIn("未来计划、假设、脑补、梦境或转述故事", prompt)
            self.assertIn("想象气泡", prompt)
            self.assertIn("不能画成主播当场真的抵达", prompt)

    def test_extract_storyboard_shots_parses_json_lines(self):
        script = "\n".join([
            '{"format":"immersive_v1","composition":"电影感主画面"}',
            '{"timestampSeconds":125,"scene":"冲入战场","visualIntent":"广角逆光","referenceUsage":"核对抽卡界面"}',
            '{"timestampSeconds":"03:10","scene":"双黄全歪","visualIntent":"面部特写","referenceUsage":"核对结果页"}',
        ])

        shots = comic.extract_storyboard_shots(script, max_shots=3)

        self.assertEqual([item["timestampSeconds"] for item in shots], [125.0, 190.0])
        self.assertEqual(shots[0]["scene"], "冲入战场")
        self.assertEqual(shots[1]["referenceUsage"], "核对结果页")

    def test_reference_requests_are_independent_from_storyboard_beats(self):
        script = "\n".join([
            '{"format":"immersive_v1","composition":"电影感主画面"}',
            '{"kind":"beat","timestampSeconds":125,"scene":"拉下十连机关",'
            '"visualIntent":"广角逆光","referenceUsage":"叙事起点"}',
            '{"kind":"reference","timestampSeconds":720,"evidenceRole":"target_identity",'
            '"mustShow":"卡池页两位UP六星角色的完整外观",'
            '"referenceUsage":"核对全部UP目标","captureMode":"sequence",'
            '"windowStartSeconds":700,"windowEndSeconds":740}',
            '{"kind":"reference","timestampSeconds":"46:15","evidenceRole":"result",'
            '"mustShow":"十连结果中的实际角色和稀有度",'
            '"referenceUsage":"核对最终结果","captureMode":"single",'
            '"windowStartSeconds":null,"windowEndSeconds":null}',
        ])

        shots = comic.extract_storyboard_shots(script, max_shots=4)
        requests = comic.extract_reference_requests(script, max_requests=2)

        self.assertEqual(len(shots), 1)
        self.assertEqual(shots[0]["scene"], "拉下十连机关")
        self.assertEqual([item["evidenceRole"] for item in requests], ["target_identity", "result"])
        self.assertEqual(requests[0]["captureMode"], "sequence")
        self.assertEqual(requests[0]["windowStartSeconds"], 700.0)
        self.assertEqual(requests[1]["timestampSeconds"], 2775.0)

    def test_reference_planner_adds_diverse_storyboard_search_before_low_priority_context(self):
        script = "\n".join([
            '{"kind":"beat","timestampSeconds":0,"scene":"宣布开抽",'
            '"visualIntent":"开场","referenceUsage":"开场口播"}',
            '{"kind":"beat","timestampSeconds":720,"scene":"继续十连",'
            '"visualIntent":"转折","referenceUsage":"核对中段抽卡界面"}',
            '{"kind":"beat","timestampSeconds":2220,"scene":"双黄全歪",'
            '"visualIntent":"低谷","referenceUsage":"核对双黄结果"}',
            '{"kind":"beat","timestampSeconds":5460,"scene":"尾声",'
            '"visualIntent":"收束","referenceUsage":"核对结束画面"}',
            '{"kind":"reference","timestampSeconds":60,"evidenceRole":"target_identity",'
            '"mustShow":"全部UP目标","referenceUsage":"核对卡池",'
            '"captureMode":"sequence","windowStartSeconds":0,"windowEndSeconds":120}',
            '{"kind":"reference","timestampSeconds":5280,"evidenceRole":"result",'
            '"mustShow":"完整十连结果","referenceUsage":"核对结果",'
            '"captureMode":"sequence","windowStartSeconds":5280,"windowEndSeconds":5460}',
            '{"kind":"reference","timestampSeconds":5520,"evidenceRole":"story_context",'
            '"mustShow":"结尾预告","referenceUsage":"核对预告",'
            '"captureMode":"single"}',
        ])

        requests = comic.extract_reference_requests(script, max_requests=4)

        self.assertEqual([item["timestampSeconds"] for item in requests], [
            60.0, 5280.0, 720.0, 2220.0
        ])
        self.assertEqual([item["requestSource"] for item in requests], [
            "script_reference", "script_reference",
            "storyboard_supplement", "storyboard_supplement",
        ])
        self.assertNotIn(5520.0, [item["timestampSeconds"] for item in requests])

    def test_legacy_storyboard_beats_derive_soft_reference_requests(self):
        script = (
            '{"timestampSeconds":120,"scene":"开场",'
            '"visualIntent":"广角","referenceUsage":"核对游戏主页"}'
        )

        requests = comic.extract_reference_requests(script, max_requests=2)

        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]["evidenceRole"], "story_context")
        self.assertEqual(requests[0]["mustShow"], "核对游戏主页")
        self.assertEqual(requests[0]["captureMode"], "single")

    def test_immersive_gacha_prompt_requires_target_and_result_evidence(self):
        prompt = comic.build_comic_generation_prompt(
            "异色瞳机械兔耳少女",
            "[12m] 主播打开卡池准备代抽。[46m] 十连结果揭晓。",
            "30655190",
            storytelling={"variant": "immersive_v1"},
        )

        self.assertIn('"kind":"reference"', prompt)
        self.assertIn("抽取前的target_identity", prompt)
        self.assertIn("抽取/揭晓后的result", prompt)
        self.assertIn("所有关键UP或高稀有目标", prompt)
        self.assertIn("使用sequence", prompt)
        self.assertIn("系统会保留请求时刻锚点并补充搜索帧", prompt)

    def test_coverage_candidate_search_includes_banner_and_result_offsets(self):
        highlight = "\n".join([
            "[2m] 十连开始，继续抽卡。",
            "[12m] 卡池招募后继续十连，限定目标一直歪。",
            "[46m] 两个都到了，抽到了两个角色。",
            "[84m] 后面又抽到一个普通结果。",
        ])

        target_candidates = comic.select_evidence_coverage_candidates(
            highlight, "target_identity", max_candidates=4
        )
        result_candidates = comic.select_evidence_coverage_candidates(
            highlight, "result", max_candidates=4
        )

        self.assertIn(721.0, [item["timestampSeconds"] for item in target_candidates])
        self.assertIn(2775.0, [item["timestampSeconds"] for item in result_candidates])
        result_46m = next(item for item in result_candidates if item["timestampSeconds"] == 2775.0)
        self.assertEqual(result_46m["label"], "46m +15s")

    def test_immersive_image_collection_prefers_individual_frames_over_contact_sheet(self):
        contact_sheet = self.root / "contact.jpg"
        contact_sheet.write_bytes(b"contact")
        directed = []
        for index, timestamp in enumerate([120, 360, 720], start=1):
            frame = self.root / f"frame-{index}.jpg"
            frame.write_bytes(b"frame")
            directed.append({
                "path": str(frame),
                "timestampSeconds": timestamp,
                "scene": f"场景{index}",
                "visualIntent": "动态构图",
                "referenceUsage": f"核对事件{index}",
            })
        manifest = []

        with mock.patch.dict(os.environ, {"SCREENSHOT_PATH": str(contact_sheet)}):
            images = comic.collect_all_images(
                "25788785",
                str(self.highlight),
                directed_screenshots=directed,
                screenshot_mode="individual",
                image_manifest=manifest,
            )

        self.assertEqual([Path(item).name for item in images], [
            "host.png", "frame-1.jpg", "frame-2.jpg", "frame-3.jpg"
        ])
        self.assertNotIn("contact.jpg", [Path(item).name for item in images])
        self.assertEqual([item["role"] for item in manifest], [
            "host", "directed_screenshot", "directed_screenshot", "directed_screenshot"
        ])
        reference_prompt = comic.format_image_reference_manifest(manifest)
        self.assertIn("参考图2：直播 120 秒关键帧", reference_prompt)
        self.assertIn("用途：核对事件1", reference_prompt)

    def test_immersive_budget_matches_provider_limit_without_changing_default_limit(self):
        directed = []
        for index in range(1, 6):
            frame = self.root / f"evidence-{index}.jpg"
            frame.write_bytes(b"frame")
            directed.append({
                "path": str(frame),
                "timestampSeconds": index * 60,
                "referenceUsage": f"核对证据{index}",
            })

        default_images = comic.collect_all_images(
            "25788785",
            str(self.highlight),
            directed_screenshots=directed,
            screenshot_mode="individual",
        )
        immersive_images = comic.collect_all_images(
            "25788785",
            str(self.highlight),
            directed_screenshots=directed,
            screenshot_mode="individual",
            max_total_images=5,
        )

        self.assertEqual(len(default_images), 4)
        self.assertEqual(len(immersive_images), 5)
        self.assertEqual(Path(immersive_images[-1]).name, "evidence-4.jpg")

    def test_critical_evidence_is_reserved_and_manifest_mapping_uses_actual_uploads(self):
        extra_streamer = self.config["ai"]["streamerRegistry"]["shiori"]
        directed = []
        evidence_specs = [
            ("target-coverage.jpg", "target_identity", "highlight_coverage_sheet"),
            ("result-coverage.jpg", "result", "highlight_coverage_sheet"),
            ("target-anchor.jpg", "target_identity", "script_reference"),
            ("result-anchor.jpg", "result", "script_reference"),
        ]
        for filename, evidence_role, request_source in evidence_specs:
            frame = self.root / filename
            frame.write_bytes(b"frame")
            directed.append({
                "path": str(frame),
                "timestampSeconds": 120,
                "evidenceRole": evidence_role,
                "requestSource": request_source,
                "mustShow": filename,
            })
        # Put anchors first to prove collection reorders high-coverage evidence.
        directed = [directed[2], directed[3], directed[0], directed[1]]
        manifest = []

        images = comic.collect_all_images(
            "25788785",
            str(self.highlight),
            extra_streamers=[extra_streamer],
            directed_screenshots=directed,
            screenshot_mode="individual",
            image_manifest=manifest,
            max_total_images=5,
        )
        constraints = comic.build_multi_character_constraints(
            [extra_streamer], manifest
        )

        self.assertEqual([Path(item).name for item in images], [
            "host.png",
            "target-coverage.jpg",
            "result-coverage.jpg",
            "target-anchor.jpg",
            "result-anchor.jpg",
        ])
        self.assertNotIn("shiori.png", [Path(item).name for item in images])
        self.assertIn("栞栞 没有参考图", constraints)
        self.assertNotIn("参考图2 = 栞栞", constraints)

    def test_reference_manifest_marks_must_show_as_hard_constraint(self):
        manifest = [
            {"path": str(self.host), "role": "host"},
            {
                "path": str(self.root / "pool-a.jpg"),
                "role": "directed_screenshot",
                "referenceRequestId": "E1",
                "evidenceRole": "target_identity",
                "mustShow": "两位UP六星角色的发型、服装、配色和人数",
                "referenceUsage": "核对抽前卡池页",
                "timestampSeconds": 720,
                "selectedTimestampSeconds": 711.5,
                "candidateIndex": 1,
                "candidateCount": 2,
            },
            {
                "path": str(self.root / "pool-b.jpg"),
                "role": "directed_screenshot",
                "referenceRequestId": "E1",
                "evidenceRole": "target_identity",
                "mustShow": "两位UP六星角色的发型、服装、配色和人数",
                "referenceUsage": "核对抽前卡池页",
                "timestampSeconds": 720,
                "selectedTimestampSeconds": 729.0,
                "candidateIndex": 2,
                "candidateCount": 2,
            },
        ]

        reference_prompt = comic.format_image_reference_manifest(manifest)
        image_prompt, _, _ = comic.build_comic_prompt(
            "抽卡后结果揭晓。",
            room_id="30655190",
            existing_comic='{"format":"immersive_v1","composition":"电影感主画面"}',
            storytelling={"variant": "immersive_v1"},
            image_manifest=manifest,
        )

        self.assertIn("视觉证据请求E1，候选1/2", reference_prompt)
        self.assertIn("必须呈现：两位UP六星角色的发型、服装、配色和人数", reference_prompt)
        self.assertIn("“必须呈现”是请求E1整体的硬约束", reference_prompt)
        self.assertIn("同一视觉证据请求的多张候选图组成一个搜索组", image_prompt)
        self.assertIn("加载页、黑屏、半揭晓或相邻事件只用于定位", image_prompt)
        self.assertIn("evidenceRole=target_identity", image_prompt)
        self.assertIn("不得换成别的角色", image_prompt)

    def test_reference_manifest_explains_coverage_search_sheet(self):
        manifest = [{
            "path": str(self.root / "coverage.jpg"),
            "role": "directed_screenshot",
            "referenceRequestId": "C_TARGET_IDENTITY",
            "requestSource": "highlight_coverage_sheet",
            "evidenceRole": "target_identity",
            "mustShow": "全部UP目标角色",
            "referenceUsage": "跨直播搜索卡池页",
            "captureMode": "coverage_sheet",
            "candidateCount": 12,
            "selectionMode": "coverage_sheet",
        }]

        reference_prompt = comic.format_image_reference_manifest(manifest)
        image_prompt, _, _ = comic.build_comic_prompt(
            "抽卡直播。",
            room_id="30655190",
            existing_comic='{"format":"immersive_v1","composition":"电影感"}',
            storytelling={"variant": "immersive_v1"},
            image_manifest=manifest,
        )

        self.assertIn("覆盖搜索拼图（12个带时间标签的候选格）", reference_prompt)
        self.assertIn("requestSource=highlight_coverage_sheet", image_prompt)
        self.assertIn("拼图中的其它时间点不是要同时画出的内容", image_prompt)

    def test_directed_screenshot_generation_uses_storyboard_timestamps(self):
        source_video = self.root / "source.flv"
        source_video.write_bytes(b"video")
        script = "\n".join([
            '{"format":"immersive_v1","composition":"长卷"}',
            '{"timestampSeconds":60,"scene":"开场","visualIntent":"广角","referenceUsage":"核对场景"}',
            '{"timestampSeconds":180,"scene":"转折","visualIntent":"特写","referenceUsage":"核对界面"}',
        ])
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if "ffprobe" in str(args[0]):
                return comic.subprocess.CompletedProcess(args, 0, stdout=b"600\n", stderr=b"")
            Path(args[-1]).write_bytes(b"jpg")
            return comic.subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        with mock.patch.object(comic.shutil, "which", side_effect=lambda name: name), \
                mock.patch.object(comic.subprocess, "run", side_effect=fake_run):
            frames = comic.generate_directed_storyboard_screenshots(
                str(self.highlight),
                script,
                {
                    "variant": "immersive_v1",
                    "directedScreenshots": {
                        "enabled": True,
                        "maxImages": 2,
                        "useVisualSelection": False,
                    },
                },
                source_video_path=str(source_video),
            )

        self.assertEqual(len(frames), 2)
        ffmpeg_calls = [item for item in calls if "ffmpeg" in str(item[0])]
        self.assertEqual([item[item.index("-ss") + 1] for item in ffmpeg_calls], ["60.000", "180.000"])
        self.assertTrue(all("scale=960" in item[item.index("-vf") + 1] for item in ffmpeg_calls))
        self.assertEqual([item["selectedTimestampSeconds"] for item in frames], [60.0, 180.0])

    def test_sequence_reference_splits_window_without_crowding_out_result(self):
        source_video = self.root / "source.flv"
        source_video.write_bytes(b"video")
        script = "\n".join([
            '{"format":"immersive_v1","composition":"长卷"}',
            '{"kind":"beat","timestampSeconds":100,"scene":"启动十连",'
            '"visualIntent":"广角","referenceUsage":"叙事"}',
            '{"kind":"reference","timestampSeconds":120,"evidenceRole":"target_identity",'
            '"mustShow":"两位UP六星","referenceUsage":"核对UP外观",'
            '"captureMode":"sequence","windowStartSeconds":100,"windowEndSeconds":140}',
            '{"kind":"reference","timestampSeconds":200,"evidenceRole":"result",'
            '"mustShow":"实际十连结果","referenceUsage":"核对结果",'
            '"captureMode":"single","windowStartSeconds":190,"windowEndSeconds":210}',
        ])
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if "ffprobe" in str(args[0]):
                return comic.subprocess.CompletedProcess(args, 0, stdout=b"600\n", stderr=b"")
            Path(args[-1]).write_bytes(b"jpg")
            return comic.subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        with mock.patch.object(comic.shutil, "which", side_effect=lambda name: name), \
                mock.patch.object(comic.subprocess, "run", side_effect=fake_run):
            frames = comic.generate_directed_storyboard_screenshots(
                str(self.highlight),
                script,
                {
                    "variant": "immersive_v1",
                    "directedScreenshots": {
                        "enabled": True,
                        "maxImages": 3,
                        "maxRequests": 2,
                        "maxFramesPerRequest": 2,
                        "useVisualSelection": False,
                    },
                },
                source_video_path=str(source_video),
            )

        ffmpeg_calls = [item for item in calls if "ffmpeg" in str(item[0])]
        self.assertEqual([item[item.index("-ss") + 1] for item in ffmpeg_calls], [
            "120.000", "200.000", "110.000"
        ])
        self.assertEqual([item["evidenceRole"] for item in frames], [
            "target_identity", "result", "target_identity"
        ])
        self.assertEqual([item["candidateIndex"] for item in frames], [1, 1, 2])
        self.assertEqual([item["candidateCount"] for item in frames], [2, 1, 2])
        self.assertEqual([item["selectionMode"] for item in frames], [
            "exact_timestamp", "exact_timestamp", "window_midpoint"
        ])

    def test_explicit_sequence_keeps_exact_anchor_before_visual_complement(self):
        source_video = self.root / "source.flv"
        source_video.write_bytes(b"video")
        script = (
            '{"kind":"reference","timestampSeconds":120,"evidenceRole":"target_identity",'
            '"mustShow":"两位UP六星","referenceUsage":"核对UP外观",'
            '"captureMode":"sequence","windowStartSeconds":100,"windowEndSeconds":140}'
        )
        calls = []
        selector_calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if "ffprobe" in str(args[0]):
                return comic.subprocess.CompletedProcess(args, 0, stdout=b"600\n", stderr=b"")
            Path(args[-1]).write_bytes(b"anchor-jpg")
            return comic.subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        class FakeSelectedImage:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def convert(self, mode):
                return self

            def thumbnail(self, size):
                return None

            def save(self, output_path, *args, **kwargs):
                Path(output_path).write_bytes(b"visual-jpg")

        class FakeImage:
            @staticmethod
            def open(path):
                return FakeSelectedImage()

        class FakeCoverGenerator:
            def select_best_frame(self, *args, **kwargs):
                selector_calls.append(kwargs)
                Path(kwargs["output_path"]).write_bytes(b"candidate-jpg")
                return kwargs["output_path"], 110.0

        cover_module = types.ModuleType("cover_generator")
        cover_module.CoverGenerator = FakeCoverGenerator
        pil_module = types.ModuleType("PIL")
        pil_module.Image = FakeImage

        with mock.patch.dict(sys.modules, {"cover_generator": cover_module, "PIL": pil_module}), \
                mock.patch.object(comic.shutil, "which", side_effect=lambda name: name), \
                mock.patch.object(comic.subprocess, "run", side_effect=fake_run):
            frames = comic.generate_directed_storyboard_screenshots(
                str(self.highlight),
                script,
                {
                    "variant": "immersive_v1",
                    "directedScreenshots": {
                        "enabled": True,
                        "maxImages": 2,
                        "maxRequests": 1,
                        "maxFramesPerRequest": 2,
                        "useVisualSelection": True,
                    },
                },
                source_video_path=str(source_video),
            )

        ffmpeg_calls = [item for item in calls if "ffmpeg" in str(item[0])]
        self.assertEqual(len(ffmpeg_calls), 1)
        self.assertEqual(ffmpeg_calls[0][ffmpeg_calls[0].index("-ss") + 1], "120.000")
        self.assertEqual(len(selector_calls), 1)
        self.assertEqual(selector_calls[0]["clip_start"], 100.0)
        self.assertEqual([item["selectedTimestampSeconds"] for item in frames], [120.0, 110.0])
        self.assertEqual([item["selectionMode"] for item in frames], [
            "exact_timestamp", "visual_best"
        ])

    def test_visual_frame_selection_records_actual_timestamp_in_reference_manifest(self):
        source_video = self.root / "source.flv"
        source_video.write_bytes(b"video")
        script = "\n".join([
            '{"format":"immersive_v1","composition":"长卷"}',
            '{"timestampSeconds":120,"scene":"启动十连","visualIntent":"广角","referenceUsage":"核对明日方舟主界面"}',
        ])
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if "ffprobe" in str(args[0]):
                return comic.subprocess.CompletedProcess(args, 0, stdout=b"600\n", stderr=b"")
            raise AssertionError("视觉候选帧成功后不应再调用 ffmpeg 直接截图")

        class FakeSelectedImage:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc_value, traceback):
                return False

            def convert(self, mode):
                return self

            def thumbnail(self, size):
                return None

            def save(self, output_path, *args, **kwargs):
                Path(output_path).write_bytes(b"selected-jpeg")

        class FakeImage:
            @staticmethod
            def open(path):
                return FakeSelectedImage()

        class FakeCoverGenerator:
            def select_best_frame(self, *args, **kwargs):
                output_path = kwargs["output_path"]
                Path(output_path).write_bytes(b"candidate-jpeg")
                return output_path, 179.4

        cover_module = types.ModuleType("cover_generator")
        cover_module.CoverGenerator = FakeCoverGenerator
        pil_module = types.ModuleType("PIL")
        pil_module.Image = FakeImage

        with mock.patch.dict(sys.modules, {"cover_generator": cover_module, "PIL": pil_module}), \
                mock.patch.object(comic.shutil, "which", side_effect=lambda name: name), \
                mock.patch.object(comic.subprocess, "run", side_effect=fake_run):
            frames = comic.generate_directed_storyboard_screenshots(
                str(self.highlight),
                script,
                {
                    "variant": "immersive_v1",
                    "directedScreenshots": {
                        "enabled": True,
                        "maxImages": 1,
                        "useVisualSelection": True,
                    },
                },
                source_video_path=str(source_video),
            )

        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["timestampSeconds"], 120.0)
        self.assertEqual(frames[0]["selectedTimestampSeconds"], 179.4)
        self.assertEqual(len([item for item in calls if "ffmpeg" in str(item[0])]), 0)

        manifest = []
        comic.collect_all_images(
            "25788785",
            str(self.highlight),
            directed_screenshots=frames,
            screenshot_mode="individual",
            image_manifest=manifest,
        )
        self.assertEqual(manifest[1]["selectedTimestampSeconds"], 179.4)
        reference_prompt = comic.format_image_reference_manifest(manifest)
        self.assertIn("脚本事件约在直播 120 秒", reference_prompt)
        self.assertIn("同一事件窗口 179.4 秒选取", reference_prompt)

    def test_visual_frame_selector_system_exit_falls_back_to_ffmpeg(self):
        source_video = self.root / "source.flv"
        source_video.write_bytes(b"video")
        script = "\n".join([
            '{"format":"immersive_v1","composition":"长卷"}',
            '{"timestampSeconds":120,"scene":"启动十连","visualIntent":"广角","referenceUsage":"核对界面"}',
        ])
        calls = []

        def fake_run(args, **kwargs):
            calls.append(args)
            if "ffprobe" in str(args[0]):
                return comic.subprocess.CompletedProcess(args, 0, stdout=b"600\n", stderr=b"")
            Path(args[-1]).write_bytes(b"jpg")
            return comic.subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        real_import = builtins.__import__

        def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name == "cover_generator":
                raise SystemExit(1)
            return real_import(name, globals, locals, fromlist, level)

        with mock.patch("builtins.__import__", side_effect=fake_import), \
                mock.patch.object(comic.shutil, "which", side_effect=lambda name: name), \
                mock.patch.object(comic.subprocess, "run", side_effect=fake_run):
            frames = comic.generate_directed_storyboard_screenshots(
                str(self.highlight),
                script,
                {
                    "variant": "immersive_v1",
                    "directedScreenshots": {
                        "enabled": True,
                        "maxImages": 1,
                        "useVisualSelection": True,
                    },
                },
                source_video_path=str(source_video),
            )

        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["selectedTimestampSeconds"], 120.0)
        self.assertEqual(len([item for item in calls if "ffmpeg" in str(item[0])]), 1)

    def test_visual_frame_postprocessing_failure_records_ffmpeg_timestamp(self):
        source_video = self.root / "source.flv"
        source_video.write_bytes(b"video")
        script = "\n".join([
            '{"format":"immersive_v1","composition":"长卷"}',
            '{"timestampSeconds":120,"scene":"启动十连","visualIntent":"广角","referenceUsage":"核对界面"}',
        ])

        def fake_run(args, **kwargs):
            if "ffprobe" in str(args[0]):
                return comic.subprocess.CompletedProcess(args, 0, stdout=b"600\n", stderr=b"")
            Path(args[-1]).write_bytes(b"fallback-jpg")
            return comic.subprocess.CompletedProcess(args, 0, stdout=b"", stderr=b"")

        class FakeImage:
            @staticmethod
            def open(path):
                raise OSError("candidate image cannot be decoded")

        class FakeCoverGenerator:
            def select_best_frame(self, *args, **kwargs):
                output_path = kwargs["output_path"]
                Path(output_path).write_bytes(b"invalid-candidate")
                return output_path, 179.4

        cover_module = types.ModuleType("cover_generator")
        cover_module.CoverGenerator = FakeCoverGenerator
        pil_module = types.ModuleType("PIL")
        pil_module.Image = FakeImage

        with mock.patch.dict(sys.modules, {"cover_generator": cover_module, "PIL": pil_module}), \
                mock.patch.object(comic.shutil, "which", side_effect=lambda name: name), \
                mock.patch.object(comic.subprocess, "run", side_effect=fake_run):
            frames = comic.generate_directed_storyboard_screenshots(
                str(self.highlight),
                script,
                {
                    "variant": "immersive_v1",
                    "directedScreenshots": {
                        "enabled": True,
                        "maxImages": 1,
                        "useVisualSelection": True,
                    },
                },
                source_video_path=str(source_video),
            )

        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["timestampSeconds"], 120.0)
        self.assertEqual(frames[0]["selectedTimestampSeconds"], 120.0)

    def test_storytelling_metadata_is_written_to_script_meta(self):
        output = self.root / "immersive_COMIC_SCRIPT.txt"
        storytelling = comic.select_comic_storytelling_variant(
            self.config, "25788785", "highlight", override="immersive_v1"
        )
        shots = [{
            "timestampSeconds": 120,
            "scene": "场景",
            "visualIntent": "广角",
            "referenceUsage": "核对界面",
        }]
        requests = [{
            "referenceRequestId": "E1",
            "timestampSeconds": 120,
            "evidenceRole": "target_identity",
            "mustShow": "两位UP角色",
            "referenceUsage": "核对卡池页",
            "captureMode": "single",
        }]

        comic.write_comic_script_meta(
            str(output),
            {"status": "success", "provider": "test", "model": "test"},
            "25788785",
            "highlight",
            [],
            None,
            storytelling,
            shots,
            requests,
        )
        meta = json.loads(
            Path(comic.comic_script_meta_path(str(output))).read_text(encoding="utf-8")
        )

        self.assertEqual(meta["storytellingVariant"], "immersive_v1")
        self.assertEqual(meta["screenshotMode"], "individual")
        self.assertEqual(meta["storyboardShots"], shots)
        self.assertEqual(meta["referenceRequests"], requests)


if __name__ == "__main__":
    unittest.main()
