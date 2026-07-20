import os
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(ROOT, "src", "scripts", "python"))

from sensevoice_text import (  # noqa: E402
    _apply_hotword_correction,
    _correct_text_with_protections,
    _resolve_phoneme_protect_terms,
)


def _make_corrector(threshold=0.85):
    hotword_path = os.path.join(ROOT, "tmp", "asr-hotword")
    sys.path.insert(0, hotword_path)
    from hotword import PhonemeCorrector

    pc = PhonemeCorrector(threshold=threshold)
    pc.update_hotwords("小岁\n岁己\n岁己SUI\n")
    return pc


def test_resolve_phoneme_protect_terms_uses_forwarded_exclude_when_only():
    terms = _resolve_phoneme_protect_terms({"protect_terms": ["粉碎机", "小碎步", "击碎"]})
    assert terms == ["粉碎机", "小碎步", "击碎"] or set(terms) == {"粉碎机", "小碎步", "击碎"}
    assert _resolve_phoneme_protect_terms({}) == []
    assert _resolve_phoneme_protect_terms(None) == []


def test_jieba_boundary_protects_crusher_without_exclude_when():
    pc = _make_corrector()
    result = _correct_text_with_protections(
        pc,
        "这个粉碎机打得挺细的",
        {"protect_terms": [], "boundary_protect": True},
    )
    assert result.text == "这个粉碎机打得挺细的"


def test_phoneme_correction_uses_exclude_when_and_keeps_standalone_homophone():
    output = {
        "segments": [
            {"text": "我已经做了会个粉碎机升一下级"},
            {"text": "ok ok 粉粉碎机你有了是吧"},
            {"text": "用石头去把这个粉碎机在这个粉碎机里研"},
            {"text": "碎机前辈今天来了"},
            {"text": "小碎步走过来"},
        ]
    }
    payload = {
        "phoneme_correction": {
            "threshold": 0.85,
            # Same shape JS forwards from corrections.exclude_when
            "protect_terms": ["粉碎机", "小碎步", "击碎", "即将"],
            "exclude_patterns": ["[击打折破摔碾撕咬切压]碎即"],
            "boundary_protect": True,
            "hotwords": "小岁\n岁己\n岁己SUI\n",
        }
    }

    _apply_hotword_correction(output, payload)

    assert output["segments"][0]["text"] == "我已经做了会个粉碎机升一下级"
    assert output["segments"][1]["text"] == "ok ok 粉粉碎机你有了是吧"
    assert output["segments"][2]["text"] == "用石头去把这个粉碎机在这个粉碎机里研"
    assert output["segments"][3]["text"] == "岁己前辈今天来了"
    assert output["segments"][4]["text"] == "小碎步走过来"


def test_exclude_pattern_blocks_overlapping_phoneme_match():
    pc = _make_corrector()
    result = _correct_text_with_protections(
        pc,
        "它会击碎即将撞上这个星球",
        {
            "protect_terms": ["击碎", "即将"],
            "exclude_patterns": ["[击打折破摔碾撕咬切压]碎即"],
            "boundary_protect": False,
            "hotwords": "岁己\n",
        },
    )
    assert "粉岁己" not in result.text
