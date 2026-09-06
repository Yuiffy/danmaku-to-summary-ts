# ASR 优化落地与验证（2026-09-06）

## 已落地

1. SenseVoice 真批量推理，默认 `inference_batch_size=8`，可设 `1` 回退。按段数与 padding 后时长限制批次，逐批检查 GPU 压力；保留每段原时间区间、speaker/情感元数据以及原标点恢复流程。
2. 批量失败、返回数量错误或格式异常时，本次请求剩余部分退回逐段。未验证完整批次前不写字幕，避免结果错配和重复输出；单段失败仍正常上报错误。
3. Paraformer 常驻 worker 复用参考声纹 prototypes。按模型实例、device、文件内容和配置失效，最多缓存一组。缺失文件、提取失败、不完整结果或提取中替换文件不会沿用旧缓存。

主模型继续使用 Paraformer/CAM++ 和 FunASR 1.4.3，保持当前拒识门槛。此次没有根据少量样本扩大微调灰度或自动登记新的 speaker 参考。

## 实测

使用当前 FunASR 1.4.3、PyTorch 2.11.0+cu128、NumPy 2.3.5 与 RTX 5080；GPU 测试串行进行。复用此前两段 900s 直播音频及 120 句既有字幕参考（1,525 字）。不覆盖原录播及其 sidecar。

基准关闭资源监控采样与节流，PyTorch 4 线程。基线在修改代码前加载，保存了源文件 SHA-256 指纹；优化组从新进程加载新代码。SenseVoice 每次重新加载模型，执行 2 次完整流程；Paraformer 同一进程 4 次，第 1 次冷加载，后 3 次取中位数。

| 项目 | 基线 | 优化后 | 验证结果 |
| --- | ---: | ---: | --- |
| SenseVoice，900s，ASR+标点阶段，第 2 次 | 14.32s | 4.90s | 约 2.9 倍阶段提速 |
| SenseVoice，900s，完整调用，第 2 次 | 48.13s | 33.07s | 包含模型加载、VAD、speaker |
| SenseVoice，900s，完整调用，第 1 次 | 47.01s | 39.74s | 冷加载/主机负载使总耗时波动 |
| Paraformer，900s，含 speaker 与情感的常驻中位数 | 10.11s | 8.78s | 约减少 13% 总耗时 |
| Paraformer 参考声纹阶段，第 4 次 | 1.020s | 0.058s | 仍包含文件内容校验开销 |
| SenseVoice，120 句，预解码音频推理+归一化 | 8.39s | 1.29s | 本次约 6.5 倍，非整条生产链路 |

120 句参考的原始文本逐句一致，参考 CER 均为 **11.016%**。该集合使用已有剪映字幕，尚未逐字复听，不代表成品字幕的绝对准确率。预解码基准不包含模型加载、VAD 和音频解码，不能与上次包含文件输入的纯模型计时直接相减。

### 输出一致性

- Paraformer 4 组对应运行的 146 段字幕：文字、起止时间、speaker 标签、情感和事件均一致；情感分析状态均为 `completed`。优化组第 2–4 次 `reference_cache_hit=1`。
- SenseVoice 2 组对应运行均为 146 段：起止时间、speaker 和情感一致，**17 段文字、1 段事件有变化**；去除标点空白后的编辑距离合计为 19，基线 2,733 字。这是新旧输出差异，不是错误率增幅。
- 额外做了 cuDNN TF32 开/关、batch=1/8 的同音频对照，关闭 TF32 仍有批量差异。本次保持原有计算精度设置，没有增加新的低精度开关。
- `sensevoice_long_review.tsv` 保存了长音频变化段，尚未人工逐字复听。需要复现旧逐段输出时，将 `asr.sensevoice.inference_batch_size` 设为 `1`。

SenseVoice 每次长音频调用实际进行了 21 个批量调用和 7 个单段调用，无异常回退。两条完整流程的 Tensor 显存峰值没有明显增加：SenseVoice 两组均约 3,792 MiB，Paraformer 两组均约 7,306 MiB。该峰值含本流程模型与激活，不等于整卡占用。

## 回归覆盖

相关测试共 84 个 Python 测试、64 个 JS 测试通过。

- 新增 6 个 SenseVoice 测试：时间/情感映射、每批段数、单段回退配置、动态 padding 预算、异常/错位返回回退、空文本不串位、单段错误上报。
- 新增 8 个声纹缓存测试：命中、同大小同 mtime 内容替换、模型/device/参数/state/范围变化、删除/重建、失败/部分结果、提取中替换、阈值变化复用、释放重建。
- 原有 speaker 开放集匹配、多状态 prototype、拒识、字幕归一化、情感、设备和资源节流测试通过。
- JS 验证默认 batch=8、配置覆盖为 1 和 production 合并值；ASR 后端套件 64 项通过。

测试命令：

```powershell
python -m unittest discover -b -s tests -p 'test_sensevoice*.py'
python -m unittest discover -b -s tests -p test_speaker_reference_cache.py
python -m unittest discover -b -s src/scripts/python -p 'test_sensevoice*.py'
npm test -- --runInBand src/scripts/asr/asr_backends.test.ts
```

## 生效与复现

SenseVoice 每个新任务会加载新 Python 源码。检查时没有在运行的旧 ASR 常驻 worker，后续 Paraformer 任务由队列新建 worker 后加载缓存优化，无需重启录播或整个 webhook。

结果目录为 `tmp/asr-optimization-20260906/`：`baseline/`、`optimized/` 保存每次完整 JSON、日志、输入配置与代码指纹；`comparison.json` 和 `sensevoice_long_review.tsv` 汇总对照；`sensevoice_precision.json` 保存额外的精度对照。

复跑需使用新的输出目录：

```powershell
python scripts/benchmark_asr_optimizations.py --output-dir tmp/asr-optimization-new-run --sensevoice-audio tmp/funasr-model-benchmark-20260729/shiori_180m_195m_16k_mono.wav --paraformer-audio tmp/funasr-1.4.3-benchmark-900s.wav --reference-manifest tmp/asr-research-20260906/validation_manifest.json
```

该脚本仅在参考清单存在时使用这份本地参考集；省略 `--reference-manifest` 可单独验证长录播。通过 `--sensevoice-batch-size 1` 可验证逐段回退。生产节流仍按原配置工作，基准里的关闭选项只在独立测试 payload 中使用。
