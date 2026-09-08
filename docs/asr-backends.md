# ASR Backend 配置

> **当前状态（2026-07-16）**：默认 backend 是 `paraformer`，生产 Paraformer 已启用 post-ASR adaptive speaker（`enable_speaker: true`、`speaker_detection_mode: "auto"`）。本页是 ASR 当前架构和验证的权威文档；具体部署值仍以 `config/default.json`、`config/production.json` 与 `DEFAULT_ASR_CONFIG` 为准。

项目支持 Paraformer、Whisper、SenseVoice、Fun-ASR-Nano 和 Fun-ASR-Nano vLLM。Nano 的热词接口是官方 `hotwords: list[str]`，更适合做“岁己 / 小岁”这种词的真实热词测试。

岁己房间的生产 Paraformer 流程还支持后置 SenseVoiceSmall 情感分析。它复用 Paraformer 时间轴，不重复 VAD/标点，并把结果提供给晚安回复、漫画脚本和自动切片。配置、输出契约与评分规则见 [sui-emotion-analysis.md](./sui-emotion-analysis.md)。

## 默认 Paraformer 与显式 Whisper

当前默认配置的核心形状：

```json
{
  "asr": {
    "default_backend": "paraformer"
  }
}
```

命令行显式指定：

```powershell
node src/scripts/enhanced_auto_summary.js "D:/path/to/video.flv" --asr-backend paraformer
node src/scripts/enhanced_auto_summary.js "D:/path/to/video.flv" --asr-backend whisper
```

Whisper 仍调用 `src/scripts/python/batch_whisper.py`，保留原有 GPU 等待、重试和 SRT 生成逻辑。主程序会把生成的 SRT 解析为统一 ASR 结果，再走统一字幕 normalize/write 流程。

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

## 启用 SenseVoice（显式关闭 speaker 的最小示例）

下面用于展示一个主动关闭 speaker 的独立 SenseVoice 配置。若省略 `spk_model` / `enable_speaker`，脚本侧 `DEFAULT_ASR_CONFIG` 当前会补入 `"cam++"` / `true`；最终值必须检查 live config 与默认合并结果。

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
      "inference_batch_size": 8,
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

从 2026-09-06 起，SenseVoice 的 `inference_batch_size` 默认是 8，表示真正送入模型的最大音频段数。每批还受 `batch_size_s` 和 GPU 压力限制，按最长段乘段数限制 padding 占用；每个输出仍使用对应输入的时间区间。批量调用失败或结果数量/格式不匹配时，当前请求自动退回逐段处理。需要原来的逐段行为时设为 `1`。`timings` 中的 `sensevoice_batch_calls`、`sensevoice_single_calls`、`sensevoice_batch_fallbacks` 可用于核查实际执行路径。

批量计算不承诺逐字与单段计算一致；参考集 CER 相同也不能证明长录播的文字和事件完全一致。上线前应使用独立录播比较文字、时间轴、speaker 和情感结果。

`scripts/benchmark_asr_optimizations.py` 可比较批量 SenseVoice 和常驻 Paraformer 的参考缓存；通过 `--sensevoice-audio`、`--paraformer-audio`、可选 `--reference-manifest` 指定输入，并用 `--output-dir temp/<日期>-<任务>/asr-benchmark` 保存结果。该工具采用固定的对照配置和房间选择，运行前应核对与素材的匹配关系；单次日志、指纹和结果报告不提交到 `docs/`。

### 中文疑句的局部复听

