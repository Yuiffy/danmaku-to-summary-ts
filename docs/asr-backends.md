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
      "max_vad_segment_s": 8,
      "merge_length_s": 8,
      "enable_speaker": false,
      "preset_spk_num": null,
      "speaker_merge_threshold": 0.78
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

## 热词与错识别修正

ASR 配置支持全局热词、按 routing 命中的房间/主播热词，以及统一的后处理 corrections。

- `aliases`: 旧格式兼容，作为 safe corrections，全局替换。
- `contextual_aliases`: 只生成 contextual corrections，文本中命中 `require_nearby` 任一关键词时才替换，避免把“随机匹配”误改成“岁己匹配”。
- `corrections.safe`: 显式安全替换，等价于旧的 corrections 对象/数组。
- `corrections.contextual`: 显式上下文替换，必须配置 `require_nearby`，否则不会执行。

```json
{
  "asr": {
    "common_hotwords": [
      {
        "word": "东爱璃Lovely",
        "weight": 20,
        "aliases": ["东爱璃", "Lovely", "爱璃", "东爱丽", "爱丽", "东艾璃", "东艾丽"]
      },
      {
        "word": "星汐Seki",
        "weight": 20,
        "aliases": ["星汐", "Seki", "seki", "星夕", "星西", "星希"]
      },
      {
        "word": "礼墨Sumi",
        "weight": 20,
        "aliases": ["礼墨", "Sumi", "sumi", "里墨", "礼沫", "李墨"]
      },
      {
        "word": "笙歌",
        "weight": 20,
        "aliases": ["帅比笙歌超可爱OvO", "笙歌OvO", "shengge", "生哥", "声歌", "升哥"]
      },
      {
        "word": "伊索尔Sol",
        "weight": 20,
        "aliases": ["伊索尔", "Sol", "sol", "索尔", "伊索", "一索尔"]
      },
      {
        "word": "南町Nightin",
        "weight": 20,
        "aliases": ["南町", "Nightin", "nightin", "南丁", "南町Night in", "南町奈汀"]
      },
      {
        "word": "MIXUP2026",
        "weight": 18,
        "aliases": ["MIXUP", "mixup", "mix up", "Mixup2026", "MIXUP 2026"]
      },
      {
        "word": "PSP",
        "weight": 18,
        "aliases": ["P S P", "psp"]
      },
      {
        "word": "VirtuaReal",
        "weight": 18,
        "aliases": ["VR", "V R", "虚拟Real", "维阿", "微阿"]
      },
      {
        "word": "岁己SUI",
        "weight": 20,
        "aliases": ["岁己", "岁几", "碎己", "岁已"],
        "contextual_aliases": ["随机", "随即"]
      },
      {
        "word": "栞栞",
        "weight": 20,
        "aliases": ["签签", "千千", "浅浅", "栞", "Shiori"]
      },
      {
        "word": "米汀",
        "weight": 18,
        "aliases": ["Miting", "米丁", "米婷"]
      },
      {
        "word": "瑞娅",
        "weight": 18,
        "aliases": ["Rhea", "瑞亚", "蕊娅"]
      },
      {
        "word": "时守星沙",
        "weight": 18,
        "aliases": ["星沙", "时守", "时守星砂", "星砂"]
      }
    ],
    "corrections": {
      "safe": {
        "岁几": "岁己",
        "碎己": "岁己"
      },
      "contextual": [
        {
          "from": "随机",
          "to": "岁己",
          "require_nearby": ["主播", "直播", "开播", "SUI", "岁己", "饼干岁", "VR", "VirtuaReal"]
        }
      ]
    },
    "routing": [
      {
        "match": {
          "room_id": "21692711"
        },
        "backend": "sensevoice",
        "hotwords": [
          {
            "word": "东爱璃Lovely",
            "weight": 20
          }
        ]
      },
      {
        "match": {
          "room_id": "1603600"
        },
        "backend": "sensevoice",
        "hotwords": [
          {
            "word": "星汐Seki",
            "weight": 20
          }
        ]
      },
      {
        "match": {
          "room_id": "23222837"
        },
        "backend": "sensevoice",
        "hotwords": [
          {
            "word": "礼墨Sumi",
            "weight": 20
          }
        ]
      },
      {
        "match": {
          "room_id": "573893"
        },
        "backend": "sensevoice",
        "hotwords": [
          {
            "word": "笙歌",
            "weight": 20
          }
        ]
      },
      {
        "match": {
          "room_id": "25971921"
        },
        "backend": "sensevoice",
        "hotwords": [
          {
            "word": "伊索尔Sol",
            "weight": 20
          }
        ]
      },
      {
        "match": {
          "room_id": "24872476"
        },
        "backend": "sensevoice",
        "hotwords": [
          {
            "word": "南町Nightin",
            "weight": 20
          }
        ]
      }
    ]
  }
}
```

