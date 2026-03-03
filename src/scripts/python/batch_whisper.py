import sys
import os
import io

# 禁用输出缓冲，确保日志实时输出到Node.js
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', line_buffering=True)

import time
import shutil
import traceback
import gc
import subprocess
from faster_whisper import WhisperModel, BatchedInferencePipeline

# ================= ❄️ RTX 5080 终极智能降级版 ❄️ =================
# 模型路径
MODEL_SIZE = "deepdml/faster-whisper-large-v3-turbo-ct2"

# 基础并发数 (Batch模式用)
BATCH_SIZE = 12

# 【功能开关】是否开启长句智能切分
ENABLE_SMART_SPLIT = True
MAX_CHARS_PER_LINE = 18

# 容错阈值：如果生成的时长比视频短了超过 60秒，触发降级
TOLERANCE_SECONDS = 60
MAX_RETRIES = 3

VIDEO_EXTS = {'.mp4', '.flv', '.mkv', '.avi', '.mov', '.webm', '.ts', '.m4v', '.m4a'}


def get_duration_fast(file_path):
    """
    使用 ffprobe 瞬间读取视频时长，无需解码音频。
    """
    try:
        command = [
            'ffprobe',
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            file_path
        ]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return float(result.stdout.strip())
    except Exception as e:
        print(f"   ⚠️ ffprobe 读取失败，回退到慢速模式: {e}")
        return None


# ===========================================================

def is_video_file(filename):
    return os.path.splitext(filename)[1].lower() in VIDEO_EXTS


