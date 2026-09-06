# Paraformer 与 SenseVoice 同条件对比（2026-09-06）

## 结论

当前默认仍是 `asr.default_backend=paraformer`、`asr.paraformer.model=paraformer-zh`。ModelScope 将该模型别名映射到 SeACo Paraformer。SenseVoice 有单独的房间路由；岁己房间还会在 Paraformer 转写后使用 SenseVoice 做情感分析，这不等于默认转写后端已经切换。

本次没有修改生产配置或 ASR 实现，只新增隔离比较与报告。

结论分为两层：

- **模型本身**：SenseVoice 在相同 batch=8 的短句批量推理中更快、累计 CPU 时间更少；两者显存和 RAM 同一量级。扩大后的参考集没有显示 SenseVoice 的总体准确率优势。
- **当前项目流程**：Paraformer 能复用常驻模型和参考声纹，且已经接入字符级时间戳；SenseVoice 主转写仍重新构造模型，并使用较粗的 VAD 段时间轴。因此不能用纯模型速度直接推导切换默认后端的收益。

建议继续保留 Paraformer 默认。若后续考虑全面切换 SenseVoice，应先补齐常驻模型复用、时间轴适配及相应长录播真值验证。

## 测试方法

- 本机 RTX 5080 16GB、Python 3.12.4、FunASR 1.4.3、PyTorch 2.11.0+cu128、NumPy 2.3.5；PyTorch 4 线程、interop 1 线程。
- 模型分别在独立进程中执行，GPU 任务串行。进程 RAM 使用 Windows `GetProcessMemoryInfo`，CPU 时间使用 `time.process_time()`，显存使用 PyTorch allocated peak；没有把整卡后台占用算给模型。
- 参考集全部使用相同的 2,535 句、303 个字幕视频，合计 5,136.342s（85.6 分钟）、22,463 个归一化字符。没有缺失文件、重复冲突或按输出好坏筛选样本。
- 纯模型测试统一预解码为 16kHz mono float32、batch=8、language=auto、ITN=true。关闭外部 VAD、标点、speaker、房间纠错；预热后完整推理两次，音频解码和模型加载不计入推理时间。
- 长录播测试使用同一段栞栞 900s 和同一段岁己 900s，每个后端、每段素材一个独立进程，连续调用两次。统一 CAM++、14 份参考配置与匹配参数；主对照不额外启用 Paraformer 的情感第二遍推理。
- 长流程保留各自当前接入策略：Paraformer 的 CPU VAD、batch_size_s=600 和常驻缓存；SenseVoice 的 GPU VAD、8s 分段、真实 batch=8、batch_size_s=300。它反映当前实现，而不是所有阶段算法参数完全相同。
- 基准关闭动态节流与 Windows 进程调度策略。后台负载导致短时速度明显波动，因此报告范围，不将少量时间差归因于模型本身。生产游戏保护仍按原配置执行。

## 文字准确性

| 指标 | Paraformer-zh | SenseVoiceSmall |
| --- | ---: | ---: |
| 参考 CER，越低越好 | 14.882% | 15.176% / 15.154% |
| 首次推理完全匹配句数 | 1,169 / 2,535 | 1,159 / 2,535 |
| 相对另一模型编辑距离更小的句数 | 445 | 451 |
| 两者编辑距离相同 | 1,639 | 1,639 |

SenseVoice 相对 Paraformer 的 CER 差为 **+0.294 个百分点**。按 303 个字幕视频分组进行 10,000 次 bootstrap，95% 区间为 **[-0.361, +0.991] 个百分点**，跨过 0。因此没有足够证据断言整体准确性存在可靠胜负。

SenseVoice 两次推理有 66 句输出字符串变化，汇总 CER 变化约 0.022 个百分点；两次结果都已保存，比较表预先采用首次结果。Paraformer 两次文本一致。

句长分布有影响：

| 音频长度 | 句数 | Paraformer CER | SenseVoice CER |
| --- | ---: | ---: | ---: |
| 小于 2s | 1,457 | 16.41% | 17.47% |
| 2–4s | 996 | 12.70% | 12.28% |
| 4s 及以上 | 82 | 22.41% | 22.75% |

前一轮 120 句抽样要求至少 2s、至少 8 字，且每个字幕视频最多一句；不能把那次 SenseVoice 的小样本优势推广到全部素材。当前分组表也只是描述，特别是 4s 以上只有 82 句，不能据此作普遍结论。

这些是**既有剪映字幕参考 CER**。字幕没有逐字复听，可能有改写、省略口头语、数字表达差异；裁剪边界也可能切到发音。它不是成品字幕的绝对准确率，也不含生产 phoneme correction、房间纠错及完整录播的 VAD 分段效果。

## 纯模型速度与资源

处理同一批 85.6 分钟、2,535 句预解码音频：

| 指标 | Paraformer-zh | SenseVoiceSmall |
| --- | ---: | ---: |
| 推理两次耗时 | 39.54s / 65.80s | 26.51s / 26.77s |
| 相对实时速度 | 78–130 倍 | 192–194 倍 |
| 累计 CPU 时间 | 150.69 / 169.30 CPU-s | 101.23 / 101.67 CPU-s |
| 平均占用逻辑核 | 2.57–3.81 | 3.80–3.82 |
| PyTorch 显存峰值 | 1,169 MiB（1.14 GiB） | 1,195 MiB（1.17 GiB） |
| 进程 RAM 峰值 | 4,009 MiB（3.92 GiB） | 3,891 MiB（3.80 GiB） |
| 推理后进程工作集 | 2,166 MiB | 2,745 MiB |
| 模型构造/加载 | 4.25s | 2.29s |

