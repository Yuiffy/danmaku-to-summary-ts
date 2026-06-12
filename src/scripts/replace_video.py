"""
B站视频替换脚本 - 替换已有稿件的视频文件（保留标题、描述、tag等）

用法:
    python replace_video.py --bvid BV1xxxx --video <新视频路径>

流程:
    1. 用 VideoEditor._fetch_configs 获取原稿件信息（投稿管理接口）
    2. 用 VideoUploader 完整上传新视频文件（拿到 filename）
    3. 用 VideoEditor 提交编辑，替换视频，保留其他信息不变
"""
import sys
import os
import asyncio
import json
import subprocess

sys.path.insert(0, os.path.join(os.path.dirname(__file__)))

from bilibili_upload import build_credential
from bilibili_api import video_uploader, video


async def replace_video(bvid: str, new_video_path: str):
    cred = build_credential()
    
    # 1. 用 VideoEditor._fetch_configs 获取原稿件信息
    print(f"[INFO] 获取原稿件信息: {bvid}")
    
    editor = video_uploader.VideoEditor(
        bvid=bvid,
        meta={
            "title": "", "copyright": 1, "tag": "",
            "desc_format_id": 0, "desc": "", "dynamic": "",
            "interactive": 0, "new_web_edit": 1, "act_reserve_create": 0,
            "handle_staff": False, "topic_grey": 1, "no_reprint": 0,
            "subtitles": {"lan": "", "open": 0}, "web_os": 2,
        },
        credential=cred,
    )
    
    await editor._fetch_configs()
    old_configs = editor._VideoEditor__old_configs
    
    old_archive = old_configs["archive"]
    old_title = old_archive["title"]
    old_desc = old_archive["desc"]
    old_tid = old_archive["tid"]
    old_tags = old_archive["tag"]
    old_cover = old_archive["cover"]
    old_videos = old_configs.get("videos", [])
    
    print(f"[INFO] 原标题: {old_title}")
    print(f"[INFO] 原描述: {old_desc[:80]}")
    print(f"[INFO] 原标签: {old_tags}")
    print(f"[INFO] 原视频数: {len(old_videos)}")
    
    # 2. 上传新视频文件（用完整的 VideoUploader 流程）
    print(f"\n[INFO] 上传新视频: {new_video_path}")
    size_mb = os.path.getsize(new_video_path) / (1024 * 1024)
    print(f"[INFO] 文件大小: {size_mb:.1f}MB")
    
    # Extract cover frame
    temp_cover = os.path.join(os.environ.get('TEMP', '/tmp'), 'replace_cover.jpg')
    subprocess.run([
        'ffmpeg', '-y', '-i', new_video_path,
        '-frames:v', '1', '-q:v', '2', temp_cover, '-loglevel', 'error'
    ], timeout=15, check=True)
    
    page = video_uploader.VideoUploaderPage(
        path=new_video_path,
        title=old_videos[0]["title"] if old_videos else old_title,
        description=old_videos[0]["desc"] if old_videos else old_desc,
    )
    
    meta = video_uploader.VideoMeta(
        tid=old_tid,
        title=old_title,
        desc=old_desc,
        cover=temp_cover,
        tags=old_tags.split(','),
        original=False,
        source="直播切片",
    )
    
    # Monkey-patch _submit on the uploader to capture filename instead of submitting new post
    uploaded_data = {}
    original_main = video_uploader.VideoUploader._main
    
    async def capture_main(self):
        videos = []
        for p in self.pages:
            data = await self._upload_page(p)
            videos.append(data)
            uploaded_data["filename"] = data["filename"]
            uploaded_data["cid"] = data["cid"]
        print(f"[INFO] 视频文件上传完成!")
        print(f"[INFO] filename: {uploaded_data['filename']}")
        print(f"[INFO] cid: {uploaded_data['cid']}")
        # Don't actually submit - we just wanted to upload
        return {"bvid": "UPLOAD_ONLY", "videos": videos}
    
    video_uploader.VideoUploader._main = capture_main
    
    uploader = video_uploader.VideoUploader(
        pages=[page],
        meta=meta,
        credential=cred,
    )
    
    print("[INFO] 开始上传视频文件...")
    await uploader.start()
    
    # Restore original
    video_uploader.VideoUploader._main = original_main
    
    new_filename = uploaded_data["filename"]
    new_cid = uploaded_data["cid"]
    
    # 3. 提交编辑，替换视频
    print(f"\n[INFO] 提交替换稿件...")
    
    # Build videos list: replace first video with new file
    videos = [{
        "title": old_videos[0]["title"] if old_videos else old_title,
        "desc": old_videos[0]["desc"] if old_videos else old_desc,
        "filename": new_filename,
        "cid": new_cid,
    }]
    
    # Keep remaining videos unchanged (multi-P)
    for i, old_v in enumerate(old_videos[1:], 1):
        try:
            cid = await video.Video(bvid=bvid, credential=cred).get_cid(i)
        except Exception:
            cid = old_v.get("cid", 0)
        videos.append({
            "title": old_v["title"],
            "desc": old_v["desc"],
            "filename": old_v["filename"],
            "cid": cid,
        })
    
    editor.meta.update({
        "title": old_title,
        "tag": old_tags,
        "desc": old_desc,
        "copyright": old_archive.get("copyright", 1),
        "videos": videos,
        "cover": old_cover,
        "tid": old_tid,
    })
    
    # Override _main to skip re-fetching and just submit
    async def custom_main():
        await editor._submit()
        return {"bvid": bvid}
    
    editor._main = custom_main
    
    result = await editor.start()
    print(f"\n✅ 替换完成!")
    print(f"  BV号: {result['bvid']}")
    print(f"  链接: https://www.bilibili.com/video/{result['bvid']}")
    return result


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="替换B站稿件视频文件")
    parser.add_argument("--bvid", required=True, help="稿件BV号")
    parser.add_argument("--video", required=True, help="新视频文件路径")
    args = parser.parse_args()
    
    asyncio.run(replace_video(args.bvid, args.video))