FunASR/SenseVoice 调用会优先把带权重热词传给 `model.generate`，格式类似：

```text
岁己SUI 20
VirtuaReal 18
PSP 18
```

如果当前 FunASR/SenseVoice 版本不支持 weighted hotword，会 warning 并降级为无权重 hotword；再失败才降级为无 hotword。Whisper 不传热词，但所有 backend 的 SRT 写出前都会应用 corrections。

`punc_model` 是 best-effort：配置后会尝试加载 FunASR 标点模型并对 SenseVoice 输出文本恢复标点；加载或调用失败只会写 warning 到 stderr，不会中断 ASR。不同 FunASR/SenseVoice 版本对标点模型返回结构支持不完全一致，需要用真实音频验证。

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

SenseVoice 时间轴优先使用 FunASR 返回的 `sentence_info` / `segments` 中的 `start` / `end`；如果当前模型只返回整段文本，则退回到 VAD chunk 级近似时间。默认 `merge_length_s=8`、`max_vad_segment_s=8`，避免把 VAD chunk 合并到过长。SenseVoice 首版时间轴不一定比 Whisper 的 `word_timestamps` 更细，建议用 Compare 模式实测。

## 说话人分离

说话人分离默认关闭，不影响普通 SenseVoice + VAD + 标点流程：

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
      "spk_model": "cam++",
      "preset_spk_num": null,
      "speaker_merge_threshold": 0.78
    }
  }
}
```

当前实现使用 SenseVoice 手动 VAD 分段转写，再用 FunASR CAM++ 对同一批 VAD 段提取说话人 embedding 并聚类。输出会进入统一 `AsrResult`，最终 SRT 文本前缀为：

```text
[SPEAKER_00] 大家晚上好
```

参数说明：

- `spk_model`: 建议先用 `"cam++"`。首次启用会下载 `iic/speech_campplus_sv_zh-cn_16k-common`。
- `preset_spk_num`: 已知人数时可填数字，例如 `2` 或 `3`，用于减少自动聚类过分裂；不确定时保持 `null`。
- `speaker_merge_threshold`: CAM++ 聚类合并阈值，默认 `0.78`。如果同一个人被拆成多个 `SPEAKER_xx`，可尝试调高或直接设置 `preset_spk_num`；如果不同人被合并，可尝试调低。

这只是“按 VAD 语音段聚类”的第一版，不做逐词级别换人切分。多人同时说话、背景音、变声、距离麦克风差异大时可能会过分裂或合并，需要用小样本调参。FunASR 可能需要额外模型下载。未配置 `spk_model` 时脚本会明确报错。

## 常见问题

- `funasr 未安装`: 在运行脚本的 Python 环境中安装 `funasr modelscope torch torchaudio`。
- `CUDA 不可用`: 将 `asr.sensevoice.device` 改为 `cpu`，或修复 PyTorch CUDA 安装。
- `模型加载失败`: 检查模型名、网络、ModelScope 缓存目录和磁盘空间。
- `输入音频不存在`: 确认传入路径存在，路径包含中文时建议使用 UTF-8 Python 环境。
