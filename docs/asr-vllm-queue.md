# ASR vLLM 批量队列设计

目标：晚上或空闲时启动一个长驻 ASR worker，一次加载 Fun-ASR-Nano vLLM，连续处理多个视频，避免每个视频都重新加载 vLLM；需要玩游戏时可以暂停，之后继续处理队列。

## 推荐方案

保留现有 webhook 队列作为“任务来源”，新增一个 ASR worker 模式负责消费待处理视频：

```text
DDTV/webhook -> existing queue file -> asr-vllm-worker
                                pause flag -> worker checks between jobs
```

第一版已落地为 ASR-only worker：`src/scripts/asr/asr_vllm_queue_worker.js` + `src/scripts/python/fun_asr_nano_vllm_worker.py`。它不直接消费完整总结队列，避免只生成 SRT 后把总结任务误标完成；可以把现有 pending 队列导入到独立 ASR 队列，先做“预转写/实验队列”。

worker 常驻流程：

1. 启动时读取配置，加载 `fun_asr_nano_vllm`。
2. Python worker 常驻，Fun-ASR-Nano vLLM 模型只加载一次。
3. Node worker 逐个领取 pending 视频，向 Python worker 发送 JSONL 转写任务。
4. 对单个视频完成 ASR、写 SRT、写 speaker sidecar。
5. 每个视频完成后检查暂停标记；暂停时停止领取新任务。
6. resume 后继续从 pending 任务开始。
7. 如果上一次 worker 异常退出，且状态文件里的 worker pid 已不存在，下次启动会把旧 `processing` 任务恢复为 `pending` 后重试。

## 暂停策略

第一版建议“视频之间暂停”，不在单个视频中途强停：

- 优点：实现简单，字幕和 sidecar 不会产生半成品。
- 缺点：如果当前视频很长，点暂停后要等当前视频完成。

如果需要立刻释放 GPU，可以直接结束 worker 进程；当前正在处理的视频不会写入完成状态，下次运行会恢复为 pending 并重新处理。

第二版再加“分段检查点暂停”：

- Python vLLM pipeline 处理完一批 VAD segment 后写 checkpoint。
- pause 时当前 batch 完成即停。
- resume 读取 checkpoint，只补未完成 segment。

## 状态文件

当前使用：

- `tmp/asr-vllm-queue/state.json`
- `tmp/asr-vllm-queue/tasks.json`

```json
{
  "paused": false,
  "workerPid": 1234,
  "backend": "fun_asr_nano_vllm",
  "currentTaskId": null,
  "updatedAt": "2026-06-03T00:00:00.000Z"
}
```

当前支持的控制命令：

```bash
npm run asr:vllm-worker -- --status
npm run asr:vllm-worker -- --enqueue "D:/path/to/video.flv" --room-id 25788785
npm run asr:vllm-worker -- --import-whisper-queue
npm run asr:vllm-worker -- --run --backend fun_asr_nano_vllm
npm run asr:vllm-worker -- --pause
npm run asr:vllm-worker -- --resume
npm run asr:vllm-worker -- --retry-failed
```

验证队列但不启动 vLLM：

```bash
npm run asr:vllm-worker -- --run --dry-run
```

验证环境是否能真实启动 vLLM：

```bash
npm run asr:vllm-doctor
```

`asr:vllm-worker` 和 `asr:vllm-doctor` 都读取 `asr.fun_asr_nano_vllm.python_executable/python_args/python_path_map`。如果 vLLM 安装在独立 venv 或 WSL，先配置该 Python 和路径映射，再用 doctor 确认环境。

## 与 SenseVoice 的关系

SenseVoiceSmall 继续保留为快速后端，适合临时想省显存、低延迟或不需要真实热词的场景。Fun-ASR-Nano vLLM 作为批量高吞吐后端，重点用于空闲时处理积压视频和验证热词效果。

## 当前准备状态

- `fun_asr_nano_vllm` 后端配置已独立于 `sensevoice`。
- Python 入口已能在该后端下走 Fun-ASR-Nano vLLM pipeline。
- ASR-only vLLM 队列 worker 已准备好，支持 enqueue/import/status/pause/resume/dry-run。
- 队列 worker 支持 `--retry-failed`，可在修好 vLLM 环境后重试之前失败的任务。
- 队列 worker 已支持中断恢复：无活跃 worker 时，旧 `processing` 任务会退回 `pending`。
- vLLM doctor 已准备好，支持检查 `torch` CUDA、`vllm`、FunASR vLLM pipeline 和本地模型缓存。
- ASR 子进程、doctor、队列 worker 均已支持 `python_path_map`，可把 Windows 录播路径映射到 WSL/Linux 路径。
- 当前环境缺少 `vllm` 包，worker 真正长驻复用模型前需要先补齐 vLLM 安装和 CUDA 兼容性验证。
- benchmark 已能记录每次 ASR 的耗时、RTF 和热词/误识别项，后续 worker 接入后可直接复用同一批样本做速度对比。
