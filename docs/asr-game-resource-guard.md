# ASR 游戏友好资源策略

## 结论

三角洲行动中 CPU、GPU 都没有显示 100% 并不代表没有资源竞争。游戏帧时间通常受少数渲染/逻辑线程、驱动队列和显存分配影响；ASR 的 CUDA 峰值、模型常驻显存以及 4 个左右的 CPU 线程都可能造成瞬时卡顿。

项目原有的 `gpu_throttle` 和 `cpu_throttle` 会在推理阶段前等待资源，但它们不会释放已经由常驻模型持有的显存，也不会限制 PyTorch/OMP 线程。生产配置现在增加了游戏保护层：

- 检测 `DeltaForceClient-Win64-Shipping.exe` 运行时，不启动新的 ASR 任务；
- 队列进入游戏保护状态时停止常驻 Paraformer worker，归还模型显存；
- 单次 Python ASR 入口也会在模型构造前等待游戏退出，避免绕过队列保护；
- ASR Python 进程使用 `BelowNormal`、EcoQoS 和 PyTorch/OMP/MKL 线程上限；
- Windows 11 支持 CPU Sets 时，可把 ASR 偏向效率核心。当前机器实测为 8 个性能核心、12 个效率核心。

## 配置

`config/production.json` 的 `asr.paraformer.resource_guard` 控制这套策略：

```json
{
  "enabled": true,
  "game_process_names": ["DeltaForceClient-Win64-Shipping.exe"],
  "pause_when_game_running": true,
  "poll_interval_s": 3,
  "wait_s": 15,
  "max_wait_s": 0,
  "priority": "belowNormal",
  "eco_qos": true,
  "prefer_e_cores": true,
  "torch_num_threads": 4,
  "torch_num_interop_threads": 1
}
```

`max_wait_s: 0` 表示游戏期间无限期排队，优先保证游戏帧时间。不要把游戏期间的 ASR 强制切到 CPU：这样会把 CUDA 竞争换成 P 核竞争，通常更卡。游戏退出后队列会自动恢复。

`prefer_e_cores` 使用 Windows CPU Sets 的效率等级，不使用固定逻辑核心编号。系统不支持 CPU Sets 或接口调用失败时，ASR 会继续运行并保留低优先级/EcoQoS，不会影响正常处理。

`gpu_throttle` 和 `cpu_throttle` 仍然保留，用于没有配置进程名、或游戏保护关闭时的资源等待。
