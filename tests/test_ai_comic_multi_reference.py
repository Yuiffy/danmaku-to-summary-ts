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
        comic.set_comic_script_meta(provider="tuZi", model="gpt-5.6-luna", status="success")

        comic.build_comic_prompt(
            "",
            room_id="25788785",
            existing_comic="分镜一：房间主人独自聊天，观众在旁边欢呼。",
        )

        meta = comic.get_comic_script_meta()
        self.assertEqual(meta["provider"], "tuZi")
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


if __name__ == "__main__":
    unittest.main()
