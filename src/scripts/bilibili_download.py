#!/usr/bin/env python
"""
B站视频下载 + 字幕下载工具（基于 yt-dlp）

用法:
  # 下载指定时间段 + 字幕
  python bilibili_download.py --url "https://www.bilibili.com/video/BVxxx/?p=2" \
    --start 01:40:20 --end 01:43:50 \
    --output "D:\\output\\clip.mp4"

  # 只下载字幕
  python bilibili_download.py --url "..." --subs-only --output "D:\\output\\clip"

  # 下载完整视频（不裁剪）
  python bilibili_download.py --url "..." --output "D:\\output\\full.mp4"

依赖:
  - yt-dlp (pip install yt-dlp)
  - 项目 config/secret.json 中的 B站 Cookie

注意事项:
  - Cookie 从 secret.json 自动提取，生成 Netscape cookies.txt
  - 720p 可正常下载，1080P 60帧需要大会员
  - B站 AI 字幕语言代码：ai-zh
  - 下载片段用 --download-sections + --force-keyframes-at-cuts 精确裁剪
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = Path(SCRIPTS_DIR).parent.parent
SECRET_PATH = PROJECT_ROOT / 'config' / 'secret.json'
COOKIE_TXT_PATH = PROJECT_ROOT / 'config' / 'cookies_ytdlp.txt'


def extract_cookie_from_secret():
    """从 secret.json 提取 B站 Cookie，生成 Netscape cookies.txt"""
    with open(SECRET_PATH, encoding='utf-8') as f:
        secret = json.load(f)

    cookie_str = None
    for k, v in secret.items():
        if isinstance(v, str) and 'SESSDATA' in v:
            cookie_str = v
            break
        if isinstance(v, dict):
            for k2, v2 in v.items():
                if isinstance(v2, str) and 'SESSDATA' in v2:
                    cookie_str = v2
                    break
            if cookie_str:
                break

    if not cookie_str:
        raise RuntimeError("在 secret.json 中找不到包含 SESSDATA 的 Cookie")

    lines = ['# Netscape HTTP Cookie File']
    for part in cookie_str.split(';'):
        part = part.strip()
        if '=' not in part:
            continue
        name, val = part.split('=', 1)
        lines.append(f'.bilibili.com\tTRUE\t/\tFALSE\t0\t{name.strip()}\t{val.strip()}')

    with open(COOKIE_TXT_PATH, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')

    print(f"[COOKIE] Cookie 已导出到 {COOKIE_TXT_PATH}")
    return COOKIE_TXT_PATH


def parse_srt_time(t):
    t = t.strip().replace(',', '.')
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def fmt_srt_time(sec):
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    if ms == 1000:
        ms = 0
        s += 1
    return f'{h:02d}:{m:02d}:{s:02d},{ms:03d}'


def trim_srt(src_srt, start_sec, end_sec, out_path):
    """裁剪 SRT 并重置时间轴到 0"""
    blocks = open(src_srt, encoding='utf-8-sig').read().strip().split('\n\n')
    out_blocks = []
    idx = 1
    for b in blocks:
        lines = b.strip().split('\n')
        if len(lines) < 3:
            continue
        try:
            a, b2 = lines[1].split(' --> ')
            s, e = parse_srt_time(a), parse_srt_time(b2)
        except Exception:
            continue
        if e < start_sec or s > end_sec:
            continue
        ns = max(0, s - start_sec)
        ne = max(0, e - start_sec)
        text = '\n'.join(lines[2:])
        out_blocks.append(f'{idx}\n{fmt_srt_time(ns)} --> {fmt_srt_time(ne)}\n{text}')
        idx += 1

    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(out_blocks) + '\n')
    print(f"[SRT] 裁剪完成: {len(out_blocks)} 条字幕 → {out_path}")
    return out_path


def download_clip(url, start=None, end=None, output=None, subs_only=False, quality='30064+30280'):
    """
    下载 B站视频片段 + 字幕

    Args:
        url: B站视频 URL
        start: 开始时间 HH:MM:SS（可选）
        end: 结束时间 HH:MM:SS（可选）
        output: 输出文件路径
        subs_only: 只下载字幕
        quality: 视频质量（30064=720p, 30080=1080p, 30032=480p）
    """
    cookie_path = extract_cookie_from_secret()

    if output is None:
        output = os.path.join(os.getcwd(), 'bilibili_clip')

    base = os.path.splitext(output)[0]

    # 构建 yt-dlp 命令
    cmd = ['yt-dlp', '--cookies', str(cookie_path)]

    if subs_only:
        # 只下载字幕
        cmd += ['--write-subs', '--sub-langs', 'ai-zh', '--skip-download',
                '-o', base]
        print(f"[DOWNLOAD] 下载字幕: {url}")
    else:
        if start and end:
            cmd += ['-f', quality,
                    '--download-sections', f'*{start}-{end}',
                    '--force-keyframes-at-cuts',
                    '--merge-output-format', 'mp4',
                    '-o', output]
            print(f"[DOWNLOAD] 下载片段: {start} - {end}")
        else:
            cmd += ['-f', quality, '--merge-output-format', 'mp4', '-o', output]
            print(f"[DOWNLOAD] 下载完整视频")

        # 同时下载字幕
        cmd += ['--write-subs', '--sub-langs', 'ai-zh']

    cmd.append(url)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if result.returncode != 0:
        print(f"[WARN] yt-dlp 返回码 {result.returncode}")
        if result.stderr:
            print(result.stderr[-1000:])

    # 检查输出文件
    if not subs_only:
        if not os.path.exists(output):
            # 尝试找实际输出文件
            possible = [output, f"{output}.mp4", f"{output}.mkv"]
            for p in possible:
                if os.path.exists(p):
                    output = p
                    break
        if os.path.exists(output):
            size_mb = os.path.getsize(output) / 1024 / 1024
            print(f"[OK] 视频下载完成: {output} ({size_mb:.1f} MB)")
        else:
            print(f"[ERROR] 视频文件未找到: {output}")

    # 字幕文件
    srt_files = list(Path(os.path.dirname(base)).glob(f'{os.path.basename(base)}*.srt'))
    if srt_files:
        print(f"[OK] 字幕下载完成: {srt_files[0]}")

    return output


def burn_subtitles(video_path, srt_path, output_path=None):
    """烧录字幕到视频（SRT + force_style，与切片标准一致）"""
    if output_path is None:
        base, ext = os.path.splitext(video_path)
        output_path = f"{base}_subbed{ext}"

    srt_escaped = srt_path.replace('\\', '/').replace(':', '\\:')
    vf = f"subtitles='{srt_escaped}':force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'"

    cmd = ['ffmpeg', '-i', video_path,
           '-vf', vf,
           '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
           '-c:a', 'copy',
           '-y', output_path]

    print(f"[FFMPEG] 烧录字幕...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0 and not os.path.exists(output_path):
        print(f"[ERROR] ffmpeg 失败:\n{result.stderr[-2000:]}")
        sys.exit(1)

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    print(f"[OK] 字幕烧录完成: {output_path} ({size_mb:.1f} MB)")
    return output_path


def main():
    parser = argparse.ArgumentParser(description='B站视频下载 + 字幕工具')
    parser.add_argument('--url', required=True, help='B站视频 URL')
    parser.add_argument('--start', default=None, help='开始时间 HH:MM:SS')
    parser.add_argument('--end', default=None, help='结束时间 HH:MM:SS')
    parser.add_argument('--output', '-o', default=None, help='输出文件路径')
    parser.add_argument('--subs-only', action='store_true', help='只下载字幕')
    parser.add_argument('--quality', default='30064+30280',
                        help='视频质量 (30064=720p, 30080=1080p, 30032=480p)')
    parser.add_argument('--burn-subs', action='store_true', help='下载后烧录字幕到视频')
    parser.add_argument('--trim-srt', action='store_true',
                        help='裁剪字幕到指定时间段并重置时间轴')
    args = parser.parse_args()

    # 计算时间秒数
    start_sec = parse_srt_time(args.start) if args.start else None
    end_sec = parse_srt_time(args.end) if args.end else None

    output = args.output or os.path.join(os.getcwd(), 'bilibili_clip.mp4')

    # 下载
    video_path = download_clip(
        args.url, args.start, args.end, output,
        subs_only=args.subs_only, quality=args.quality
    )

    base = os.path.splitext(output)[0]

    # 裁剪字幕（如果指定了时间段）
    if args.trim_srt and start_sec is not None and end_sec is not None:
        full_srt = f"{base}.ai-zh.srt"
        if os.path.exists(full_srt):
            trimmed_srt = f"{base}_trimmed.srt"
            trim_srt(full_srt, start_sec, end_sec, trimmed_srt)
            # 用裁剪后的字幕替换
            if not args.subs_only:
                srt_for_burn = trimmed_srt
        else:
            print(f"[WARN] 找不到字幕文件: {full_srt}")
            srt_for_burn = full_srt
    else:
        srt_for_burn = f"{base}.ai-zh.srt"

    # 烧录字幕
    if args.burn_subs and not args.subs_only and os.path.exists(srt_for_burn):
        burn_subtitles(video_path, srt_for_burn)

    print("\n✅ 完成!")


if __name__ == '__main__':
    main()
