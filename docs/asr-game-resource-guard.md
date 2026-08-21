# ASR 游戏友好资源策略

## 结论

Paraformer 的主要推理路径在 GPU 上。把它强制搬到 E 核 CPU 会明显变慢，也可能增加游戏的 CPU 帧时间，因此生产配置默认继续使用 CUDA。

游戏期间不再因为进程名直接暂停队列。Python 运行时会使用低优先级、EcoQoS、PyTorch 线程上限和 Windows CPU Sets 的 E-core 偏好；当检测到其他 GPU 进程造成明显压力时，继续使用 GPU，但把交互 batch 缩小，并在 CUDA 阶段之间主动让出短时间。CPU 负载过高时，CPU 节流只有限等待，避免任务无限堆积。

## 通用 GPU 检测

`GpuThrottle` 每隔 `check_interval_s` 采样一次：

- `nvidia-smi pmon` 识别当前进程之外的 GPU PID，并读取可用的 SM、显存带宽和帧缓冲数据；
- Windows 图形进程经常在 `pmon` 中显示 `C+G` 和 `-`，此时用 `nvidia-smi` 的总 GPU 利用率补判；
- 如果检测工具不可用，策略会故障放行，不让监控命令本身阻塞 ASR。

因此不依赖三角洲的进程名，其他使用 NVIDIA GPU 的游戏或图形应用也能进入低影响模式。进程名仍可用于用户明确需要的硬暂停，但生产默认关闭这个硬暂停。

## 生产配置

`config/production.json` 的 `asr.paraformer` 相关配置控制策略：

```json
{
  "resource_guard": {
    "enabled": true,
    "game_process_names": ["DeltaForceClient-Win64-Shipping.exe"],
    "pause_when_game_running": false,
    "priority": "belowNormal",
    "eco_qos": true,
    "prefer_e_cores": true,
    "torch_num_threads": 4,
    "torch_num_interop_threads": 1
  },
  "gpu_throttle": {
    "enabled": true,
    "hard_wait": false,
    "soft_gpu": {
      "enabled": true,
      "sm_threshold": 40,
      "mem_threshold": 40,
      "fb_threshold_mb": 4096,
      "total_memory_threshold_pct": 75,
      "include_total_utilization": true
    },
    "low_impact": {
      "batch_size_s": 30,
      "yield_s": 0.2,
      "model_load_max_wait_s": 3,
      "model_load_poll_s": 1
    }
  },
  "cpu_throttle": {
    "enabled": true,
    "wait_s": 1,
    "max_wait_s": 2
  }
}
```

`low_impact.batch_size_s` 只在检测到外部 GPU 压力时生效；普通情况下沿用 Paraformer 的 `interactive_batch_size_s`。它降低单次 CUDA 工作块的峰值，但会牺牲一些吞吐量。`yield_s` 是阶段之间的让出时间，不是强制暂停整个队列。

首次加载模型且 GPU 正在高压时，`model_load_max_wait_s` 会给显存/驱动队列一个最多几秒的窗口；窗口内没有空闲就继续低影响加载，不会无限等待。

`prefer_e_cores` 使用 Windows CPU Sets 的效率等级，不依赖固定逻辑核心编号。系统不支持 CPU Sets 时仍保留低优先级和 EcoQoS。

如果确实希望游戏期间完全排队，可将 `pause_when_game_running` 改为 `true`；这只是显式的兼容模式，不是生产默认策略。
