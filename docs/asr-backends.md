# ASR Backend 配置

项目现在支持多 ASR backend。默认仍然使用原来的 Whisper 流程，可以按配置或命令行临时切换到 SenseVoice/FunASR。

## 继续使用 Whisper

默认配置：

```json
{
  "asr": {
    "default_backend": "whisper",
    "whisper": {
      "model": "deepdml/faster-whisper-large-v3-turbo-ct2",
      "language": "zh"
    }
  }
}
```

命令行临时指定：

```bash
node src/scripts/enhanced_auto_summary.js --asr-backend whisper "D:/path/to/video.flv"
```

Whisper 仍然调用 `src/scripts/python/batch_whisper.py`，保留原有 GPU 等待、重试和 SRT 生成逻辑。主程序会把生成的 SRT 解析为统一 ASR 结果，再走统一字幕 normalize/write 流程。

## 安装 SenseVoice/FunASR

最小依赖：

```bash
pip install -r src/scripts/python/requirements-sensevoice.txt
```

RTX 5080 / Blackwell 需要支持 `sm_120` 的 PyTorch CUDA wheel。当前验证可用的是官方 `cu128`：

```bash
pip install --upgrade --force-reinstall torch==2.11.0+cu128 torchaudio==2.11.0+cu128 torchvision==0.26.0+cu128 --index-url https://download.pytorch.org/whl/cu128
pip install "numpy<2.4,>=2.2"
```

如果使用 CUDA，请确认当前 Python 环境里的 PyTorch 能识别 GPU：

```bash
python -c "import torch; print(torch.__version__, torch.version.cuda); print(torch.cuda.get_device_name(0)); print(torch.cuda.get_arch_list())"
```

RTX 5080 正常时，`get_arch_list()` 应包含 `sm_120`。

首次运行会下载模型，网络或 ModelScope 缓存异常会导致第一次失败。可以先用一小段音频测试。

## 启用 SenseVoice

```json
{
  "asr": {
    "default_backend": "sensevoice",
    "sensevoice": {
      "model": "iic/SenseVoiceSmall",
      "vad_model": "fsmn-vad",
      "punc_model": "ct-punc",
      "spk_model": null,
      "language": "auto",
      "device": "cuda",
      "use_itn": true,
      "enable_speaker": false
    }
  }
}
```

临时指定：

```bash
node src/scripts/enhanced_auto_summary.js --asr-backend sensevoice "D:/path/to/video.flv"
```

SenseVoice 通过 `src/scripts/python/sensevoice_transcribe.py` 子进程运行，主程序通过 JSON stdin/stdout 通信。

## 按主播或房间灰度

```json
{
  "asr": {
    "default_backend": "whisper",
    "routing": [
      {
        "match": { "room_id": "23222837" },
        "backend": "sensevoice"
      },
      {
        "match": { "streamer_name": "岁己SUI" },
        "backend": "sensevoice"
      }
    ]
  }
}
```

优先级：

```text
--asr-backend > asr.routing > asr.default_backend
```

日志会打印本次选择的 backend 和原因。backend 名称写错或 routing 配置不完整时会直接报错，不会静默 fallback。

## Compare 模式

同一段媒体同时跑多个 backend：

```bash
node src/scripts/enhanced_auto_summary.js --asr-compare whisper,sensevoice "D:/path/to/video.flv"
```

输出示例：

```text
video.whisper.srt
video.sensevoice.srt
video.compare.json
```

`compare.json` 包含每个 backend 的 SRT 路径和字幕段数，便于人工 A/B 对比。

## 字幕后处理

统一字幕配置：

```json
{
  "subtitle": {
    "max_chars_per_line": 18,
    "max_chars_per_segment": 30,
    "min_duration": 0.7,
    "max_duration": 5.5,
    "gap_split_threshold": 0.45,
    "merge_short_segments": true,
    "avoid_overlap": true,
    "strip_punctuation": true
  }
}
```

当前第一版已统一做 segment 清洗、长句切分、避免重叠和 SRT 写回。`strip_punctuation=true` 时只在 SRT 输出阶段去掉常见中英文标点，ASR 原始结果和内部切分仍保留标点信息。`gap_split_threshold` 与 `merge_short_segments` 已预留，后续可以继续增强合并策略。

## 说话人分离

说话人分离默认关闭：

```json
{
  "asr": {
    "sensevoice": {
      "enable_speaker": false,
      "spk_model": null
    }
  }
}
```

如果要尝试：

```json
{
  "asr": {
    "sensevoice": {
      "enable_speaker": true,
      "spk_model": "cam++"
    }
  }
}
```

FunASR 可能需要额外模型下载。未配置 `spk_model` 时脚本会明确报错。

## 常见问题

- `funasr 未安装`: 在运行脚本的 Python 环境中安装 `funasr modelscope torch torchaudio`。
- `CUDA 不可用`: 将 `asr.sensevoice.device` 改为 `cpu`，或修复 PyTorch CUDA 安装。
- `模型加载失败`: 检查模型名、网络、ModelScope 缓存目录和磁盘空间。
- `输入音频不存在`: 确认传入路径存在，路径包含中文时建议使用 UTF-8 Python 环境。
