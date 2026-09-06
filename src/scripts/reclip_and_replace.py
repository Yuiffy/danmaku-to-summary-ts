"""
标准切片重新裁剪+替换流程

场景：用户看了已上传的切片，要求重新裁剪（如「从1:50切到3:05」），替换B站视频。

用法：
    python reclip_and_replace.py \
        --bvid BV1nxje63E9W \
        --clip-mp4 "录制-xxx_fun_19_050110.mp4" \
        --clip-srt "clip_19.srt" \
        --start 110 --end 185 \
        [--cover "cover_19_sui.jpg"]

流程：
    1. 从已有切片mp4裁剪指定时间段（-c copy 快速）
    2. 裁剪SRT并重置时间轴
    3. 烧录字幕（SRT + force_style 项目标准样式）
    4. 替换B站视频（replace_video.py）
    5. （可选）更新封面

注意：
    - start/end 是已有切片内的时间（秒），不是直播源时间
    - 必须在切片目录(clips_dir)下运行 ffmpeg 烧字幕，避免中文路径问题
    - 替换后B站显示「修改内容待审核」，审核通过后生效
"""
import argparse
import os
import re
import subprocess
import sys
import asyncio

sys.path.insert(0, os.path.dirname(__file__))


def parse_ts(ts: str) -> float:
    """SRT timestamp -> seconds"""
    h, m, s = ts.split(":")
    s, ms = (s.split(",") if "," in s else (s, "0"))
    return int(h) * 3600 + int(m) * 60 + float(s) + float(ms) / 1000


def fmt_ts(sec: float) -> str:
    """seconds -> SRT timestamp"""
    if sec < 0:
        sec = 0
    h = int(sec // 3600)
    sec -= h * 3600
    m = int(sec // 60)
    sec -= m * 60
    s = int(sec)
    ms = int(round((sec - s) * 1000))
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def cut_video(clip_mp4: str, start: float, end: float, out_path: str) -> None:
    """用 ffmpeg -c copy 快速裁剪"""
    cmd = [
        "ffmpeg", "-y",
        "-ss", fmt_ts(start).replace(",", "."),
        "-to", fmt_ts(end).replace(",", "."),
        "-i", clip_mp4,
        "-c", "copy",
        out_path,
        "-loglevel", "error",
    ]
    print(f"[1/4] 裁剪视频: {fmt_ts(start)} -> {fmt_ts(end)}")
    subprocess.run(cmd, check=True)
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"      输出: {out_path} ({size_mb:.1f}MB)")


def cut_srt(srt_path: str, start: float, end: float, out_path: str) -> None:
    """裁剪SRT并重置时间轴"""
    with open(srt_path, "r", encoding="utf-8") as f:
        content = f.read()

    blocks = re.split(r"\n\n+", content.strip())
    out_blocks = []
    idx = 1
    for blk in blocks:
        lines = blk.strip().split("\n")
        if len(lines) < 3:
            continue
        m = re.match(
            r"(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})", lines[1]
        )
        if not m:
            continue
        blk_start = parse_ts(m.group(1))
        blk_end = parse_ts(m.group(2))
        if blk_end <= start or blk_start >= end:
            continue
        new_start = max(0, blk_start - start)
        new_end = min(end - start, blk_end - start)
        text = "\n".join(lines[2:])
        out_blocks.append(
            f"{idx}\n{fmt_ts(new_start)} --> {fmt_ts(new_end)}\n{text}"
        )
        idx += 1

    result = "\n\n".join(out_blocks)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(result + "\n")
    print(f"[2/4] 裁剪字幕: {idx - 1} 条 -> {out_path}")


def burn_subtitles(video_path: str, srt_path: str, out_path: str) -> None:
    """烧录字幕（必须在切片目录下运行，用相对路径避免中文路径问题）"""
    clips_dir = os.path.dirname(os.path.abspath(video_path))
    rel_video = os.path.basename(video_path)
    rel_srt = os.path.basename(srt_path)
    rel_out = os.path.basename(out_path)

    cmd = [
        "ffmpeg", "-y",
        "-i", rel_video,
        "-vf", f"subtitles={rel_srt}:force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'",
        "-c:a", "copy",
        rel_out,
        "-loglevel", "error",
    ]
    print(f"[3/4] 烧录字幕...")
    subprocess.run(cmd, check=True, cwd=clips_dir)
    size_mb = os.path.getsize(out_path) / (1024 * 1024)
    print(f"      输出: {out_path} ({size_mb:.1f}MB)")


async def replace_and_update(bvid: str, final_video: str, cover: str | None) -> None:
    """替换B站视频 + 更新封面"""
    from replace_video import replace_video
    from update_cover import update_cover

    print(f"[4/4] 替换B站视频 {bvid} ...")
    await replace_video(bvid, final_video)
    print(f"      ✅ 视频替换完成")

    if cover:
        print(f"      更新封面: {cover}")
        secret_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', 'config', 'secret.json'))
        await update_cover(bvid, cover, None, secret_path)
        print(f"      ✅ 封面更新完成")


def main():
    parser = argparse.ArgumentParser(
        description="标准切片重新裁剪+替换流程"
    )
    parser.add_argument("--bvid", required=True, help="B站稿件BV号")
    parser.add_argument("--clip-mp4", required=True, help="已有切片mp4路径")
    parser.add_argument("--clip-srt", required=True, help="已有切片srt路径")
    parser.add_argument(
        "--start", type=float, required=True, help="裁剪起始时间（秒，切片内时间）"
    )
    parser.add_argument(
        "--end", type=float, required=True, help="裁剪结束时间（秒，切片内时间）"
    )
    parser.add_argument("--cover", default=None, help="可选：更新封面图片路径")
    args = parser.parse_args()

    clips_dir = os.path.dirname(os.path.abspath(args.clip_mp4))
    base = os.path.splitext(os.path.basename(args.clip_mp4))[0]

    cut_mp4 = os.path.join(clips_dir, f"{base}_recut.mp4")
    cut_srt_path = os.path.join(clips_dir, f"{base}_recut.srt")
    final_mp4 = os.path.join(clips_dir, f"{base}_final.mp4")

    # 1. 裁剪视频
    cut_video(args.clip_mp4, args.start, args.end, cut_mp4)

    # 2. 裁剪字幕
    cut_srt(args.clip_srt, args.start, args.end, cut_srt_path)

    # 3. 烧录字幕
    burn_subtitles(cut_mp4, cut_srt_path, final_mp4)

    # 4. 替换B站视频 + 更新封面
    asyncio.run(replace_and_update(args.bvid, final_mp4, args.cover))

    # 清理中间文件
    for tmp in (cut_mp4, cut_srt_path):
        try:
            os.remove(tmp)
        except OSError:
            pass

    print(f"\n🎉 全部完成！")
    print(f"   BV号: {args.bvid}")
    print(f"   链接: https://www.bilibili.com/video/{args.bvid}")
    print(f"   ⏳ B站审核通过后生效")


if __name__ == "__main__":
    main()
