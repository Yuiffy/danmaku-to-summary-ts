"""
Generate clips from the FLV using ffmpeg.
- Multi-cut support (remove boring parts within a segment)
- Burn ASS subtitles with speaker colors
- Output MP4 to clips_0607/
- Uses ASCII-only temp paths for ffmpeg compatibility
"""
import os
import subprocess
import shutil

BASE_DIR = r"D:\files\videos\DDTV录播\25788785_岁己SUI\2026_06_04"
FLV_PATH = os.path.join(BASE_DIR, "录制-25788785-20260604-201111-833-高手小岁和臭栞栞玩五子棋_merged.flv")
ASS_PATH = os.path.join(BASE_DIR, "录制-25788785-20260604-201111-833-高手小岁和臭栞栞玩五子棋_merged.ass")
OUTPUT_DIR = os.path.join(BASE_DIR, "clips_0607")
TEMP_DIR = os.path.join(os.environ.get("TEMP", r"C:\Temp"), "clip_work")

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(TEMP_DIR, exist_ok=True)

# Copy ASS to temp with ASCII name
TEMP_ASS = os.path.join(TEMP_DIR, "sub.ass")
shutil.copy2(ASS_PATH, TEMP_ASS)
print(f"ASS copied to: {TEMP_ASS}")


def run_ffmpeg(cmd, timeout=300):
    result = subprocess.run(
        cmd, capture_output=True, timeout=timeout,
        encoding='utf-8', errors='replace'
    )
    return result


def make_clip_multi_cut(clip_id, cuts, output_name):
    """
    Multi-cut: extract segments, concatenate, burn subtitles.
    clip_id: short ASCII identifier for temp files
    cuts: list of (start, end) in seconds
    output_name: final output filename (can contain Chinese)
    """
    print(f"\n=== Generating: {output_name} ===")
    print(f"  Cuts: {cuts}")
    total_duration = sum(e - s for s, e in cuts)
    print(f"  Total duration: {total_duration:.0f}s ({total_duration/60:.1f}m)")

    # Step 1: Extract segments to ASCII temp paths
    temp_files = []
    for i, (start, end) in enumerate(cuts):
        duration = end - start
        temp_path = os.path.join(TEMP_DIR, f"seg_{clip_id}_{i}.ts")
        cmd = [
            "ffmpeg", "-y",
            "-ss", f"{start:.3f}",
            "-i", FLV_PATH,
            "-t", f"{duration:.3f}",
            "-c", "copy",
            "-avoid_negative_ts", "make_zero",
            "-f", "mpegts",
            temp_path,
            "-nostdin", "-loglevel", "error"
        ]
        print(f"  Extracting segment {i}: {start:.1f}s-{end:.1f}s ({duration:.1f}s)")
        result = run_ffmpeg(cmd, timeout=300)
        if result.returncode != 0:
            print(f"  ERROR extract seg {i}: {result.stderr[:500]}")
            return None
        temp_files.append(temp_path)

    # Step 2: Concat using ASCII paths
    concat_path = os.path.join(TEMP_DIR, f"concat_{clip_id}.txt")
    with open(concat_path, "w") as f:
        for tf in temp_files:
            safe_path = tf.replace("\\", "/")
            f.write(f"file '{safe_path}'\n")

    merged_ts = os.path.join(TEMP_DIR, f"merged_{clip_id}.ts")
    cmd = [
        "ffmpeg", "-y",
        "-f", "concat", "-safe", "0",
        "-i", concat_path,
        "-c", "copy",
        "-f", "mpegts",
        merged_ts,
        "-nostdin", "-loglevel", "error"
    ]
    print(f"  Concatenating {len(temp_files)} segments...")
    result = run_ffmpeg(cmd, timeout=300)
    if result.returncode != 0:
        print(f"  ERROR concat: {result.stderr[:500]}")
        return None

    # Step 3: Burn ASS subtitles and encode
    output_path = os.path.join(OUTPUT_DIR, f"{output_name}.mp4")
    # Output to temp first, then move
    temp_output = os.path.join(TEMP_DIR, f"output_{clip_id}.mp4")
    cmd = [
        "ffmpeg", "-y",
        "-i", merged_ts,
        "-vf", f"ass=\\'{TEMP_ASS}\\'",
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "20",
        "-c:a", "aac",
        "-b:a", "192k",
        "-map", "0:v:0",
        "-map", "0:a:0",
        temp_output,
        "-nostdin", "-loglevel", "error"
    ]
    print(f"  Burning subtitles and encoding...")
    result = run_ffmpeg(cmd, timeout=3600)
    if result.returncode != 0:
        print(f"  ERROR encode: {result.stderr[:500]}")
        return None

    # Move to final output
    shutil.move(temp_output, output_path)

    # Cleanup temp files
    for tf in temp_files:
        try:
            os.remove(tf)
        except:
            pass
    try:
        os.remove(concat_path)
        os.remove(merged_ts)
    except:
        pass

    size_mb = os.path.getsize(output_path) / 1e6
    print(f"  Output: {output_path} ({size_mb:.1f} MB)")
    return output_path


# === Clip definitions ===

# Clip 1: 扫雷 - 岁己第一次学扫雷的灾难现场
clip_minesweeper_cuts = [
    (76 * 60 + 30, 79 * 60 + 30),   # 76:30-79:30 学规则+第一次炸
    (80 * 60 + 0, 82 * 60 + 30),     # 80:00-82:30 重新开始+渐入佳境
]

# Clip 2: 飞行棋 - 岁己的飞机被吃了还不知道 + 托管混乱
clip_flightchess_cuts = [
    (131 * 60 + 0, 133 * 60 + 30),   # 131:00-133:30 开始+飞机被吃
    (135 * 60 + 30, 139 * 60 + 0),   # 135:30-139:00 托管混乱+崩溃
]

print("Starting clip generation...")
print(f"FLV: {FLV_PATH}")
print(f"Output: {OUTPUT_DIR}")

result1 = make_clip_multi_cut("minesweeper", clip_minesweeper_cuts, "岁己栞栞_扫雷初体验灾难现场")
result2 = make_clip_multi_cut("flightchess", clip_flightchess_cuts, "岁己栞栞_飞行棋托管崩溃现场")

print("\n=== Summary ===")
if result1:
    print(f"  ✅ 扫雷: {result1}")
else:
    print(f"  ❌ 扫雷: FAILED")
if result2:
    print(f"  ✅ 飞行棋: {result2}")
else:
    print(f"  ❌ 飞行棋: FAILED")