def format_timestamp(seconds):
    if seconds is None: return "00:00:00,000"
    ms = int((seconds % 1) * 1000)
    seconds = int(seconds)
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# --- ✂️ 智能切分算法 ✂️ ---
def smart_split_segment(segment, max_chars=18):
    if len(segment.text) <= max_chars or not segment.words:
        yield {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
        return

    current_words = []
    current_len = 0
    segment_start = segment.words[0].start

    for word in segment.words:
        word_text = word.word
        word_len = len(word_text)
        if current_len + word_len > max_chars and current_words:
            yield {"start": segment_start, "end": current_words[-1].end,
                   "text": "".join([w.word for w in current_words]).strip()}
            current_words = []
            current_len = 0
            segment_start = word.start
        current_words.append(word)
        current_len += word_len

    if current_words:
        yield {"start": segment_start, "end": current_words[-1].end,
               "text": "".join([w.word for w in current_words]).strip()}


def transcribe_with_strategy(model, video_path, srt_path, total_duration):
    """
    三级火箭策略：
    1. Batch模式: 极速，但 ASMR 容易丢包
    2. Sequential模式: 稍慢，但极度稳定，死磕到底
    3. 核弹模式: 关闭 VAD，强行转写每一秒
    """
    prompt = "饼干岁你们在吗岁己要急哭了"

    # 临时文件，防止写坏正式文件
    temp_srt = srt_path + ".tmp"

    for attempt in range(1, MAX_RETRIES + 1):
        # --- 策略选择 ---
        use_batch = True
        use_vad = True
        strategy_name = "🚀 [策略1] 极速 Batch 模式"

        if attempt == 2:
            use_batch = False
            strategy_name = "🐢 [策略2] 稳健 Sequential 模式 (ASMR专用)"
        elif attempt == 3:
            use_batch = False
            use_vad = False
            strategy_name = "☢️ [策略3] 核弹模式 (关闭VAD，强制全写)"

        print(f"\n👉 第 {attempt} 次尝试: 启用 {strategy_name}...")

        # 日常杂谈/游戏推荐参数
        vad_params = {
            "min_silence_duration_ms": 700,  # 改成 700 或 1000：停顿 0.7秒 到 1秒 就自然切断
            "speech_pad_ms": 400,            # 语音前后的缓冲也可以改小一点，字幕出现更精准
            "threshold": 0.3
        }

        start_time = time.time()
        last_segment_end = 0
        line_count = 0

        try:
            segments = None
            batched_model = None

            if use_batch:
                # 策略1：Batch Pipeline
                batched_model = BatchedInferencePipeline(model=model)
                segments, _ = batched_model.transcribe(
                    video_path,
                    batch_size=BATCH_SIZE,
                    language="zh",
                    initial_prompt=prompt,
                    vad_filter=True,
                    vad_parameters=vad_params,
                    word_timestamps=True
                )
            else:
                # 策略2 & 3：原生串行模式 (不经过 Pipeline)
                segments, _ = model.transcribe(
                    video_path,
                    beam_size=5,
                    language="zh",
                    initial_prompt=prompt,
                    vad_filter=use_vad,
                    vad_parameters=vad_params if use_vad else None,
                    word_timestamps=True,
                    condition_on_previous_text=False
                )

            # 进度条
            term_width = shutil.get_terminal_size().columns
            bar_width = max(20, term_width - 65)

            with open(temp_srt, "w", encoding="utf-8") as f:
                for raw_segment in segments:
                    last_segment_end = raw_segment.end

                    # 切分逻辑
                    if ENABLE_SMART_SPLIT:
                        sub_segments = smart_split_segment(raw_segment, MAX_CHARS_PER_LINE)
                    else:
                        sub_segments = [{
                            "start": raw_segment.start, "end": raw_segment.end, "text": raw_segment.text.strip()
                        }]

                    for split_seg in sub_segments:
                        line_count += 1

                        percent = (last_segment_end / total_duration) * 100
                        if percent > 100: percent = 100
                        elapsed = time.time() - start_time
                        speed = last_segment_end / elapsed if elapsed > 0 else 0
                        eta = (total_duration - last_segment_end) / speed if speed > 0 else 0

                        filled = int(bar_width * percent / 100)
                        bar = '█' * filled + '-' * (bar_width - filled)

                        icon = "⚡" if use_batch else "🐢"
                        sys.stdout.write(f"\r   {icon} {percent:5.1f}% [{bar}] ETA:{int(eta)}s | {speed:.1f}x")
                        sys.stdout.flush()

                        start_s = format_timestamp(split_seg['start'])
                        end_s = format_timestamp(split_seg['end'])
                        text = split_seg['text']
                        
                        # --- 🎯 幻听过滤 (Hallucination Filter) ---
                        if any(bad in text for bad in ["优优独播剧场", "字幕志愿者", "中文字幕志愿者", "感谢观看", "谢谢观看", "谢谢大家观看"]):
                            continue
                            
                        f.write(f"{line_count}\n{start_s} --> {end_s}\n{text}\n\n")

                    f.flush()

            print()

            # === 🛡️ 完整性检查 ===
            missing = total_duration - last_segment_end

            # 如果缺失不到10%的话允许放过，否则检查缺失严重且视频不短
            if missing / total_duration >= 0.1 and missing > TOLERANCE_SECONDS and total_duration > 120:
                print(f"   ⚠️  警告: 缺失 {missing:.1f} 秒 (总长 {format_timestamp(total_duration)})")

                if attempt < MAX_RETRIES:
                    print(f"   🚫 当前策略不适合此视频 (ASMR音量过低)，准备切换策略重试...")
                    time.sleep(2)
                    continue  # 触发下一次循环(换策略)
                else:
                    print(f"   💀 所有策略耗尽，保留现有结果。")

            # 成功：移动临时文件到目标路径
            if os.path.exists(srt_path): os.remove(srt_path)
            os.rename(temp_srt, srt_path)
            print(f"   ✅ 成功生成！耗时: {time.time() - start_time:.1f}s")

            # 清理内存
            if batched_model: del batched_model
            gc.collect()
            return

        except Exception as e:
            print(f"\n   ❌ 出错: {e}")
            traceback.print_exc()
            time.sleep(2)


def process_one_video(model, video_path, file_idx, total_files):
    filename = os.path.basename(video_path)
    output_dir = os.path.dirname(video_path)
    filename_no_ext = os.path.splitext(filename)[0]
    srt_path = os.path.join(output_dir, filename_no_ext + ".srt")

    # --- 智能防覆盖逻辑 (你要求的) ---
    counter = 1
    original_srt_path = srt_path
    while os.path.exists(srt_path):
        # 如果文件存在但很小(可能是失败的产物)，直接覆盖；否则重命名
        if os.path.getsize(srt_path) < 100:
            break
        new_filename = f"{filename_no_ext}_{counter}.srt"
        srt_path = os.path.join(output_dir, new_filename)
        counter += 1

    if counter > 1:
        print(f"✨ 自动重命名为: {os.path.basename(srt_path)}")
    # ------------------

    print(f"\n🎬 [{file_idx}/{total_files}] 正在处理: {filename}")

    try:
        # 获取时长 (不使用 pipeline，使用原生 model 快速探测)
        print("   🔍 分析视频时长...", end="", flush=True)
        total_duration = get_duration_fast(video_path)

        # 如果快速读取失败（比如文件损坏），再用原来的慢速方法兜底
        if total_duration is None:
            _, info = model.transcribe(video_path, beam_size=1, temperature=0, no_speech_threshold=1.0, condition_on_previous_text=False)
            total_duration = info.duration

        print(f" -> {format_timestamp(total_duration)}")

        # 核心逻辑
        transcribe_with_strategy(model, video_path, srt_path, total_duration)

    except Exception as e:
        print(f"\n   ❌ 预处理失败: {e}")


def main():
    os.system('cls' if os.name == 'nt' else 'clear')
    if len(sys.argv) < 2:
        print("❌ 请拖拽文件！")
        return

    input_path = sys.argv[1]
    todo_list = []
    if os.path.isfile(input_path):
        if is_video_file(input_path): todo_list.append(input_path)
    else:
        for root, dirs, files in os.walk(input_path):
            for file in files:
                if is_video_file(file): todo_list.append(os.path.join(root, file))

    print(f"🔥 正在加载 RTX 5080 引擎 (ASMR 智能版)...")
    
    # 检查显存状态
    try:
        check_script = os.path.join(os.path.dirname(__file__), 'check_gpu_memory.py')
        if os.path.exists(check_script):
            print("🔍 检查GPU显存状态...")
            result = subprocess.run(
                ['python', check_script],
                capture_output=True,
                text=True,
                timeout=10
            )
            
            if result.returncode != 0:
                print("⚠️  显存不足,等待显存释放...")
                print("💡 提示: 如果您正在玩游戏或使用显存,请稍等或关闭相关程序")
                
                # 等待显存释放(最多30分钟)
                wait_result = subprocess.run(
                    ['python', check_script, '--wait', '1800'],
                    timeout=1900  # 比等待时间多100秒
                )
                
                if wait_result.returncode != 0:
                    print("\n❌ 显存等待超时,无法继续处理")
                    print("   建议: 关闭占用显存的程序后重试")
                    return
        else:
            print("⚠️  显存检测脚本未找到,跳过显存检查")
    except subprocess.TimeoutExpired:
        print("⚠️  显存检测超时,继续尝试加载模型...")
    except Exception as e:
        print(f"⚠️  显存检测出错: {e},继续尝试加载模型...")
    
    try:
        # 优先尝试GPU，如果失败则用CPU
        model = WhisperModel(MODEL_SIZE, device="cuda", compute_type="float16")
        print("   ✅ 使用GPU加速 (CUDA)")
    except Exception as e:
        print(f"   ⚠️ GPU不可用，回退到CPU: {e}")
        model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="float32")
        print("   ✅ 使用CPU模式")

    for idx, video_path in enumerate(todo_list, start=1):
        process_one_video(model, video_path, idx, len(todo_list))
        gc.collect()

    print(f"\n🏆 全部完成！")



if __name__ == "__main__":
    main()