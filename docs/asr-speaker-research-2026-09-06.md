# ASR 与 Speaker 优化实测调研（2026-09-06）

后续落地与实测结果见 [ASR 优化验证](asr-optimization-validation-2026-09-06.md)。本页保留优化前的调研记录。

## 结论

有提升空间。现阶段优先做 **SenseVoice 真批量推理、参考声纹缓存、跨日期参考音频与短语音处理**。单独升级 FunASR、扩大 Paraformer batch、切换 GPU VAD 或统一开启 BF16，均没有得到可直接推广的收益。

本次只新增隔离实验与报告，生产配置、全局 Python 依赖、模型选择、参考声纹库均未修改。

| 方向 | 证据 | 建议 |
| --- | --- | --- |
| FunASR 1.4.3 → 1.4.14 | 两段 15 分钟音频及 120 句参考集文字一致；新版依赖与项目 NumPy 约束冲突 | 不以提高现有 Paraformer 准确率为理由立即升级 |
| SenseVoice 真批量 | 同样 120 句，batch=1 为 6.76s，batch=8 为 2.23s，参考 CER 相同 | 优先验证并接入现有逐段路径，约 3 倍是该测试的推理阶段收益 |
| 参考声纹缓存 | ASR+speaker 常驻 8.07s → 6.74s，文字、时间轴、speaker 标签一致 | 优先加入带失效条件的进程内缓存 |
| Nano 纯文本批量 | 禁用 CTC、BF16、batch=8 后，45.91s → 23.06s；CER 10.69% → 10.95% | 适合对精选片段做文本复核；失去 CTC 时间戳，不能直接等同原流程 |
| 当前微调 Paraformer | 参考 CER 12.92% → 10.89%，27 句改善、8 句退化 | 先做按原录播/日期隔离的评估，再决定扩大灰度 |
| Speaker 参考与语音长度 | CAM++ 跨日期 8s 样本正确实名 9/24 → 17/24；1s 与 8s 正确实名为 18/53、43/53 | 优先积累稳定、无重叠、同一说话人的声学证据，字幕仍可保持短句 |
| ERes2NetV2 | 同条件 8s 正确实名 46/53，CAM++ 为 43/53；短句出现新增误认，显存增加 | 作为复核候选，重新校准阈值，不直接替换 |
| MOSS 0.9B | 四人联动跑通；120 句参考 CER 12.79%，推理 129.95s | 继续作为联动精修候选，需要真实 speaker 标注验证 |

## 环境与方法

- Windows，RTX 5080 16GB，驱动 616.64。
- Python 3.12.4；PyTorch 2.11.0+cu128；NumPy 2.3.5；Transformers 5.9.0；ModelScope 1.37.1。
- 当前 FunASR 为 1.4.3；1.4.14 通过 `pip --no-deps --target` 放在实验目录，以独立进程加载。每次记录实际包版本及导入路径。
- GPU 推理实验串行执行，PyTorch 4 线程。长音频参数实验关闭 GPU/CPU 节流、Windows 调度策略和资源监控采样，表示空闲机器的处理能力；不代表运行游戏时的生产延迟。
- 每个长音频配置独立启动，连续执行 4 次：第 1 次包含模型加载，后 3 次取常驻耗时中位数。短句模型表是一次完整固定样本推理，加载时间另记。
- 显存为 PyTorch `max_memory_allocated()`，不是整卡占用，也不包含所有驱动/非 PyTorch 分配。进程还记录了 reserved peak。

### 数据

1. 长音频 A：栞栞 2026-06-04 录播 180:00–195:00，900s；沿用此前基准的 16kHz mono WAV。
2. 长音频 B：已有 `funasr-1.4.3-benchmark-900s.wav`，900s；文件元数据对应岁己 2026-08-23 录播。原录播可追溯，截取起点未在该 WAV 元数据中记录，复现实验使用同一个 WAV。
3. 字幕参考：从已有剪映导出字幕验证集 2,535 句中，用固定种子 20260906 抽取 120 句，每个字幕视频文件最多一句，长度 2–12s、至少 8 字。合计 338.28s、归一化后 1,525 字。
4. Speaker：现有参考库的已登记身份音频。100 个 8s 登记块、34 个校准块、61 个测试块。测试包含 53 个已知身份块和 8 个未登记身份块；其中 24 个已知块来自完全留出的栞栞 8 月 24 日素材。1/2/4/8s 是同一批块的中心裁剪，不能当成独立增加的测试样本。
5. MOSS 联动冒烟：已有 `tmp/paraformer_test/izayoi_full.wav` 的 10:00–12:00，参与者元数据为十六萤、灰泽满、莉蔻、克罗雅。

