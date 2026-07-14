# FunASR VAD 参数与音频格式基准

使用 `src/scripts/python/benchmark_funasr_vad.py` 测试 FSMN-VAD。脚本不会传入 `disable_pbar`，所以 FunASR 的 `tqdm` 进度条会正常显示。

默认测试三组：

| Case | VAD device | `chunk_size` |
| --- | --- | ---: |
| A | `cuda:0` | 60000 ms |
| B | `cuda:0` | 120000 ms |
| C | `cpu` | 120000 ms |

默认重复 2 次；同时对 A 做一次格式对照：原始文件直接 VAD，和先用 FFmpeg 转成 16 kHz、单声道、PCM WAV 后再 VAD。

在仓库根目录执行：

```powershell
D:\develop\Python\python.exe src\scripts\python\benchmark_funasr_vad.py `
  "D:\path\to\input.m4a"
```

结果会写入 `tmp\funasr-vad-benchmark-时间戳\results.json`，终端会显示每次 VAD 的进度条和最终汇总。汇总中的 `formatted_total_once` 是“一次格式化 + 一次规范 WAV VAD”的总耗时；如果规范 WAV 会被后续任务复用，则主要看 `formatted_vad`。

如果要让格式对照覆盖三组参数：

```powershell
D:\develop\Python\python.exe src\scripts\python\benchmark_funasr_vad.py `
  "D:\path\to\input.m4a" `
  --format-cases A,B,C
```

如果只想做 ABC，不做格式转换：

```powershell
D:\develop\Python\python.exe src\scripts\python\benchmark_funasr_vad.py `
  "D:\path\to\input.m4a" `
  --format-cases none
```

重点比较 `vad_s`、VAD 分段数量、总语音时长，以及原始输入和规范 WAV 的首尾时间戳。如果分段统计明显不同，应先确认格式化没有改变音频内容，再比较速度。
