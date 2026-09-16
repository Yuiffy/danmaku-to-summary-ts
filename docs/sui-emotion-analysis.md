# 岁己直播情感识别

## 方案

生产流程保留 `FSMN-VAD + Paraformer + CT-Punc` 作为主 ASR。Paraformer 完成后，在同一个 Python 进程内追加一次 `SenseVoiceSmall` 情感分析：

1. 复用 Paraformer 已生成的语音时间轴，不再运行第二次 VAD。
2. 把相邻字幕合并成约 12 秒音频块。
3. 从已经加载的 16 kHz 单声道音频中切片，按总时长批量送入 SenseVoiceSmall。
4. 只读取情感和声音事件标签，不使用 SenseVoice 文本替换 Paraformer 字幕。
5. 常驻 Paraformer worker 同时缓存 SenseVoiceSmall，后续任务不重复加载模型。
6. 情感分析失败时记录 `status=failed`，继续保留 Paraformer 字幕和后续流程。

SenseVoiceSmall 没有官方 vLLM 推理路径。这种无重复 VAD、无重复标点、批量短块推理的方式，比另起完整 SenseVoice ASR 流水线更省时间和显存。

## 启用范围

`config/default.json` 默认关闭。`config/production.json` 仅为岁己房间启用：

```json
{
  "asr": {
    "paraformer": {
      "emotion_analysis": {
        "enabled": true,
        "room_ids": ["25788785"],
        "model": "iic/SenseVoiceSmall",
        "device": "cuda",
        "chunk_s": 12,
        "max_gap_s": 1.5,
        "batch_size_s": 300,
        "max_batch_chunks": 64,
        "inference_batch_size": 8,
        "precision": "bf16",
        "tf32": true,
        "include_events": true,
        "fail_open": true
      }
    }
  }
}
```

`room_ids` 是第二道保护。即使生产配置开启，其他直播间传给 Python 的 `enabled` 仍为 `false`。

`inference_batch_size`、`precision` 和 `tf32` 只改变 SenseVoice 的 GPU 推理方式，
不改变 `chunk_s`、`max_gap_s` 或情感时间轴输入，因此不会破坏下游多次 AI 调用复用的固定输入。

## 输出契约

Paraformer 每个字幕段可带：

```json
{
  "start": 45.2,
  "end": 49.8,
  "text": "怎么突然这样",
  "emotion": "SURPRISE",
  "events": ["Laughter"]
}
```

顶层 `emotion_analysis` 会写入同名 SRT 旁的 `.asr_meta.json`：

```json
{
  "emotionAnalysis": {
    "status": "completed",
    "model": "iic/SenseVoiceSmall",
    "chunks": 85,
    "labeledChunks": 82,
    "emotionCounts": {
      "HAPPY": 40,
      "ANGRY": 18
    },
    "eventCounts": {
      "Laughter": 6
    },
    "timings": {
      "audio_load_s": 0,
      "model_load_s": 1.8,
      "inference_s": 4.2,
      "total_s": 6.1
    },
    "inferenceBatchSize": 8,
    "precision": "bf16",
    "tf32": true,
    "timeline": []
  }
}
```

常驻 worker 健康检查增加 `emotion_model_loaded`，ASR 阶段计时增加：

- `emotion_model_load_s`
- `emotion_inference_s`
- `emotion_total_s`

这三项同时写入 `.asr_meta.json` 的 `stageTimings` 和 `timingSummary`，并在
`ASR阶段耗时` / `[[ASR_TIMING]]` 日志中输出，便于分别比较冷启动加载、纯推理和整个情感分析环节。

## 下游使用

### 晚安回复与漫画脚本

`do_fusion_summary.js` 读取 `.asr_meta.json`，把以下内容写入共用的 `_AI_HIGHLIGHT.txt`：

- 全场主要情感分布。
- 笑声、哭声、掌声等明显声音事件。
- 最多 8 个罕见或强烈情感时刻。
- 已入选摘要段对应的情感标注。

晚安回复直接读取该文件。漫画脚本的清理函数保留这些行，因此二者获得相同情感上下文。标签只作为语气线索，提示词仍要求以字幕事实为准。

### 自动切片

`own_stream_clipper.js` 读取同一个 sidecar：

- `SURPRISE/FEAR/SAD/DISGUST/CONTEMPT` 可产生本地候选。
- `Laughter/Cry/Applause` 可显著提高候选分数。
- 情感转换可产生中等分数候选。
- 单独的常见 `HAPPY/ANGRY` 分数低于阈值，不会让整场直播都变成候选。
- 分块和全量 AI 规划上下文都包含压缩后的情感时间轴。
- 最终 PLAN/review 中的候选元数据保留 `emotions`、`events` 和 `emotionEvidence`。

评分在 `ownStreamClips.emotionScoring` 中独立配置。

## 运维注意

- Paraformer、CAM++ 和 SenseVoiceSmall 会同时驻留 GPU。当前目标机器是 16 GB RTX 5080，真实运行仍应观察峰值显存。
- `modelCacheHit=true` 表示 SenseVoice 模型已经由常驻 worker 复用。
- SenseVoice 情感标签可能把高声、背景音乐或游戏声误判为情绪，不能当作人工情感真值。
- 需要关闭时，将生产配置的 `emotion_analysis.enabled` 设为 `false`；无需修改下游。

## 2026-07-29 真实验证

样本来自岁己房间 `25788785` 的五子棋录播开头 15 分钟，转换为 16 kHz 单声道后，通过真实常驻 Paraformer worker 连续运行两次：

| 指标 | 冷启动 | 常驻缓存 |
|---|---:|---:|
| 整体调用耗时 | 58.035 秒 | 16.982 秒 |
| Paraformer pipeline | 6.887 秒 | 6.173 秒 |
| SenseVoice 情感总耗时 | 10.252 秒 | 7.627 秒 |
| SenseVoice 模型加载 | 2.225 秒 | 0 秒 |
| Paraformer 缓存命中 | 否 | 是 |
| SenseVoice 缓存命中 | 否 | 是 |

样本得到 85 个情感块，其中 78 个有明确标签：

- `HAPPY`: 42
- `ANGRY`: 17
- `SURPRISE`: 10
- `NEUTRAL`: 5
- `SAD`: 4

声音事件包含 `Laughter`、`Cough`，高频 `BGM/Speech` 保留在原始 sidecar，但不会进入切片候选的事件证据。该样本产生 9 个情感辅助候选。

验证产物：

- `tmp/sui-emotion-validation-20260729/validation-report.json`
- `tmp/sui-emotion-validation-20260729/sui_first_15m_emotion.asr_meta.json`
- `tmp/sui-emotion-validation-20260729/sui_first_15m_emotion_AI_HIGHLIGHT.txt`
- `tmp/sui-emotion-validation-20260729/sui_first_15m_emotion.emotion_candidates.json`

复跑命令：

```powershell
node scripts/validate_sui_emotion_pipeline.js `
  tmp/sui-emotion-validation-20260729/sui_first_15m_16k_mono.wav `
  --runs 2
```