### 准确率边界

**表内是“既有字幕参考 CER”，不是生产成品字幕的绝对错误率。** 字幕尚未逐字复听，可能省略口头语、改写句子或规范数字。统一去空白、标点并转小写；不做数字语义转换、繁简转换或人名纠错。

为比较模型本身，短句测试直接输入已有裁好的音频，关闭外部 VAD/标点，未走 JS 房间路由和生产纠错。除明确标注的热词行外，不加热词。MOSS 自身生成时间戳与匿名 speaker，计时包含这些工作。

微调评估存在明确的乐观偏差：120 句与训练集没有同 key 重复，但 **120/120 的字幕视频文件在训练集中有其他句子**。此外，这本来就是训练时使用的 validation 集。该结果不能证明跨录播泛化，也不能据此直接扩大灰度。

Speaker 指标衡量参考声纹的实名识别与拒识，不是完整直播 diarization 的 DER。参考音频此前经过 CAM++ 筛选，也可能对模型比较产生选择偏差。真实联动的重叠发言、说话人切换边界、游戏角色语音，仍缺少逐段人工真值。

## 版本升级

[PyPI](https://pypi.org/project/funasr/1.4.14/) 在 2026-09-03 发布了 1.4.14。与已安装 1.4.3 相比，新版主要涉及 MOSS 接入、服务稳定性、音频与 AMP 兼容等；现有模型权重并未因升级包版本自动变得更准确。

实测两段长音频的文字与字幕起止时间均一致，120 句原始模型结果也全部一致。长音频耗时没有稳定改善：

| 样本 | 1.4.3 常驻中位数 | 1.4.14 常驻中位数 | 文字/时间轴 |
| --- | ---: | ---: | --- |
| 栞栞 900s | 6.01s | 6.26s | 完全一致 |
| 岁己 900s | 5.13s | 6.37s | 完全一致 |

短耗时测试存在机器负载和顺序波动，不能把这些差值直接定性为版本性能回归；可以确认的是没有观察到足以支持升级的提速。

有一个实际依赖冲突：

```text
FunASR 1.4.14 wheel: numpy<2
项目 requirements-sensevoice.txt: numpy<2.4,>=2.2
本机: numpy==2.3.5
pip --dry-run funasr==1.4.14 "numpy<2.4,>=2.2": ResolutionImpossible
```

所以本次 1.4.14 是**固定现有依赖的代码对照**，不是依赖解析通过的生产安装验证。若为新功能升级，应单独建立满足依赖的 ASR 环境，再复测本项目时间戳、speaker 与情感链路。

另一个容易误判的点：ModelScope 的 `paraformer-zh` 已经映射到 `iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch`。显式加载该 SeACo 模型得到同样输出；它不是一个尚未使用的新候选。

## ASR 模型对照

以下使用同一份 120 句、1,525 字字幕参考。CER 越低越好；耗时不含模型加载和 Python/FunASR 导入。

| 模型/参数 | 参考 CER | 完全匹配句数 | 推理时间 | Tensor 显存峰值 |
| --- | ---: | ---: | ---: | ---: |
| 当前 Paraformer，1.4.3，无热词 | 12.92% | 51/120 | 3.29s | 1,155 MiB |
| 同模型，1.4.14，无热词 | 12.92% | 51/120 | 2.88s | 1,155 MiB |
| Paraformer + 固定 6 个热词 | 12.33% | 55/120 | 2.67s | 1,155 MiB |
| 现有 timestamp 微调模型 | 10.89% | 60/120 | 2.26s | 1,070 MiB |
| SenseVoice，auto，batch=8 | 11.02% | 49/120 | 1.85s | 1,173 MiB |
| SenseVoice，zh，batch=8 | 10.89% | 51/120 | 2.23s | 1,173 MiB |
| SenseVoice，zh，batch=1 | 10.89% | 51/120 | 6.76s | 948 MiB |
| Nano，CTC 保留，FP32，batch=1 | 10.69% | 59/120 | 45.91s | 3,414 MiB |
| Nano，CTC 保留，FP32，batch=4 | 10.69% | 59/120 | 47.45s | 3,414 MiB |
| Nano，CTC 保留，BF16，batch=4 | 10.95% | 58/120 | 53.83s | 2,277 MiB |
| Nano，移除 CTC，BF16，batch=8 | 10.95% | 58/120 | 23.06s | 2,236 MiB |
| MOSS 0.9B，BF16，SDPA | 12.79% | 56/120 | 129.95s | 1,784 MiB |

热词是岁己、小岁、栞栞、饼干岁、弥月、瑞娅；不是完整的生产房间热词配置。该组有 5 句参考编辑距离降低、0 句升高，样本中仍缺少充分的易混负例，不能推导所有同音词替换都安全。

成对 bootstrap（5,000 次，对固定字幕文件样本重抽样）得到相对当前无热词模型的 CER 差：

- 微调模型：-2.03 个百分点，95% 区间约 [-3.36, -0.80]；受训练数据重叠限制。
- Nano FP32：-2.23 个百分点，约 [-4.14, -0.47]。
- SenseVoice zh：-2.03 个百分点，约 [-4.26, 0.00]，这批数据不足以断言其稳定优于当前模型。
- MOSS：-0.13 个百分点，约 [-2.19, +2.33]，未体现明确的参考误差优势。

这些区间只反映已有小样本的差异，不包含字幕标注错误、主播/直播日期分布偏差。逐句原文、音频路径和每个模型输出在 `caption_review.tsv`。

### 真批量与时间戳的取舍

`sensevoice_pipeline.py` 的 `flush_batch()` 仅为一部分 Paraformer 路径调用批量输入；SenseVoice/Nano 会进入逐段循环。因此，提高配置里的 `batch_size_s` 不等于实现这两个模型的 GPU 批量推理。

SenseVoice 在本次样本上的 batch=1/8 CER 相同，推理从 6.76s 降到 2.23s。接入时应保留每个输入块到输出段的映射、情感标签、失败回退与资源节流，随后在长录播上复测端到端时间。

Nano 缓存模型带 CTC decoder。FunASR 在检测到该 decoder 时会退回 sequential 路径，batch=4 并未真正并行 LLM 解码。实验中移除 decoder 才进入文本批量路径，配合 BF16 降到 23.06s，约 2 倍；原始 CTC 字符时间戳也随之消失。若用于精修，应另行对齐修订文字，不能把改后的字词直接塞回原字符时间轴。

Nano 模型加载本身约 41–50s，当前生产常驻 worker 只支持 Paraformer。对于反复处理短切片，Nano 常驻模型也是比单纯扩大 batch 更值得评估的方向。

## Paraformer 参数

同一栞栞 900s 样本，1.4.14，3 次常驻中位数；“文字差异”是相对 1.4.3 原结果的编辑距离，**不是准确率下降值**。

| 配置 | 常驻耗时 | 文字差异 | 判断 |
| --- | ---: | ---: | --- |
| 当前形状：CPU VAD 60s，batch=600 | 6.26s | 0 | 保留基线 |
| batch=180 | 6.08s | 0 | 接近噪声幅度；时间轴有变化 |
| batch=1200 | 6.92s | 0 | 没有提速 |
| GPU VAD | 9.26s | 0 | 本机该样本更慢 |
| CPU VAD chunk=120s | 6.46s | 231 | 边界与文字明显变化，不宜视作等价优化 |
| VAD 最大语音段=15s | 6.42s | 47 | 无明确速度收益，需要独立准确率验证 |
| TF32 | 6.90s | 1 | 未见收益 |
| 整条 pipeline 外层 BF16 autocast | 失败 | 不适用 | `timestamp_tools.py` 报空列表 `IndexError` |

成功的测试输出均未发现负时长或越出音频边界；这只是时间轴合法性检查，不是人工对齐精度评估。BF16 失败的是上述具体实验方式，不代表所有局部混合精度方案都不可能。

### 参考声纹重复计算

虽然主 ASR、CAM++ 和情感模型可常驻，`sensevoice_paraformer.py` 的 `load_references()` 仍会在新请求中调用 `build_speaker_reference_centroids()`。实测主模型 cache hit 后仍有约 1.1s 的 `reference_embedding_s`。

实验增加了“单个固定模型、固定参考集”的进程内缓存对照：同一岁己 900s 音频的 ASR+speaker 常驻中位数从 **8.07s 降到 6.74s**，约减少 16% 的总时间；参考阶段从常驻中位数 1.137s 降到低于计时记录精度。四组对应运行的文字、时间轴及 speaker 标签均一致。端到端差值仍含运行波动，直接可确认的是参考计算被省去。

不同重复运行间出现了匿名 `SPEAKER_00/01/02` 编号重排，但置换后的分组一致。评估匿名 diarization 时必须先做标签置换匹配，不能把编号变化计为识别错误。

详见 `tune-sui-reference-cache.json` 和 `pipeline_comparison.json`。落地缓存必须把模型、参考文件版本/内容、state、截取范围、chunk 与 prototype 参数纳入失效条件，不能只按主播名字缓存。

完整情感分析需要携带 `room_id=25788785`。不带房间 ID 时会因为房间过滤跳过该阶段，所以最初的 `tune-sui-full` 只能作为 ASR+speaker 对照，真正包含情感的结果是 `tune-sui-full-room`。

包含 ASR、speaker 和情感的当前配置形状在岁己 900s 样本上，常驻中位数为 **9.81s**，约 92 倍实时。最后一次运行中，ASR/VAD/标点 pipeline 5.22s、speaker 1.50s、情感 2.33s，情感状态为 `completed`、模型 cache hit。这里未加实验性的参考缓存。

## Speaker 对照

已知身份为岁己、栞栞、瑞娅、三理、米汀、弥月；星汐和花礼作为未登记身份，未放入匹配库。复用当前 prototype 构造和 top-2 匹配，固定行阈值 0.55、runner-up margin 0.08。

下表使用 8 月 24 日以前的多状态参考。每一行都是同一批 53 个已知、8 个未知测试块的不同长度裁剪。

| 模型 | 时长 | 正确实名/53 | 已知误认 | 已知拒识 | 未知误认/8 |
| --- | ---: | ---: | ---: | ---: | ---: |
| CAM++ | 1s | 18 | 0 | 35 | 0 |
| CAM++ | 2s | 26 | 0 | 27 | 0 |
| CAM++ | 4s | 32 | 0 | 21 | 0 |
| CAM++ | 8s | 43 | 0 | 10 | 0 |
| ERes2NetV2 | 1s | 26 | 0 | 27 | 0 |
| ERes2NetV2 | 2s | 31 | 1 | 21 | 1 |
| ERes2NetV2 | 4s | 39 | 0 | 14 | 1 |
| ERes2NetV2 | 8s | 46 | 0 | 7 | 0 |

同一 480 个派生/登记音频块、batch=16、FP32 的嵌入提取：CAM++ 3.49s、Tensor 峰值 468 MiB；ERes2NetV2 4.05s、2,133 MiB。该计时从已解码音频开始，包含特征提取，排除模型加载；没有并行运行两个 GPU 模型。

### 跨日期参考与阈值

仅使用早期基础参考，对留出的栞栞 8 月 24 日 24 个 8s 块，CAM++ 正确实名 9 个。加入此前的兴奋游戏、近期聊天、唱歌等独立参考状态后，为 17 个；ERes2NetV2 对应为 12 个（另有 2 个误认）到 19 个（0 误认）。多状态参考的收益比本次直接换模型的差值更明显。

校准集独立于测试集，且不含 8 月 24 日素材。以误认代价为拒识的 5 倍搜索阈值后，CAM++ 选出了 margin=0.04：8s 测试正确实名 43 → 45，但未知误认 0/8 → 2/8。**少几个 UNKNOWN 不等于更准确。** 8 个未知测试块太少，0 次误认也不能证明真实误认率为零。

建议保留开放集拒识；为短句累积同一说话人、无重叠的声学证据，避免跨说话人边界强行拼接。参考素材继续按日期、麦克风、聊天/激动/唱歌等状态管理，并用未来日期验证。

### 联动区分与实名是两层问题

本次数值主要验证“这段声音能否认成某个主播”。真实联动还需要解决“何时换人、是否重叠、同一匿名 speaker 是否被拆散”，应建立带说话人和重叠标记的真实直播真值，再测 DER、speaker confusion 和按 speaker 对齐的 CER。

MOSS 0.9B 在真实四人联动 120s 上输出 51 段、4 个匿名 speaker，并允许重叠时间段。推理 68.12s，约 1.76 倍实时，Tensor 峰值 2,389 MiB，无生成长度截断。**输出四个编号不是已经证明识别正确**；当前没有逐段 speaker 真值，未计算 DER。

`moss/pilot.speaker.srt`、原音频和 `moss/speaker_annotation_template.tsv` 可用于下一步复核。模板的人工列为空、`reviewed=false`，模型输出未被冒充为真值。

## 其他候选

- [Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)：官方提供 0.6B/1.7B 与独立 ForcedAligner。未进行本机模型实测。当前 `qwen-asr==0.0.6` 明确要求 `transformers==4.57.6`，与本机 5.9.0 不同，应使用独立环境；官方高并发吞吐不能直接套到单路直播。
- [pyannote community-1](https://github.com/pyannote/pyannote-audio)：适合补充真正的 diarization/重叠处理候选。官方要求接受模型使用条件并使用 Hugging Face token；本次模型访问返回受限，未做实测。
- [MOSS 官方代码](https://github.com/OpenMOSS/MOSS-Transcribe-Diarize)：本次固定代码 `cb765f2b0fe6f7a298aa2002e2281ae693d1f3c3`、模型 `e8681d68e7042738ffca8ac8212bc8fcb1131ab8`，本地 BF16/SDPA 推理。未测试 vLLM、SGLang 或量化版本。
- [ERes2NetV2 官方模型卡](https://modelscope.cn/models/iic/speech_eres2netv2_sv_zh-cn_16k-common)：官方 CN-Celeb EER 为 3.81%，CAM++ 为 4.32%；这是官方数据集指标，与本报告的直播身份识别指标不同。

## 产物与复现

实验目录：`tmp/asr-research-20260906/`。包含固定抽样清单、每个配置、逐次日志、原始输出、字幕与统计结果；大型模型仅在该隔离目录。

脚本放在仓库约定的 `local-scripts/`，与 `tmp/` 一样被 Git 忽略，本机可以直接复跑：

```powershell
python local-scripts/asr_research_20260906.py prepare
python local-scripts/asr_research_20260906.py run --filter pipeline-,tune-,labels-
python local-scripts/speaker_research_20260906.py cam
python local-scripts/speaker_research_20260906.py eres
python local-scripts/moss_research_20260906.py pilot --input tmp/asr-research-20260906/collab-600-720.wav
python local-scripts/moss_research_20260906.py labels
python local-scripts/analyze_asr_research_20260906.py
```

ASR runner 会跳过已经存在的结果，避免误覆盖实验记录。若修改配置，应给新实验一个新 ID。ERes2NetV2 缺少的 `addict==2.4.0` 也只安装在 `packages/speaker-support/`。

核心产物：

- `validation_manifest.json`：抽样规则、音频路径与训练重叠审计。
- `caption_review.tsv` / `caption_comparison.json`：逐句对照、CER 与成对区间。
- `pipeline_comparison.json` / `results/*.json`：常驻重复、分阶段耗时、显存、文本与时间轴变化。
- `speaker/corpus.json` / `speaker/*.summary.json` / `speaker/*.rows.json`：声纹分割、拒识/误认与逐块结果。
- `moss/pilot.json` / `moss/labels.json`：联合模型的完整结果。

下一步最有价值的验证是建立按原直播和日期隔离的人工真值小集，覆盖清晰聊天、游戏背景音、喊叫/唱歌、短句、多人轮流与重叠发言，再复核优先项的端到端收益。

本次已核验：28 个 ASR 配置结果（27 个成功、1 个明确记录的整链 BF16 失败实验）；包括 MOSS 在内的 14 组模型输出均对应同一份 120 句参考；两种 speaker 模型的测试分割一致；四个复跑脚本通过 Python 语法检查。未运行与本次报告无关的整仓测试。