在这组测试中，SenseVoice 原始模型约快 1.5–2.5 倍，累计 CPU 工作约少三分之一。CPU-s 是各线程累计执行时间，不是墙钟等待时间；平均占用核数接近并不表示总计算量相同。

RAM 包括 Python、依赖、全部音频数组、模型加载临时对象等，不能解释成模型权重大小。显存是当前进程 PyTorch 张量峰值，不含所有驱动分配。这些数字不支持“SenseVoice 的内存/显存显著更省”这样的笼统结论。

## 当前完整流程

两条流程均产生转写、标点和 CAM++ speaker。SenseVoice 内建情感标签仍随模型输出；这里先关闭 Paraformer 的额外情感阶段。

| 同一 900s 素材 | Paraformer 新进程首个结果 | SenseVoice 新进程首个结果 | Paraformer 同进程第二次 | SenseVoice 同进程第二次 |
| --- | ---: | ---: | ---: | ---: |
| 栞栞 | 65.63s | 90.59s | 12.72s | 37.35s |
| 岁己 | 39.29s | 48.51s | 6.96s | 52.23s |

首个结果包括 Python 库导入、模型加载及转写。第二次统一在同一个 Python 进程内调用，**Paraformer 命中常驻缓存，SenseVoice 仍重建模型**。第二次 SenseVoice 时间不包括重新启动 Python；真实的独立任务还会有进程/库导入成本，所以这里不是 SenseVoice 已有常驻服务的成绩。

观察到的开销分解：

- 栞栞第二次：VAD+ASR+标点核心处理约为 Paraformer 10.24s、SenseVoice 10.26s；最终 12.72s 与 37.35s 的差别主要发生在模型/标点/CAM++ 重建及准备工作，而非纯识别网络本身。
- Paraformer 第二次的主模型加载为 0，参考声纹命中缓存；SenseVoice 当前没有主转写常驻复用。
- 当前 Paraformer 的 VAD 放在 CPU；SenseVoice 主转写仍使用 GPU VAD。两者的切段与字幕时间轴不同，也会改变后续的工作量。

第一次调用时的资源峰值：

| 素材与流程 | PyTorch 显存峰值 | 进程 RAM 峰值 |
| --- | ---: | ---: |
| 栞栞 Paraformer | 3.74 GiB | 5.96 GiB |
| 栞栞 SenseVoice | 3.70 GiB | 6.42 GiB |
| 岁己 Paraformer | 3.81 GiB | 5.96 GiB |
| 岁己 SenseVoice | 3.70 GiB | 6.47 GiB |

不使用同进程第二次重载后的 RAM 历史峰值作冷启动比较。完整流程由多个模型组成，资源消耗明显高于上面的纯 ASR 网络。

### 岁己的生产情感配置

单独补跑岁己当前开启额外情感分析的 Paraformer 路径：新进程首个结果 83.86s、同进程第二次 15.67s，PyTorch 显存峰值约 **7.14 GiB**。第二次情感阶段自身计时 **3.04s**，状态为 `completed`。

这个额外阶段会再加载 SenseVoice 模型，解释了之前完整流程约 7 GiB 的显存峰值；不能将其当成 Paraformer ASR 网络本身的显存。不同时间独立运行的 CPU/GPU/加载速度有波动，也不能把 15.67s 与 6.96s 的全部差值都算作情感推理成本。

## 能力取舍

| 需求 | 当前 Paraformer 接入 | 当前 SenseVoice 接入 |
| --- | --- | --- |
| 文字识别 | 中文与中英混合；本次参考 CER 接近 | 多语言与声音事件；本次参考 CER 接近 |
| 字幕/切片时间轴 | 已使用字符级时间戳重建字幕 | 当前主要使用 VAD 块时间区间，块长上限通常 8s |
| 情感/声音事件 | 可额外调用 SenseVoice | 模型原生输出 |
| 连续队列吞吐 | 已有常驻模型与参考缓存 | 主转写仍重新构造模型 |
| Speaker | 独立 CAM++ 与参考匹配 | 同样使用 CAM++ 与参考匹配 |

SenseVoice 模型本身有可选时间戳能力，但本项目主转写路径尚未按与 Paraformer 等价的细时间轴接入和验证。两条路径都用 CAM++，不能认为换 ASR 就会自动提高 speaker 准确性；这仍需带身份和重叠发言标注的独立测试。

## 产物

目录：`tmp/paraformer-vs-sensevoice-20260906/`。

- `references.json`：完整固定参考集与原清单 SHA-256。
- `results/model-*.json`：纯模型逐句结果、重复计时、CPU/RAM/显存。
- `results/model-sensevoice.repeat-*.json`：SenseVoice 两次独立输出与 CER。
- `results/pipeline-*.json` / `*.payload.json`：相同素材下的完整流程结果与参数。
- `summary.json`：汇总、按视频分组的置信区间、按句长分层。
- `reference_review.tsv`：原音频路径、参考文字、两模型文字和编辑距离，供人工复核。

本机复跑脚本为 `local-scripts/compare_paraformer_sensevoice_20260906.py`（`prepare` / `run`）和 `local-scripts/summarize_paraformer_sensevoice_20260906.py`。这些本地实验脚本及大文件目录按仓库约定不纳入 Git，既有录播和生产配置未改写。
