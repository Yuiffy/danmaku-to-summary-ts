#!/usr/bin/env python
"""
手动切片制作 + 上传一体化脚本（标准流程）

用法:
  python make_clip.py \
    --flv "D:\...\录制-xxx_merged.flv" \
    --srt "D:\...\录制-xxx_merged.srt" \
    --start 635 --end 686 \
    --title "【小岁】标题文字" \
    --cover-text "端午节\n买成月饼" \
    --cover-time 14 \
    --source-desc "岁己SUI 直播《摸鱼！空洞骑士~》2026-06-17" \
    --live-start "15:03:05" \
    [--upload]

流程（每一步都必须执行，不可跳过）:
  1. 裁剪 SRT + 重置时间轴 → 用 make_srt 逻辑
  2. ffmpeg 切片 + 烧录字幕（SRT + force_style，不用 ASS）
  3. 提取封面帧 + 用 cover_generator.py 压制大字标题
  4. 生成标准简介（含北京时间、直播开始后第X分钟）
  5. 上传到 B站（--upload 时自动执行）

关键注意事项（每次都要检查）:
  - 字幕样式：SRT + force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'
  - 封面：必须用 cover_generator.py 压制巨大文字，不能只截裸帧
  - 简介：必须包含切片时间段（北京时间）和"直播开始后第X分钟"
  - 标题：【小岁】前缀，"岁己"替换为"小岁"
  - Tag：小岁, 虚拟主播, 直播切片, 岁AI切片
"""
import argparse, os, sys, subprocess, json, re, math
from datetime import datetime, timedelta
from pathlib import Path

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPTS_DIR)


def parse_srt_time(t):
    """SRT 时间戳 → 秒"""
    t = t.strip().replace(',', '.')
    h, m, s = t.split(':')
    return int(h) * 3600 + int(m) * 60 + float(s)


def fmt_srt_time(sec):
    """秒 → SRT 时间戳"""
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec % 60)
    ms = int(round((sec - int(sec)) * 1000))
    if ms == 1000:
        ms = 0; s += 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def trim_srt(src_srt, start_sec, end_sec, out_path):
    """裁剪 SRT 并重置时间轴"""
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
        except:
            continue
        if e < start_sec or s > end_sec:
            continue
        ns = max(0, s - start_sec)
        ne = max(0, e - start_sec)
        text = '\n'.join(lines[2:])
        out_blocks.append(f"{idx}\n{fmt_srt_time(ns)} --> {fmt_srt_time(ne)}\n{text}")
        idx += 1
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(out_blocks) + '\n')
    print(f"[SRT] 裁剪完成: {len(out_blocks)} 条字幕 → {out_path}")
    return out_path


def cut_video(flv_path, start_sec, end_sec, srt_path, out_path):
    """ffmpeg 切片 + 烧录字幕"""
    duration = end_sec - start_sec
    start_ts = fmt_srt_time(start_sec).replace(',', '.')
    # 转义 Windows 路径反斜杠用于 subtitles 滤镜
    srt_escaped = srt_path.replace('\\', '/').replace(':', '\\:')
    vf = f"subtitles='{srt_escaped}':force_style='FontSize=28,FontName=Microsoft YaHei,Bold=1,Outline=2'"
    cmd = [
        'ffmpeg', '-ss', start_ts, '-i', flv_path,
        '-t', str(duration),
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '128k',
        '-y', out_path
    ]
    print(f"[FFMPEG] 切片 + 烧字幕...")
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        # ffmpeg 有时 exit code=1 但实际成功，检查输出文件
        if not os.path.exists(out_path) or os.path.getsize(out_path) < 10000:
            print(f"[ERROR] ffmpeg 失败:\n{result.stderr[-2000:]}")
            sys.exit(1)
    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"[VIDEO] 切片完成: {out_path} ({size_mb:.1f} MB)")
    return out_path


def generate_cover(clip_path, cover_text, cover_time, output_path, subtitle=None):
    """用 cover_generator.py 压制封面大字"""
    from cover_generator import CoverGenerator
    gen = CoverGenerator()
    # 先截帧
    frame_path = output_path.replace('.jpg', '_frame.jpg')
    frame_path = gen.extract_frame(clip_path, timestamp=cover_time, output_path=frame_path)
    # 压制文字
    final = gen.add_text_to_cover(
        image_path=frame_path,
        title=cover_text,
        subtitle=subtitle,
        output_path=output_path,
        text_position='center',
    )
    # 清理临时帧
    if os.path.exists(frame_path) and frame_path != final:
        try:
            os.remove(frame_path)
        except:
            pass
    print(f"[COVER] 封面生成: {output_path}")
    return output_path


def build_description(reason, source_desc, live_start, start_sec, end_sec):
    """
    生成标准简介，包含:
    - 切片内容一句话
    - 来源
    - 切片时间（北京时间 + 直播开始后第X分钟）
    """
    # 从 live_start "HH:MM:SS" 计算北京时间
    h, m, s = map(int, live_start.split(':'))
    base = datetime(2000, 1, 1, h, m, s)  # 日期不重要，只算时间
    clip_start = base + timedelta(seconds=start_sec)
    clip_end = base + timedelta(seconds=end_sec)
    start_min = start_sec / 60
    desc = f"""{reason}

来源：{source_desc}
切片时间：{clip_start.strftime('%H:%M:%S')} - {clip_end.strftime('%H:%M:%S')}（直播开始后第{int(start_sec//60)}分钟）
直播切片"""
    return desc


