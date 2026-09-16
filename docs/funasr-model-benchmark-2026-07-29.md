# FunASR 1.3.30 三模型直播 ASR 基准

## 结论

在这段栞栞直播样本上：

- **速度优先**：Paraformer。冷进程处理速度 28.41x，且提供字符级时间戳。
- **文本准确率优先**：Fun-ASR-Nano。没有人工真值，不能计算 WER/CER；从分歧窗口人工抽查，Nano 的中文口语最连贯，明显错词和跨语言幻觉较少。
- **需要情感/声音事件**：SenseVoiceSmall。速度为 20.94x，输出 HAPPY、ANGRY、NEUTRAL、SURPRISE，以及 BGM、Speech、Laughter、Sneeze 等事件。

Nano 的代价是速度最慢：冷进程 6.79x；模型加载 42.34 秒，15 分钟音频推理 75.62 秒。Paraformer 最适合高吞吐并且需要细时间轴的生产流程。SenseVoiceSmall 适合把情感作为辅助元数据，但本样本中 HAPPY/ANGRY 占比很高，不应把标签当作精确的人类情绪标注。

## 测试条件

- FunASR：1.3.30（升级前为 1.3.7）
- Python：3.12.4
- PyTorch：2.11.0+cu128
- GPU：NVIDIA GeForce RTX 5080 16 GB，驱动 610.74
- CPU：Intel Core i5-13600K
- 内存：63.8 GB
- 系统：Windows 11
- 模型缓存已在 30 秒冒烟测试中预热；每个正式模型仍在独立 Python 进程中冷加载
- 关闭说话人分离和 GPU throttle，三个模型串行运行，避免资源竞争

样本来自：

`tmp/shiori_paraformer_rerun/录制-26966466-20260604-201307-648-海獭大战小鸟！_merged.m4a`

选取直播第 180:00–195:00，时长恰好 900 秒，转为 16 kHz、单声道、PCM WAV。旧字幕在该窗口约有 655 秒语音和 2676 个汉字，避免了大段静音样本。

## 速度结果

| 模型 | 冷进程总耗时 | RTF | 冷进程速度 | 模型加载 | 核心处理 | 输出段数 | 字符数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Paraformer | 31.681 s | 0.03520 | 28.408x | 17.010 s | 5.215 s | 210 | 2630 |
| SenseVoiceSmall | 42.990 s | 0.04777 | 20.935x | 1.722 s | 18.064 s | 146 | 2732 |
| Fun-ASR-Nano-2512 | 132.537 s | 0.14726 | 6.791x | 42.342 s | 80.411 s | 135 | 2810 |

“冷进程总耗时”包含 Python/FunASR 导入、模型构建、模型加载和输出序列化，是一次独立命令的实际等待时间。“核心处理”对 Paraformer 使用完整 pipeline 时间；另外两个模型使用 VAD + ASR 推理时间。因此热常驻服务的延迟会显著低于冷进程总耗时。

按核心处理时间计算，Paraformer 约 172.58x，SenseVoiceSmall 约 49.82x，Nano 约 11.19x。Windows 的 `nvidia-smi` 未返回逐进程显存，所以峰值显存没有可靠数据。

## 准确率与人工抽查

没有人工真值字幕，不能给出 WER/CER。去除空白和标点后的整段字符一致度如下，它只表示模型间相似，不表示准确率：

| 模型对 | 字符一致度 |
| --- | ---: |
| SenseVoiceSmall / Fun-ASR-Nano | 0.8445 |
| Paraformer / SenseVoiceSmall | 0.7796 |
| Paraformer / Fun-ASR-Nano | 0.7676 |

抽查结论：

- Nano 的句子通常最完整、口语逻辑最连贯。例如 04:00–04:30 能识别“切片”“有才无德”“赛季快结束了再绝杀”等上下文。
- SenseVoiceSmall 与 Nano 整体最接近，但在 04:30–05:00、06:00–06:30 出现日语/韩语片段和错词。
- Paraformer 的主要优势是速度和时间戳；专名、游戏语境和快速口语错词更多，偶有漏词。
- 三者都不能可靠识别“岁己/栞栞”等专名，生产使用仍需要热词或后处理纠错。

建议优先人工复核这些分歧最大的 30 秒窗口：

1. 04:30–05:00
2. 04:00–04:30
3. 06:00–06:30
4. 01:30–02:00

`review.tsv` 已按 30 秒并排三个模型的文本，SenseVoice 文本前包含情感标签。配合同目录的 15 分钟 WAV 和三份 SRT 可以直接听写检查。

## SenseVoice 情感

146 个 VAD 文本段中，114 个有明确情感：

| 情感 | 段数 |
| --- | ---: |
| HAPPY | 64 |
| ANGRY | 44 |
| NEUTRAL | 3 |
| SURPRISE | 3 |

`EMO_UNKNOWN` 被视为没有情感结论，不计入事件。声音事件包括 BGM 83 段、Speech 58 段、Laughter 4 段、Sneeze 1 段；同一段可以有多个事件。

## 1.3.30 时间戳回归

升级后发现 Paraformer 的完整 `text` 和字符级 `timestamp` 正常，但 `sentence_info[i].text` 与其 timestamps 数量不一致。长音频会逐渐发生文字时间提前，最后约一分钟只剩标点。

当前实现优先使用完整文本和字符时间戳重建字幕：

- 中文等非 ASCII 文本逐字对齐。
- 连续英文/数字词按一个 token 对齐。
- 只有文本 token 数和 timestamp 数完全相等才启用。
- 不能可靠对齐时回退原 `sentence_info` 路径。

修复后，按 30 秒窗口计算的三模型平均一致度从 0.317 提升到 0.654，末尾不再出现纯标点片段。

## 产物

正式结果目录：

`tmp/funasr-model-benchmark-20260729/final-15min`

主要文件：

- `summary.json`：机器可读速度、模型和情感统计
- `review.tsv`：每 30 秒三模型并排文本
- `paraformer.srt`
- `sensevoice.srt`
- `fun_asr_nano.srt`
- `sensevoice.emotions.json`
- `*.result.json`、`*.payload.json`、`*.log.txt`
- 上级目录的 `shiori_180m_195m_16k_mono.wav`：人工检查音频

复跑命令：

```powershell
python scripts\benchmark_funasr_models.py `
  --input tmp\funasr-model-benchmark-20260729\shiori_180m_195m_16k_mono.wav `
  --output-dir tmp\funasr-model-benchmark-20260729\another-run
```
