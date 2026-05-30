"""
说话人区分测试脚本 - 使用 SenseVoice + CAM++ 对音频进行说话人分离
用法: python tests/test_speaker_diarization.py <audio_path> [output_srt_path]
"""
import json
import os
import subprocess
import sys
import time


def format_timestamp_srt(seconds):
    """将秒数格式化为 SRT 时间戳"""
    if seconds is None:
        return "00:00:00,000"
    ms = int((seconds % 1) * 1000)
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def load_hotwords_from_config(project_root):
    """从 config/default.json 加载热词，转换为 SenseVoice 格式"""
    config_path = os.path.join(project_root, "config", "default.json")
    if not os.path.exists(config_path):
        return None

    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
    except Exception:
        return None

    hotwords_raw = config.get("asr", {}).get("common_hotwords", [])
    if not hotwords_raw:
        return None

    # SenseVoice hotword 格式: "词1 权重1 词2 权重2 ..."
    # 也收集所有别名作为无权重热词
    weighted_parts = []
    unweighted_words = []

    for hw in hotwords_raw:
        word = hw.get("word", "").strip()
        weight = hw.get("weight", 20)
        aliases = hw.get("aliases", [])

        if word:
            weighted_parts.append(f"{word} {weight}")
            unweighted_words.append(word)

        for alias in aliases:
            alias = alias.strip()
            if alias and len(alias) > 1:  # 过滤掉单字符别名
                unweighted_words.append(alias)

    weighted_hotword = " ".join(weighted_parts)
    unweighted_hotword = " ".join(unweighted_words)

    return {
        "hotword": weighted_hotword,
        "hotword_unweighted": unweighted_hotword,
    }


def main():
    if len(sys.argv) < 2:
        print("用法: python tests/test_speaker_diarization.py <audio_path> [output_srt_path]")
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"❌ 音频文件不存在: {audio_path}")
        sys.exit(1)

    # 默认输出路径
    if len(sys.argv) >= 3:
        output_srt = sys.argv[2]
    else:
        base, _ = os.path.splitext(audio_path)
        output_srt = base + ".speaker.srt"

    # 路径计算
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.abspath(os.path.join(script_dir, ".."))
    ref_dir = os.path.join(project_root, "data", "asr_speaker_refs")

    sui_path = os.path.join(ref_dir, "sui.wav")
    shiori_path = os.path.join(ref_dir, "shiori.wav")

    for p, name in [(sui_path, "岁己SUI"), (shiori_path, "栞栞")]:
        if not os.path.exists(p):
            print(f"❌ 参考音频不存在: {name} -> {p}")
            sys.exit(1)

    print(f"🎵 音频文件: {audio_path}")
    print(f"📝 输出文件: {output_srt}")
    print(f"🎤 参考音频: 岁己SUI ({sui_path}), 栞栞 ({shiori_path})")

    # 加载热词
    hotwords = load_hotwords_from_config(project_root)
    if hotwords:
        print(f"🔥 已加载热词: weighted={len(hotwords['hotword'])}字符, unweighted={len(hotwords['hotword_unweighted'])}字符")
    else:
        print("⚠️ 未找到热词配置，将不使用热词")

    # 构造 SenseVoice 请求 payload
    payload = {
        "audio_path": audio_path,
        "model": "iic/SenseVoiceSmall",
        "vad_model": "fsmn-vad",
        "punc_model": "ct-punc",
        "language": "auto",
        "device": "cuda",
        "use_itn": True,
        "max_vad_segment_s": 8,
        "merge_length_s": 8,
        # 说话人分离配置
        "enable_speaker": True,
        "spk_model": "cam++",
        "preset_spk_num": 2,  # 已知两人: 岁己 + 栞栞
        "speaker_merge_threshold": 0.78,
        "speaker_reference_threshold": 0.28,
        "speaker_references": [
            {
                "speaker": "岁己SUI",
                "audio_path": sui_path,
                "chunk_s": 8,
                "max_chunks": 20,
            },
            {
                "speaker": "栞栞",
                "audio_path": shiori_path,
                "chunk_s": 8,
                "max_chunks": 20,
            },
        ],
    }

    # 添加热词
    if hotwords:
        payload["hotword"] = hotwords["hotword"]
        payload["hotword_unweighted"] = hotwords["hotword_unweighted"]

    # 调用 sensevoice_transcribe.py
    sensevoice_script = os.path.join(project_root, "src", "scripts", "python", "sensevoice_transcribe.py")
    if not os.path.exists(sensevoice_script):
        print(f"❌ 找不到 sensevoice_transcribe.py: {sensevoice_script}")
        sys.exit(1)

    print("\n🚀 开始 SenseVoice + CAM++ 说话人区分处理...")
    print(f"   已知说话人数: 2 (岁己SUI, 栞栞)")
    start_time = time.time()

    payload_json = json.dumps(payload, ensure_ascii=False)

    try:
        result = subprocess.run(
            [sys.executable, sensevoice_script],
            input=payload_json,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=3600,  # 1小时超时
        )
    except subprocess.TimeoutExpired:
        print("❌ 处理超时!")
        sys.exit(1)

    elapsed = time.time() - start_time
    print(f"\n⏱️  处理耗时: {elapsed:.1f}s")

    # 打印 stderr 日志
    if result.stderr:
        # 只打印关键日志
        for line in result.stderr.splitlines():
            if line.strip():
                print(f"   {line}")

    if result.returncode != 0:
        print(f"❌ 处理失败 (exit code: {result.returncode})")
        if result.stderr:
            print(f"   错误信息: {result.stderr[-2000:]}")
        sys.exit(1)

    # 解析结果
    try:
        output = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        print(f"❌ 无法解析输出 JSON: {e}")
        print(f"   stdout: {result.stdout[:2000]}")
        sys.exit(1)

    if "error" in output:
        print(f"❌ 处理错误: {output['error']}")
        if "detail" in output:
            print(f"   详情: {output['detail']}")
        sys.exit(1)

    segments = output.get("segments", [])
    if not segments:
        print("❌ 没有识别到语音段")
        sys.exit(1)

    # 统计说话人
    speaker_counts = {}
    for seg in segments:
        spk = seg.get("speaker", "UNKNOWN")
        speaker_counts[spk] = speaker_counts.get(spk, 0) + 1

    print(f"\n✅ 识别完成! 共 {len(segments)} 个语音段")
    print(f"   说话人统计:")
    for spk, count in sorted(speaker_counts.items()):
        print(f"     {spk}: {count} 段")

    # 写 SRT 文件
    with open(output_srt, "w", encoding="utf-8") as f:
        for idx, seg in enumerate(segments, 1):
            start_s = format_timestamp_srt(seg.get("start", 0))
            end_s = format_timestamp_srt(seg.get("end", 0))
            text = seg.get("text", "").strip()
            speaker = seg.get("speaker", "UNKNOWN")

            if not text:
                continue

            # 添加说话人前缀
            prefix = f"[{speaker}]" if speaker else ""
            f.write(f"{idx}\n{start_s} --> {end_s}\n{prefix}{text}\n\n")

    print(f"\n📄 SRT 已保存: {output_srt}")

    # 也保存 JSON 结果以便分析
    json_output = output_srt.replace(".srt", ".speaker.json")
    with open(json_output, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)
    print(f"📊 JSON 已保存: {json_output}")


if __name__ == "__main__":
    main()