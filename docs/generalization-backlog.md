# 后续通用化清单

以下内容来自 2026-08-25 的一次专题处理，已移到被 `.gitignore` 忽略的
`temp/2026-08-25/`，暂不作为正式命令或运行时依赖。

## 话题合集流水线

临时位置：`temp/2026-08-25/topic-compilation/`。

目前已经有 `discover/search/plan/build/compile` 的雏形，但仍依赖本项目的
`topic_clipper`、Sui 录播文件命名和当前字幕/弹幕证据格式。后续应抽出来源适配器、
话题别名策略、窗口边界策略和媒体编译器接口，再决定是否回到 `src/scripts/`。

## 音频事件探测与合集

临时位置：`temp/2026-08-25/audio-scream/`。

当前阈值针对特定录音中的 limiter 形态哀嚎校准，不是通用的“尖叫检测器”。后续可
把特征提取、事件策略、校准数据和合集编译拆开，并用可替换的 detector profile 与
固定 fixture 测试。

## 资源调度与平台适配

正式代码中的 `clip_resource_adaptive.js` 已经把阈值和进程名放进配置，但采集实现仍
偏向 Windows + NVIDIA。后续可抽出 telemetry provider，让 Linux、AMD 或无 GPU 主机
只替换采集层，不影响队列调度逻辑。

## B 站多 P 元数据更新

`scripts/edit_video_meta.py --page-title` 解决了通用的单 P 标题更新需求，但当前通过
`bilibili_api` 的 `VideoEditor` 私有成员完成提交。后续应封装版本适配器，优先使用稳定
的公开接口，避免库升级后影响已有稿件。

## 游戏画面事件合集

临时位置：`temp/2026-08-25/you-died/`。

`you-died` 检测器绑定 1920x1080 的固定 UI 红色区域和当前游戏提示图；编译器也把
事件命名、排序和字幕计数写死。后续可改成配置化 ROI/模板、事件类型和通用事件合集
编译器。`append_video_tail.py` 也可并入通用媒体拼接工具。

## 性能基准与一次性素材

临时位置：`temp/2026-08-25/clip-burn/`、`temp/2026-08-25/cold-face-moe/`，以及
`temp/2026-08-25/cold-face-moe/subtitle-keywords.json` 和
`temp/2026-08-25/seedance/q_sui_refs.py`。

基准记录包含单机 CPU/NVENC/CUDA 数据，只能作为本机调参证据；后续如需长期保留，
应改成输入清单、采集脚本和可复现报告。冷脸萌别名、Q 版素材引用和重建脚本都属于
当前专题资产，若以后反复使用，应放进可配置的专题/素材 manifest，不要写入默认切片
配置或通用素材脚本。