def upload_clip(video_path, cover_path, title, desc, tags, tid=21):
    """上传到 B站"""
    from bilibili_upload import build_credential
    from bilibili_api import video_uploader, Picture
    import asyncio

    async def _upload():
        cred = build_credential()
        cover = Picture.from_file(cover_path)
        page = video_uploader.VideoUploaderPage(path=video_path, title=title, description=desc)
        meta = video_uploader.VideoMeta(
            tid=tid, title=title, desc=desc, cover=cover,
            tags=tags, original=False, source='直播切片'
        )
        uploader = video_uploader.VideoUploader(pages=[page], meta=meta, credential=cred)
        result = await uploader.start()
        return result

    result = asyncio.run(_upload())
    if isinstance(result, dict) and result.get('bvid'):
        print(f"[UPLOAD] 成功! BV号: {result['bvid']}")
    else:
        print(f"[UPLOAD] 结果: {result}")
    return result


def main():
    parser = argparse.ArgumentParser(description='手动切片制作 + 上传')
    parser.add_argument('--flv', required=True, help='源 FLV/MP4 文件路径')
    parser.add_argument('--srt', required=True, help='源 SRT 字幕文件路径')
    parser.add_argument('--start', type=float, required=True, help='切片开始秒数')
    parser.add_argument('--end', type=float, required=True, help='切片结束秒数')
    parser.add_argument('--title', required=True, help='稿件标题（【小岁】前缀）')
    parser.add_argument('--cover-text', required=True, help='封面大字（可用 \\n 换行）')
    parser.add_argument('--cover-time', type=float, default=None, help='封面截帧时间（切片内秒数），默认取 20% 处')
    parser.add_argument('--cover-subtitle', default=None, help='封面副标题文字')
    parser.add_argument('--reason', default='直播切片', help='切片理由/简介第一行')
    parser.add_argument('--source-desc', required=True, help='来源描述，如：岁己SUI 直播《xxx》2026-06-17')
    parser.add_argument('--live-start', required=True, help='直播开始时间 HH:MM:SS（从文件名解析）')
    parser.add_argument('--out-dir', default=None, help='输出目录（默认与 FLV 同目录下的 own_stream_fun_clips/）')
    parser.add_argument('--upload', action='store_true', help='制作完成后自动上传')
    args = parser.parse_args()

    # 输出目录
    if args.out_dir:
        out_dir = Path(args.out_dir)
    else:
        flv_dir = Path(args.flv).parent
        out_dir = flv_dir / 'own_stream_fun_clips'
    out_dir.mkdir(parents=True, exist_ok=True)

    base_name = Path(args.flv).stem
    clip_path = out_dir / f'{base_name}_manual_clip.mp4'
    srt_path = out_dir / f'{base_name}_manual_clip.srt'
    cover_path = out_dir / f'cover_manual.jpg'

    # 1. 裁剪字幕
    print('\n=== Step 1: 裁剪字幕 ===')
    trim_srt(args.srt, args.start, args.end, str(srt_path))

    # 2. 切片 + 烧字幕
    print('\n=== Step 2: ffmpeg 切片 + 烧字幕 ===')
    cut_video(args.flv, args.start, args.end, str(srt_path), str(clip_path))

    # 3. 生成封面（大字压制）
    print('\n=== Step 3: 封面生成（大字压制）===')
    cover_time = args.cover_time
    if cover_time is None:
        # 默认取切片 20% 处
        duration = args.end - args.start
        cover_time = duration * 0.2
    cover_text = args.cover_text.replace('\\n', '\n')
    generate_cover(str(clip_path), cover_text, cover_time, str(cover_path), subtitle=args.cover_subtitle)

    # 4. 生成简介
    print('\n=== Step 4: 生成简介 ===')
    desc = build_description(args.reason, args.source_desc, args.live_start, args.start, args.end)
    print(f"[DESC]\n{desc}")

    # 标题处理
    title = args.title.replace('岁己', '小岁')
    if not title.startswith('【小岁】'):
        title = '【小岁】' + title

    tags = ['小岁', '虚拟主播', '直播切片', '岁AI切片']

    # 5. 上传
    if args.upload:
        print('\n=== Step 5: 上传到 B站 ===')
        result = upload_clip(str(clip_path), str(cover_path), title, desc, tags)
        # 保存结果
        result_path = out_dir / 'upload_results_manual.json'
        with open(result_path, 'w', encoding='utf-8') as f:
            json.dump([{'title': title, 'result': result}], f, ensure_ascii=False, indent=2)
        print(f"[SAVED] {result_path}")
    else:
        print('\n=== 跳过上传（加 --upload 自动上传）===')

    print(f'\n✅ 完成!')
    print(f'   视频: {clip_path}')
    print(f'   封面: {cover_path}')
    print(f'   标题: {title}')


if __name__ == '__main__':
    main()