中文切片的疑句复听优先使用已配置的 FunASR-family 模型。先区分项目的字幕分段路径与
[SenseVoice 官方示例](https://github.com/QwenAudio/SenseVoice)：项目会在 VAD 合并后通过
`max_vad_segment_s` 和 `asr_max_segment_s` 再限制转写块，后者未配置时默认8秒。
因此只增大 `merge_length_s` 不等于改用了官方长语音调用方式。

短音频严格控制在30秒以内时，可以不加载VAD，让完整问答进入一次推理：

```python
from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess

model = AutoModel(model="iic/SenseVoiceSmall", device="cpu", ncpu=2, disable_update=True)
result = model.generate(
    input="under_30s.wav", cache={}, language="zh", use_itn=False, batch_size=1,
)
print(rich_transcription_postprocess(result[0]["text"]))
```

这是独立转写示例，不触发选材、通知或上传。使用匹配本地CUDA环境且当前负载允许的GPU时，
可换用 `device="cuda:0"`。`ncpu` 应显式传入：FunASR模型构造会设置PyTorch线程数，
不能仅凭构造前的 `torch.set_num_threads` 判断整个流程的实际线程上限。
使用安装包已注册的SenseVoice实现时无需指定 `remote_code`；如按官方仓库示例加载自定义实现，
必须给出真实存在的 `model.py` 路径，并记录实际加载的实现，不能混淆两种来源。

较长音频的官方VAD配方为构造时 `vad_model="fsmn-vad"`、
`vad_kwargs={"max_single_segment_time": 30000}`，推理时
`cache={}`、`language="auto"`、`use_itn=True`、`batch_size_s=60`、
`merge_vad=True`、`merge_length_s=15`。合并参数不是强行切成15秒；实际VAD边界要检查输出。
短窗起止位置也会改变识别，不能认为多给上下文必然更准确。

局部复听保留原始模型输出、音频哈希与源时间区间；不提供希望模型听到的答案。
ITN开关用于对照，不保证关闭后每个口吃或改口都更准确。
只有整段文本、没有可靠词级时间戳时，将结果作为补充证据，不自动覆盖原SRT或重分配说话人。
SenseVoice的情绪/声音事件标签不是speaker身份；匿名speaker需要单独的CAM++等模型，
真人姓名仍需声纹参考或独立身份线索。

复听的验收应同时记录转写内容、切块边界和剩余歧义。不同ASR对同一段音频给出相近字词，
不等于独立证实同一种语义；更多上下文或不同ITN设置也不保证能恢复口吃、否定或自我修正。
不要提供希望听到的答案，也不要把重复推理的一致性当作人工听审或独立标注。
比较耗时时分开模型加载、标点加载与实际推理，并核实构造后的线程数；
旧流程的冷启动总时长不能直接与已加载模型的一次推理比较。记录局部有效结果，但不足以推广时保持原生产配置。

## 启用 Fun-ASR-Nano

这个 backend 适合做热词验证，因为官方模型代码明确支持 `hotwords=["..."]`，热词会直接进入 prompt。

```json
{
  "asr": {
    "default_backend": "fun_asr_nano",
    "fun_asr_nano": {
      "model": "FunAudioLLM/Fun-ASR-Nano-2512",
      "vad_model": "fsmn-vad",
      "punc_model": null,
      "spk_model": null,
      "language": "中文",
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
node src/scripts/enhanced_auto_summary.js --asr-backend fun_asr_nano "D:/path/to/video.flv"
```

Fun-ASR-Nano 走同一个 `src/scripts/python/sensevoice_transcribe.py` 入口，但会按 `backend=fun_asr_nano` 切到 `hotwords` 列表接口。

## Paraformer + post-ASR CAM++

当前推荐生产路线是两阶段 pipeline：

1. `sensevoice_paraformer.py::transcribe_paraformer_builtin` 构造 Paraformer + FSMN-VAD + punctuation 的主 `AutoModel`，故意不把 `spk_model` 放入主 `generate()`。
2. 主 pipeline 先完整生成文本、时间戳和 `sentence_info`。
3. 启用 speaker 时，单独缓存的 CAM++ 模型再调用 `sensevoice_speaker.py::run_adaptive_speaker_engine`，把时间线标签投影回句子和切分后的字幕。

因此正常运行时，主 Paraformer timing 中内建 `spk` 应为 `0.000s`，自适应 speaker 的 probe/full/reference timing 会在后续阶段单独记录。

```powershell
node src/scripts/enhanced_auto_summary.js "D:/path/to/video.flv" --asr-backend paraformer
```

当前生产要点：

- `default_backend: "paraformer"`。
- `enable_speaker: true`、`speaker_detection_mode: "auto"`；普通单人直播先做低成本 probe，不再默认完整跑 CAM++ 聚类。
- `vad_max_single_segment_time_ms: 60000` 交给 FunASR 内建 VAD，避免 8 秒手动切片切断词和句子上下文。
- `batch_size_s` 是动态批次允许容纳的总音频秒数；`batch_size_threshold_s` 会把超长 VAD 段降为单条，控制显存峰值。
- `vad_device: "cpu"` 只把 FSMN-VAD 放在 CPU；Paraformer 和标点仍在主 CUDA device，CAM++ 是独立模型。
- 当前 JS adapter 不向 Paraformer `generate()` 传入 `hotword`；配置词条由 `phoneme_correction` 和统一 corrections 处理。Fun-ASR-Nano / vLLM 路径当前才会在推理时传入 `hotwords`。

中央 Mikufans 队列会启动一个仅监听 `127.0.0.1`、带随机令牌的 Paraformer 常驻 worker。连续任务复用主模型、标点和独立 CAM++ cache；队列清空或父队列检测到 GPU 繁忙时终止 worker并释放显存。单独运行 `enhanced_auto_summary.js` 时会先尝试 worker，连接不可用则回退到一次性 Python 进程。

常驻 worker 现在也复用参考声纹 prototypes，`timings.reference_cache_hit=1` 表示本次命中。缓存只保留最近一组，绑定实际 speaker 模型实例、device、参考配置、所有参考文件的 SHA-256 内容摘要和提取/prototype 参数。修改参考内容（即使大小与 mtime 未变）、名字、state、截取区间或相关参数后会重建；失败、不完整嵌入或提取过程中被替换的参考不会缓存。匹配阈值变化不需要重新提取声纹。worker 释放时一并清空，不写持久化 embedding 文件。

### Adaptive speaker 状态机

当前 FunASR-family 路径最终复用 `run_adaptive_speaker_engine` 的 probe/full 聚类决策。各 backend 的模型加载、speech interval 构造、结果投影和错误处理仍分别位于 `sensevoice_paraformer.py`、`sensevoice_pipeline.py` 和 vLLM worker；backend integration 任务必须继续检查对应适配层。

`auto` 模式遵守这些稳定规则：

1. 以 FSMN-VAD speech intervals 为外层语音区间，再使用 Paraformer 最终字幕/字符时间戳作为区间内边界，生成按时间排列、互不重叠的真实候选句段。正常句段保留原边界；只有超过 `speaker_max_segment_s` 的异常长段才做兜底拆分，因此这里不是固定 2 秒或 4 秒滑窗。
2. probe 在**累计有效语音时长**上做确定性分位采样，而不是按录播墙钟时间随机抽样。`speaker_probe_max_chunks=256` 是最多均匀抽取 256 个真实候选句段，不是把整场切成 256 段，也不是固定时长。
3. 对同一批 probe embeddings 用主阈值和确认阈值各聚类一次；不传 `preset_spk_num`，避免用预设人数充当答案。
4. 结果为 `single`、`multiple` 或 `inconclusive`。只有满足最小有效 chunk、语音时长和双阈值稳定性的可信 `single` 会设置 `status=skipped_single_speaker` 并跳过完整处理。
5. `multiple` 和 `inconclusive` 都进入完整处理；probe 报错时默认 `speaker_probe_fail_open=true`，同样进入完整处理，宁可多算也不把未知误判成单人。
6. 稳定的多人 probe 可将受支持的探测簇作为固定 K 初值，并在全量 embeddings 上迭代更新中心；probe embeddings 会被复用，只计算剩余句段。证据不足时仍回退到完整聚类。
7. reference prototypes 仅在完整聚类后需要实名匹配时延迟加载。同一主播可登记多个 `state`，各状态先独立过滤离群样本并构建一个或多个受支持原型，最终由同一主播名共同参与匹配。
8. 完整成功为 `status=full_completed`。speaker 阶段失败返回空 speaker timeline 与 `status=failed`，但保留已经完成的 ASR 文本。

`always` 模式跳过 probe，直接完整聚类和 reference matching；speaker-once 请求会强制使用该模式。所有任务都让当前 backend 配置的完整参考库参与竞争，planned roster 只保留为预期参与者和回归评估元数据，不过滤参考库，也不把房主设为唯一可接受实名。cluster 和逐句匹配必须同时满足绝对分数、runner-up margin、最小重复支持数及支持率；证据不足时保留匿名 `SPEAKER_nn`，不会硬套成 roster、房主或最接近的已知主播。

启用了 `preferSpeakerReviewSrtWhenMultipleSpeakers` 的房间，只要最终字幕中出现至少两个不同的有效 speaker label，就把 `.speaker.srt` 交给 fusion summary 和晚安生成。匿名 `SPEAKER_nn` 也算独立说话人，因此“房主 + 未实名嘉宾”的自我介绍会以不同标签进入 AI；这不会把匿名标签加入实际出声主播名单，也不会触发多参考图。

关键 `speaker_processing` 字段：

- `mode`、`status`、`decision`、`reason`、`full_run`
- probe sampled/valid chunk 数、sampled speech、检测/支持 cluster 数
- `probe_embeddings_reused`
- `speaker_processing.timings` 中的 probe/full embedding、clustering、reference matching、reference embedding 和 `total_s`

ASR 结果顶层 `timings.postprocess_s` 是统一字幕后处理阶段，不属于 `speaker_processing.timings`。

真实 vLLM adaptive speaker 路径目前仍未在本机完成端到端实测；代码与错误路径可测试，但不要把它写成已验证的运行能力。

### 下一场直播强制完整说话人识别

生产普通任务使用 adaptive `auto`。发现明确多人联动时，可以按房间号或 `ai.streamerRegistry` 中的主播名，为该直播间下一个尚未开始的 ASR 任务强制 `always` 完整处理：

```powershell
npm run asr:speaker-once -- enable "栞栞" --requested-by openclaw --reason "多人联动"
npm run asr:speaker-once -- enable "栞栞" --start-at "2026-07-16T20:00:00+08:00" --window-hours 24 --requested-by openclaw --reason "多人联动预告"
npm run asr:speaker-once -- status
npm run asr:speaker-once -- cancel "栞栞" --requested-by openclaw
```

不带时间时，请求默认 24 小时过期，也可以用 `--expires-hours 48` 修改。带 `--start-at` 时，匹配直播结束入队时间位于 `--start-at` 起 `--window-hours`（默认 24）小时内的第一场直播；窗口前结束的直播不会消耗请求，窗口内入队但因队列积压而较晚执行的任务仍能正确匹配。任务执行前会认领请求并把结果固化到队列任务；本场强制使用 Paraformer + CAM++、`speaker_detection_mode=always`，标点保持开启，完成后后续任务恢复全局 `auto`。已经开始 ASR 的任务不能中途切换。

运行时状态保存在忽略版本控制的 `data/runtime/asr-speaker-once.json`。应通过上述 CLI 操作，不要为单场任务编辑生产配置或重启服务。

Paraformer/SenseVoice/Nano 任务会在日志和同名 `.asr_meta.json` 中记录可用的模型、VAD、ASR、标点和 adaptive speaker 状态/耗时，慢 ASR 企微提醒也会附带解析到的分项。Whisper 不提供同等阶段 timing；若已有 `.srt` 被复用，主流程会跳过 ASR，也不会为这次复用新写完整 ASR metadata。reference matching 按完整聚类抽样批量计算，不为几千句字幕逐句调用 CAM++。

## 启用 Fun-ASR-Nano vLLM

FunASR 官方 vLLM 文档推荐 `AutoModelVLLM` 做批量推理，也支持 `hotwords=["张三", "北京"]`。本项目使用同包内的 `FunASRNanoVLLMPipeline` 完成转写，但显式关闭其内建 speaker 返回，再调用共享的 post-ASR adaptive CAM++ engine；输出仍转换成统一 ASR JSON。

参考：

- FunASR vLLM guide: https://github.com/modelscope/FunASR/blob/main/docs/vllm_guide.md
- FunASR overview: https://funasr.com/en/
- vLLM GPU install: https://docs.vllm.ai/en/latest/getting_started/installation/gpu/

```json
{
  "asr": {
    "default_backend": "fun_asr_nano_vllm",
    "fun_asr_nano_vllm": {
      "model": "FunAudioLLM/Fun-ASR-Nano-2512",
      "vad_model": "fsmn-vad",
      "spk_model": "cam++",
      "language": "中文",
      "device": "cuda",
      "python_executable": null,
      "python_args": [],
      "use_itn": true,
      "enable_speaker": true,
      "hub": "ms",
      "dtype": "bf16",
      "tensor_parallel_size": 1,
      "gpu_memory_utilization": 0.8,
      "max_model_len": 4096,
      "batch_size_s": 300
    }
  }
}
```

临时指定：

```bash
node src/scripts/enhanced_auto_summary.js --asr-backend fun_asr_nano_vllm "D:/path/to/video.flv"
```

当前本机 Python 环境已安装 `funasr`，但尚未安装 `vllm`。使用该 backend 时，如果缺少 `vllm`，脚本会明确报错并建议先切回 `fun_asr_nano` 或 `sensevoice`。安装 vLLM 前要确认它和当前 PyTorch/CUDA 版本匹配。

环境检查：

```bash
npm run asr:vllm-doctor
```

需要机器可读 JSON 时，建议直接调用 node 入口，避免 npm run 的横幅混入 stdout：

```bash
node src/scripts/asr/asr_vllm_doctor.js --json
```

vLLM 官方文档明确说明不原生支持 Windows，Windows 上建议使用 WSL / Linux 环境或社区 fork。当前 Windows / Python 3.12 环境下，`pip install --dry-run "vllm>=0.12.0"` 可以解析到 `vllm-0.22.0.tar.gz`，但不是现成已安装包；真实安装可能需要本机源码构建。若 doctor 显示 `vllm` 缺失，`fun_asr_nano_vllm` backend 和 vLLM 队列 worker 都会保留清晰失败，不会静默 fallback。

本机实测补充：

- `python -m pip install --dry-run --only-binary=:all: vllm==0.22.0` 找不到 `cp312-win_amd64` wheel。
- `ubuntu2204.exe install --root` 失败 `0x80370114`。
- Docker Desktop 日志显示 `Virtual Machine Platform not enabled`。
- 因此当前不能在非管理员 shell 内完成 vLLM 安装；需要先以管理员启用 Windows WSL/VMP 功能并重启。

已提供安装脚本：

```powershell
# 1. 管理员 PowerShell 执行，然后重启 Windows
powershell -ExecutionPolicy Bypass -File tools/setup_vllm_wsl.ps1 -EnableWindowsFeatures

# 2. 重启后在普通 PowerShell 继续
powershell -ExecutionPolicy Bypass -File tools/setup_vllm_wsl.ps1 -InstallDistro -InstallPythonEnv -WriteConfigSnippet
```

第二步会注册 `Ubuntu-22.04`，在 WSL 内创建 `/opt/asr-vllm`，安装 `vllm/funasr/modelscope`，并写出 `tmp/asr-vllm-wsl-config-snippet.json`。

如果要把 vLLM 放在独立环境里，可以只给 vLLM backend 指定 Python，不影响 SenseVoiceSmall：

```json
{
  "asr": {
    "fun_asr_nano_vllm": {
      "python_executable": "D:/venvs/asr-vllm/Scripts/python.exe",
      "python_args": [],
      "python_path_map": []
    }
  }
}
```

也可以临时用环境变量覆盖：

```powershell
$env:ASR_PYTHON = 'D:\venvs\asr-vllm\Scripts\python.exe'
npm run asr:vllm-doctor
```

如果使用 WSL/Linux Python，需要同时把 Windows 路径映射到 Linux 挂载路径：

```json
{
  "asr": {
    "fun_asr_nano_vllm": {
      "python_executable": "wsl.exe",
      "python_args": ["python3"],
      "python_path_map": [
        { "from": "D:/", "to": "/mnt/d/" },
        { "from": "C:/Users/yuiffy", "to": "/mnt/c/Users/yuiffy" }
      ]
    }
  }
}
```

`python_path_map` 会应用到 Python 脚本路径、`audio_path`、`speaker_references[].audio_path` 等路径字段。

## 按主播或房间灰度

```json
{
  "asr": {
    "default_backend": "paraformer",
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

- `aliases`: 旧格式兼容，作为 safe corrections；在接收模型热词的 Nano/vLLM backend 也会作为 prompt 候选。`safe` 默认做词保护：如果来源词被识别成更长中文词条的一部分（例如 `粉碎机` 里的 `碎机`），会优先保留整词。
- `protect: false`: `safe` 规则/alias 的可选逃生口；默认 `safe` 替换会做词保护，只有显式设为 `false` 才恢复旧的子串替换行为。
- `aliases_as_hotwords: false`: 只把 `aliases` 用作后处理修正，不送进模型热词。适合 `碎机`、`碎即`、`岁几` 这类“错误识别形态”，避免模型被错误词反向提示。
- `hotword_terms`: 作为模型 prompt 候选但不会自动改写字幕；当前只有接收 `hotwords` 的 Nano/vLLM backend 会在 inference 使用，其他 backend 仍可通过 corrections/phoneme correction 处理。
- `contextual_aliases`: 只生成 contextual corrections，文本中命中 `require_nearby` 任一关键词时才替换。
- `ambiguous_aliases`: 只生成 ambiguous corrections，适合 `岁吉`、`碎几` 这类高歧义同音词；默认要求附近存在 `require_nearby` 提示词，并按局部 token 窗口判断，避免误伤普通词语。
- `corrections.safe`: 显式安全替换，等价于旧的 corrections 对象/数组。
- `corrections.contextual`: 显式上下文替换，必须配置 `require_nearby`，否则不会执行。
- `corrections.ambiguous`: 显式高歧义替换；默认按局部 token 上下文生效，适合需要“只改靠近主播语境的那一次出现”的情况。
- `context_window_tokens`: `contextual/ambiguous` 可选字段；限制 nearby 关键词与待替换词之间允许相隔多少个 token，默认 6。
- `match_mode`: `ambiguous` 可选字段；`token` 表示按局部 token 窗口判断，`transcript` 表示只要全文存在 nearby 关键词就允许替换。
- `boundary_sensitive`: `ambiguous` 可选字段；默认 `true`，避免把命中的别名嵌在更大词片段中时也替换掉。
- `corrections.exclude_when`: 为指定来源词配置保护短语；来源词出现在这些短语中时不替换。比如 `{ "小碎": ["小碎步"] }` 可保留“小碎步”，但仍会把独立的“小碎”改成“小岁”。
- `corrections.exclude_pattern`: 用正则模式保护指定上下文；当来源词与这些模式有重叠时不替换，适合比 `exclude_when` 更宽的片段保护。
- `phoneme_correction`: Paraformer/SenseVoice 的音素热词纠错。下发给 Python 时会自动带上当前 `corrections.exclude_when` / `exclude_pattern`（例如 `碎机 -> [粉碎机]`），并默认开启与 JS `safe` 相同的 jieba 分词边界保护（`boundary_protect`，可设 `false` 关闭）。保护词只维护在 `exclude_when`，不另外配一套白名单。
- `phoneme_correction.cross_segment_protect_when_next`: 显式配置只在指定后续前缀出现时启用的跨 segment 保护，例如 `{ "小睡": ["一会"] }`。只有稳定实名说话人不冲突、时间间隔不超过 `cross_segment_protect_max_gap_s`（默认 `0.3` 秒）的相邻段会参与；`UNKNOWN` / `SPEAKER_nn` 等低置信标签不会阻断。匹配时忽略边界标点和空白，所以 `小睡。| 一会儿` 会保护“小睡”，独立“小睡”仍正常纠正。

对于 `fun_asr_nano` 和 `fun_asr_nano_vllm`，模型提示词会整理成 `hotwords: ["岁己", "岁己SUI", "小岁", ...]` 直接喂给模型；`aliases_as_hotwords: false` 的错误别名只进入后处理修正。当前 JS adapter 对 Paraformer/SenseVoice 留空模型 hotword 字段，依赖 `phoneme_correction` 与统一 corrections。

后处理会先执行 `safe`，再执行 `contextual`，最后执行 `ambiguous`。其中 `safe` 默认会做词保护，避免把命中的 alias 嵌在更大的词里时也直接改写；如果环境安装了 `@node-rs/jieba`，会优先用它做中文分词来判断词边界，否则回退到内置轻量 token 切分。`ambiguous` 则继续优先按局部 token 上下文判断。

下例只展示字段形状，不是生产词表或 routing 快照。实际 `common_hotwords`、corrections 和房间 route 只以当前 `config/default.json` / `config/production.json` 为准。

```json
{
  "asr": {
    "common_hotwords": [
      {
        "word": "岁己",
        "weight": 20,
        "aliases_as_hotwords": false,
        "aliases": ["岁己SUI"],
        "hotword_terms": ["小岁", "岁己姐"]
      }
    ],
    "corrections": {
      "safe": [
        { "from": "岁己SUI", "to": "岁己" }
      ],
      "contextual": [
        { "from": "穗姐", "to": "岁己", "require_nearby": ["小岁", "前辈"] }
      ],
      "ambiguous": [
        {
          "from": "岁吉",
          "to": "岁己",
          "require_nearby": ["小岁", "前辈"],
          "context_window_tokens": 6,
          "match_mode": "token",
          "boundary_sensitive": true
        }
      ]
    },
    "routing": [
      {
        "match": { "room_id": "example-room-id" },
        "backend": "paraformer",
        "hotwords": [
          { "word": "示例专名", "weight": 20 }
        ]
      }
    ]
  }
}
```

当前 dispatch 行为：Fun-ASR-Nano / vLLM 会在推理时接收 `hotwords` 数组；Paraformer/SenseVoice 的 `hotword` 字符串当前由 JS adapter 留空，依赖 `phoneme_correction` 与统一 corrections。所有 backend 的 SRT 写出前都会应用 corrections。

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

## 说话人处理配置与输出

所有 FunASR-family backend 共用上一节的 post-ASR adaptive engine；各 backend 可分别决定是否启用。生产主路径是 Paraformer `enable_speaker=true` + `speaker_detection_mode=auto`。SenseVoice/Nano 也可配置同一组 CAM++、阈值和 references，但不等于生产默认 route。

参考声纹示例：

```json
{
  "asr": {
    "sensevoice": {
      "enable_speaker": true,
      "spk_model": "cam++",
      "speaker_references": [
        {
          "speaker": "岁己SUI",
          "audio_path": "D:/path/to/sui_single.wav",
          "chunk_s": 8,
          "max_chunks": 20
        },
        {
          "speaker": "栞栞",
          "audio_path": "D:/path/to/shiori_single.wav",
          "chunk_s": 8,
          "max_chunks": 20,
          "state": "calm_chat"
        },
        {
          "speaker": "栞栞",
          "audio_path": "D:/path/to/shiori_excited_game.wav",
          "chunk_s": 8,
          "max_chunks": 20,
          "state": "excited_game"
        }
      ],
      "speaker_reference_threshold": 0.45
    }
  }
}
```

仓库内的默认参考音频登记在 `data/asr_speaker_refs/manifest.json`，对应目录说明见 `data/asr_speaker_refs/README.md`。参考库不是某场联动的白名单；已登记且满足质量要求的主播始终共同参与开放集匹配。当前生产参考包括：

- 岁己 -> `data/asr_speaker_refs/sui.wav`
- 栞栞平静聊天 -> `data/asr_speaker_refs/shiori.wav`
- 栞栞激动游戏 -> `data/asr_speaker_refs/shiori_excited_game.wav`
- 栞栞近期聊天/变声状态 -> `data/asr_speaker_refs/shiori_recent_solo.wav`, `data/asr_speaker_refs/shiori_recent_august.wav`, `data/asr_speaker_refs/shiori_recent_august_alt.wav`, `data/asr_speaker_refs/shiori_recent_august_24.wav`, `data/asr_speaker_refs/shiori_august_24_fragmented.wav`
- 栞栞唱歌状态 -> `data/asr_speaker_refs/shiori_singing.wav`, `data/asr_speaker_refs/shiori_singing_august_24.wav`
- 瑞娅 -> `data/asr_speaker_refs/rhea.wav`
- 三理 -> `data/asr_speaker_refs/mit3uri.wav`
- 米汀 -> `data/asr_speaker_refs/miting.wav`
- 弥月 -> `data/asr_speaker_refs/mizuki.wav`

参数说明：

- `enable_speaker`: backend 的 master switch。
- `speaker_detection_mode`: `auto` 先 probe；`always` 强制完整处理。
- `spk_model`: 当前使用 `"cam++"`；模型与主 Paraformer 分开缓存。
- `preset_spk_num`: 保留兼容字段，但当前 adaptive probe/full clustering 不把它作为 oracle speaker count。
- `speaker_merge_threshold`: 聚类合并阈值，当前默认 `0.78`；具体生产值以 config 为准。
- `speaker_references`: 可选已知单人音频；完整处理选中后才延迟构建 prototypes。同一 `speaker` 可用不同 `state` 登记多份参考，以覆盖平静、激动、游戏麦等稳定声学状态。
- `speaker_reference_threshold` 与 `speaker_reference_margin`: 约束 cluster 最佳分数和相对第二名的 margin；`speaker_reference_min_support_chunks` 与 `speaker_reference_min_support_ratio` 进一步要求多句重复证据。
- `speaker_reference_prototype_*`: 控制每个状态内的离群过滤、原型合并和最大原型数；当前生产上限为 10，以覆盖同一主播的多个声学状态。单个状态只有一条样本时不会独立形成受支持原型；仅有一条参考的旧配置仍保留兼容回退。
- `speaker_row_reference_threshold` 与 `speaker_row_reference_margin`: 逐句实名门槛。已实名 cluster 也不会无条件覆盖内部所有短句，避免混说、游戏语音或聚类污染被批量实名。
- `speaker_reference_consensus_*`: 用已确认的同名参考簇补足声学过分裂；普通共识默认中心相似度门槛为 `0.60`，极弱但与高置信同名簇接近的碎片另需当前生产配置中的 `0.70` 锚定相似度、至少一块直接证据、分数和 margin 门槛。所有参考说话人仍同时竞争，证据不足继续匿名。
- `speaker_constrain_to_references`: 保留兼容字段；当前 JS adapter 明确传 `false`。未知声音保留 `SPEAKER_nn`，planned roster 不改变这一开放集行为。

这是 speech-chunk 级聚类和句子级 dominant-overlap 投影，不做逐词级重叠说话分离。多人同时说话、背景音、变声、距离麦克风差异大时仍可能过分裂、合并或变为 `UNKNOWN`；应通过 metadata 和 review SRT 复核。

## ASR 输出与通知契约

统一数据链：

```text
Python speaker_processing
  -> asr_backends.normalizeAsrResult()
  -> enhanced_auto_summary.js: [[ASR_TIMING]] + .asr_meta.json
  -> MikufansWebhookHandler 慢 ASR 监控
  -> DelayedReplyService 完成通知
```

操作证据与下游语义用途不同：

- `<base>.asr_meta.json`：backend/model、总耗时、各阶段 timing 和完整 `speakerProcessing` 决策；完成通知从这里读取。
- `[[ASR_TIMING]]`：父队列解析的机器可读日志；慢 ASR 提醒从这里读取。
- `<base>.asr_speakers.json`：按 speaker 汇总的时长、分数、planned/actual participants 和 streamer IDs；融合、clip 与漫画使用它。
- `<base>.srt`：始终不带 speaker 前缀，保持旧融合/发布流程兼容。
- `<base>.speaker.srt`：单独的人工 review 字幕；有 label 时写 `[speaker score]` 前缀。

判断是否完整跑过 speaker 必须看 `speakerProcessing.status` / `full_run`，不能只用某个 timing 是否非零推断。常见 status：

- `disabled`：backend 未启用 speaker。
- `skipped_single_speaker`：auto probe 可信单人，未跑完整聚类和 reference matching。
- `full_completed`：完整处理成功。
- `failed`：speaker 阶段失败，ASR 文本仍保留。

`enhanced_auto_summary.js` 在 ASR 结束后发出 `[[ASR_PHASE_DONE]]`；父队列此时可释放 ASR 槽位，但融合、AI、clip、漫画和回复仍可能继续运行。

## ASR speaker summary 与多参考图

ASR 完成后会在 SRT 同目录 best-effort 写出 speaker sidecar：

```text
xxx.srt
xxx.speaker.srt
xxx.asr_speakers.json
```

普通 `xxx.srt` 始终不带说话人标签，适合原有融合/发布流程。只要 normalized ASR 结果里有 speaker label，就会额外写 `xxx.speaker.srt` 作为人工 review 用字幕。这个文件会强制在每条字幕前标注 `[speaker score]`，例如 `[栞栞 0.53]`；标签前缀不会被自动换行拆开。后续生图逻辑不依赖人工 review 文件。

格式示例：

```json
{
  "input": "xxx.m4a",
  "backend": "sensevoice",
  "hostRoomId": "25788785",
  "speakers": [
    {
      "label": "岁己SUI",
      "totalSpeechSeconds": 1234.5,
      "segmentCount": 320,
      "avgScore": 0.72,
      "maxScore": 0.91,
      "isUnknown": false
    }
  ],
  "appearedStreamerIds": ["sui", "shiori"],
  "extraAppearedStreamerIds": ["shiori"]
}
```

`appearedStreamerIds` 只来自 ASR segment 中真实识别到的 known speaker。字幕文本里提到某个主播名字，不会自动加入参考图；mentioned streamers 可以作为后续上下文能力预留，但默认不参与生图。

参考簇共识只用于补足弱声学簇：弱簇必须自行满足最低分数、margin、重复支持和簇中心相似度，并且与已经高置信识别出的同名参考簇一致，才会获得该实名标签。没有这些独立证据的 `SPEAKER_nn`/`UNKNOWN` 簇保持匿名；房间是否单主播不会改变说话人判定，也不会覆盖有重复证据指向其他参考说话人的字幕行。

开启多参考图需要配置全局开关、房间开关和主播实体库：

```json
{
  "ai": {
    "comic": {
      "multiReferenceImages": {
        "enabled": false,
        "maxExtraCharacters": 2,
        "minSpeakerScore": 0.64,
        "minSpeechSeconds": 8,
        "minSpeakerMaxScore": 0.8,
        "minSpeakerSecondsWhenLowScore": 900,
        "includeUnknownSpeakers": false,
        "useMentionedOnlyAsContext": true,
        "appendCharacterDescriptions": true,
        "imageOrder": ["host", "appeared_streamers", "cover", "screenshots", "default"]
      }
    },
    "streamerRegistry": {
      "sui": {
        "displayName": "岁己SUI",
        "roomIds": ["25788785"],
        "speakerLabels": ["岁己SUI", "sui", "SUI"],
        "referenceImages": ["src/scripts/reference_images/25788785.png"],
        "characterDescription": "岁己SUI，白发红瞳女生。"
      },
      "shiori": {
        "displayName": "栞栞",
        "speakerLabels": ["栞栞", "Shiori"],
        "referenceImages": ["src/scripts/reference_images/shiori.png"],
        "characterDescription": "栞栞，……"
      }
    },
    "roomSettings": {
      "25788785": {
        "multiReferenceImages": {
          "enabled": true,
          "maxExtraCharacters": 2,
          "minSpeakerScore": 0.64,
          "minSpeechSeconds": 8,
          "minSpeakerMaxScore": 0.8,
          "minSpeakerSecondsWhenLowScore": 900
        }
      }
    }
  }
}
```

`ai.comic.multiReferenceImages` 是全局默认；`ai.roomSettings[roomId].multiReferenceImages` 可以覆盖。默认配置保持 `enabled=false`，不会改变原来的单主播参考图、封面、截图、默认图兜底逻辑。

`asr.sensevoice.speaker_references[].speaker` 建议填写 `streamerRegistry` 里的 `displayName` 或 `speakerLabels` 之一。只有 speaker label 能映射到 `streamerRegistry` 时，才可能进入多参考图。如果输出只是 `SPEAKER_00` / `SPEAKER_01` 聚类标签，系统无法知道对应主播是谁，因此不会加入多参考图。

多参考图收集顺序：

1. 房间主人参考图。
2. 实际出声的额外主播参考图，每人最多第一张存在的图。
3. 直播封面。
4. 直播截图。
5. 默认参考图兜底。

当前保守限制总输入图片数最多 4 张。参考图路径可以是项目根目录相对路径，也可以是绝对路径；路径不存在只 warning，不会中断生图。

常见情况：

- 只有 `SPEAKER_00` / `SPEAKER_01`：不会触发多参考图。
- `UNKNOWN`：不会触发。
- `avgScore` 低于 `minSpeakerScore`、出声时长低于 `minSpeechSeconds`，或 `maxScore` 低于 `minSpeakerMaxScore` 且出声时长短于 `minSpeakerSecondsWhenLowScore`：不会触发多参考图；这不会把 review SRT 中原本的 known speaker 标签改成 `UNKNOWN`。
- 没有 `speaker_score`：允许按 `minSpeechSeconds` 过滤通过，日志会说明分数缺失。
- sidecar 缺失：生图阶段打印 INFO 并保持原逻辑。
- 多参考图可能串角色：prompt 已约束不要混合发色、服装、配饰，但图像模型不能保证完美。

## 验证当前 Paraformer / adaptive speaker

### 静态与单元测试

```powershell
python -m unittest tests.test_sensevoice_speaker -v
npm test -- --runInBand src/scripts/asr/asr_backends.test.ts src/scripts/asr/speaker_once_registry.test.ts src/services/bilibili/DelayedReplyService.test.ts
npm run type-check
npm run build
```

Python adaptive tests 不在 Jest 的 TypeScript `testMatch` 内，必须单独运行。测试可验证 probe 决策、fail-open、embedding reuse、reference margin、路由和 metadata 契约，但不能替代真实 FunASR/CUDA 运行。

### 真实样本

1. 使用 `tmp/` 下的 disposable/ignored 音频副本。若同名 `.srt` 已存在，先改名或删除，否则 `enhanced_auto_summary.js` 会直接复用字幕并跳过 ASR。
2. 在 PowerShell 设置 production 环境后运行真实入口：

   ```powershell
   $env:NODE_ENV = 'production'
   node src/scripts/enhanced_auto_summary.js "D:/path/to/sample.wav" --asr-backend paraformer
   ```

3. 日志应先显示主 Paraformer pipeline 的 `spk=0.000s`，产生 `sentence_info` 后才进入 adaptive speaker。
4. 对照 `[[ASR_TIMING]]` 和同名 `.asr_meta.json`，检查 `speakerProcessing.status`、`decision`、`full_run`、counts 和 timings 一致。
5. 验证 forced-full 时另用 disposable 副本并设置：

   ```powershell
   $env:ASR_ENABLE_SPEAKER_ONCE = 'true'
   ```

   结果应为 `mode=always`、`full_run=true`。手工验证看到 `[[ASR_PHASE_DONE]]` 后应停止进程，避免继续执行 AI、发布、回复或其他外部副作用。

首次模型下载和 CUDA cache 可能耗时；真实运行会在样本旁写 SRT/sidecar。单元测试和 type-check 不是 model loading、device placement、pipeline ordering 与 metadata wiring 的运行证据。

## 逐段身份与切片证据

`asr.speaker_identity` 支持 `policy: "row_verified"`、`room_ids` 和
`min_seconds`（默认2秒）。只有白名单房间传入新策略；默认继续使用既有策略。
新策略不把整簇多数身份或最高分覆盖到未通过局部阈值/间隔校验的片段。
短语音、局部拒识、覆盖不足或混合说话人保留 `UNKNOWN`，且不会被原有平滑器重新实名。
不要通过降低声纹阈值或把房间主人当真值来减少 unknown。

ASR结果的 `speaker_evidence` 保留原始声学窗口、逐窗口label/score/margin、
threshold、参考数量、cluster、scope和policy，经JS规范化写入与普通SRT哈希绑定的
`.asr_evidence.json`。切片使用这些结构化信息，不把旧 `[名字 分数]` 字符串当逐句真值。
声学窗口不等于逐词时间；跨不同人或未知窗口的字幕不得涂成单人。

经人工听审，或经明确授权的独立来源交叉核验后的少量参考可显式使用 `preserve_exemplars: true`，保留2-24个独立音频样本，
避免原型压缩删除稀少但真实的声音状态。默认参考仍走原型压缩和同一缓存机制。
该开关不是身份认证：必须保留参考来源、音频哈希、核验方式、跨日期留出与误认负例。
来源交叉核验应核对本人账号、投稿者或原录播资料、画面和连续内容，并以其他来源验证声纹；必须明确 `humanAudited: false`，不得冒充人工听审。
未经核验的录播房主片段不得仅因标题/目录名匹配而正式入库。

下一场名单继续使用 `asr:speaker-once -- enable ... --participants ...`。
为指定既有录播登记名单可运行：

```powershell
npm run asr:speaker-once -- attach-recording 岁己 --media "录播.flv" --srt "录播.srt" --participants 小绒
```

生成同名 `.participants.json`，绑定媒体绝对路径、roomId和SRT哈希。相同输入可重复执行；
已有不同名单或字幕变化时拒绝覆盖，应先人工核对旧侧车。登记名单不触发转写、选材或上传。
自动选材需要另外启用 `ownStreamClips.attribution` 才使用新的人物与动作复核路径。

人物目录缺声纹时可显式开启 `attribution.dialogueEnabled` 做独立文本对话推断。
首次动作复核仍有身份歧义，且局部文本或已登记参与者提示可能多人时才追加分析；不要求先有场次名单。
它与声纹证据分开保存，不会改写ASR标签。身份锚点和被支持的动作句均检查声纹冲突，冲突继续待核。
静态立绘只作为同场线索，不直接赋予某句发言者身份。`auto`探测认为单人时仍可能跳过完整speaker阶段，此时不能冒充已实名。

生产可按同一房间白名单分别启用 `asr.speaker_identity` 与 `ownStreamClips.attribution`。
源CLI由下播处理进程新启动时读取配置；只修改这些JS/Python能力和配置无需替换compiled workflow或重启Webhook。
切换前检查是否有正在运行的ASR/选材进程，既有进程不保证重新加载配置；不要中断正在处理的录播。
回退只关闭对应的attribution开关、将speaker policy改回legacy，不删除已产生的证据或审核记录。

## 常见问题

- `funasr 未安装`: 在运行脚本的 Python 环境中安装 `funasr modelscope torch torchaudio`。
- `CUDA 不可用`: 将 `asr.sensevoice.device` 改为 `cpu`，或修复 PyTorch CUDA 安装。
- `模型加载失败`: 检查模型名、网络、ModelScope 缓存目录和磁盘空间。
- `输入音频不存在`: 确认传入路径存在，路径包含中文时建议使用 UTF-8 Python 环境。
