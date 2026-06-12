"""
Post-process ASR results: map unknown speakers, generate SRT files, prepare for clipping.
"""
import json
import os
import sys
import re

BASE_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_04"
FLV_NAME = "录制-25788785-20260604-201111-833-高手小岁和臭栞栞玩五子棋_merged"
JSON_PATH = os.path.join(BASE_DIR, "rerun_asr_output.json")

def fmt_srt_time(seconds):
    ms = int((seconds % 1) * 1000)
    whole = int(seconds)
    h = whole // 3600
    m = (whole % 3600) // 60
    s = whole % 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def fmt_ass_time(seconds):
    cs = int(round(seconds * 100))
    whole = cs // 100
    c = cs % 100
    h = whole // 3600
    m = (whole % 3600) // 60
    s = whole % 60
    return f"{h:d}:{m:02d}:{s:02d}.{c:02d}"

def main():
    with open(JSON_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    segments = data["segments"]
    print(f"Loaded {len(segments)} segments")

    # Step 1: Determine SPEAKER_00 and SPEAKER_01 identity
    # In a 2-person stream, the unknown speakers should be mapped to the other person.
    # Strategy: Look at which named speaker co-occurs most with each SPEAKER_XX
    # Actually, let's use temporal patterns: SPEAKER_00 is the dominant speaker (host),
    # SPEAKER_01 is the guest. Given this is 岁己's stream, SPEAKER_00 = 岁己SUI when unmatched.
    
    # But let's verify: check what percentage of time each SPEAKER_XX overlaps with named speakers
    from collections import defaultdict
    speaker_durations = defaultdict(float)
    for seg in segments:
        dur = seg["end"] - seg["start"]
        speaker_durations[seg["speaker"]] += dur
    
    print("Speaker durations:")
    for spk, dur in sorted(speaker_durations.items(), key=lambda x: -x[1]):
        print(f"  {spk}: {dur:.0f}s ({dur/60:.1f}m)")
    
    # Since 岁己SUI already has the most segments, and SPEAKER_00 is second largest,
    # SPEAKER_00 is likely the unmatched 岁己SUI (lower score segments).
    # SPEAKER_01 and 瑞娅 are likely unmatched 栞栞 (false positive from ref matching).
    
    # Map: SPEAKER_00 -> 岁己SUI, SPEAKER_01 -> 栞栞, 瑞娅 -> 栞栞
    speaker_map = {
        "SPEAKER_00": "岁己SUI",
        "SPEAKER_01": "栞栞",
        "瑞娅": "栞栞",  # false positive - only 2 speakers in this stream
    }
    
    for seg in segments:
        if seg["speaker"] in speaker_map:
            seg["speaker"] = speaker_map[seg["speaker"]]
    
    # Verify final distribution
    final_dist = defaultdict(float)
    for seg in segments:
        dur = seg["end"] - seg["start"]
        final_dist[seg["speaker"]] += dur
    print("\nFinal speaker durations after mapping:")
    for spk, dur in sorted(final_dist.items(), key=lambda x: -x[1]):
        print(f"  {spk}: {dur:.0f}s ({dur/60:.1f}m)")
    
    # Step 2: Generate .speaker.srt (UTF-8, no BOM)
    srt_path = os.path.join(BASE_DIR, f"{FLV_NAME}.speaker.srt")
    with open(srt_path, "w", encoding="utf-8") as f:
        idx = 1
        for seg in segments:
            text = seg["text"].strip()
            if not text:
                continue
            speaker = seg.get("speaker", "UNKNOWN")
            score = seg.get("speaker_score")
            score_str = f" {score:.2f}" if score else ""
            f.write(f"{idx}\n")
            f.write(f"{fmt_srt_time(seg['start'])} --> {fmt_srt_time(seg['end'])}\n")
            f.write(f"[{speaker}{score_str}] {text}\n\n")
            idx += 1
    print(f"\nSpeaker SRT: {srt_path}")
    
    # Step 3: Generate clean .srt (no speaker tags, for subtitle burn-in)
    clean_srt_path = os.path.join(BASE_DIR, f"{FLV_NAME}.srt")
    with open(clean_srt_path, "w", encoding="utf-8") as f:
        idx = 1
        for seg in segments:
            text = seg["text"].strip()
            if not text:
                continue
            # Split long text into multiple lines
            max_chars = 18
            if len(text) <= max_chars:
                lines = [text]
            else:
                # Split at punctuation or by length
                lines = []
                current = ""
                for ch in text:
                    current += ch
                    if ch in "，。！？；：、," and len(current) >= max_chars * 0.5:
                        lines.append(current)
                        current = ""
                    elif len(current) >= max_chars:
                        lines.append(current)
                        current = ""
                if current:
                    lines.append(current)
            
            f.write(f"{idx}\n")
            f.write(f"{fmt_srt_time(seg['start'])} --> {fmt_srt_time(seg['end'])}\n")
            f.write("\n".join(lines) + "\n\n")
            idx += 1
    print(f"Clean SRT: {clean_srt_path}")
    
    # Step 4: Generate ASS subtitles with speaker colors for clipping
    # 岁己SUI: dark red #8B0000, 栞栞: coffee brown #6F4E37
    ass_path = os.path.join(BASE_DIR, f"{FLV_NAME}.ass")
    ass_header = """[Script Info]
Title: 岁己SUI & 栞栞 联动
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: 岁己SUI,Microsoft YaHei,52,&H00FF0000,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2.5,1,2,60,60,80,1
Style: 栞栞,Microsoft YaHei,52,&H00374E6F,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2.5,1,2,60,60,80,1
Style: Default,Microsoft YaHei,52,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2.5,1,2,60,60,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    
    def ass_color(hex_color):
        """Convert #RRGGBB to ASS &H00BBGGRR"""
        h = hex_color.lstrip("#")
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        return f"&H00{b:02X}{g:02X}{r:02X}"
    
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass_header)
        for seg in segments:
            text = seg["text"].strip()
            if not text:
                continue
            speaker = seg.get("speaker", "Default")
            style = speaker if speaker in ("岁己SUI", "栞栞") else "Default"
            
            # Escape ASS special chars
            text_ass = text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
            
            # Add newline for long text
            max_chars = 18
            if len(text_ass) > max_chars:
                # Find a good break point
                for i in range(min(max_chars, len(text_ass)), 0, -1):
                    if text_ass[i] in "，。！？；：、":
                        text_ass = text_ass[:i+1] + "\\N" + text_ass[i+1:]
                        break
                else:
                    text_ass = text_ass[:max_chars] + "\\N" + text_ass[max_chars:]
            
            f.write(f"Dialogue: 0,{fmt_ass_time(seg['start'])},{fmt_ass_time(seg['end'])},{style},,0,0,0,,{text_ass}\n")
    print(f"ASS: {ass_path}")
    
    # Step 5: Save the post-processed JSON for reference
    processed_json_path = os.path.join(BASE_DIR, "rerun_asr_processed.json")
    with open(processed_json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"Processed JSON: {processed_json_path}")
    
    print("\nAll output files generated successfully!")

if __name__ == "__main__":
    main()
