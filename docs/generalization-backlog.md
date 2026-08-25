# 后续通用化清单

以下内容来自 2026-08-25 的一次专题处理。已经验证为通用的部分进入正式代码；仍绑定
具体素材、机器或游戏 UI 的部分保留在被 `.gitignore` 忽略的 `temp/2026-08-25/`。

## 话题合集流水线

正式位置：`src/scripts/clipping/topic_compilation.js`，入口为 `npm run topic:compile`。

已经落地 `discover/search/plan/build/compile`、跨录播去重、窗口边界校准和 REVIEW 输出。
媒体处理通过 adapter 注入，默认复用项目的字幕烧录和资源调度。后续仍可把 SRT/XML
来源适配器和别名策略独立出来，减少对现有 Sui `topic_clipper` 的默认依赖。

## 事件清单契约

正式位置：`src/scripts/clipping/event_manifest.js` 和
`src/scripts/clipping/event-manifest.schema.json`。

音频、画面、弹幕或模型 detector 都可以保留自己的算法，只需在交给合集编译器前输出
统一的 `source.mediaPath`、`events[].start/end/score/evidence/metadata`。临时 detector
中的 `firstHit/lastHit`、`peakScore` 已支持在边界层归一化；具体 limiter 阈值和游戏 ROI
暂不进入公共代码。

## 音频事件探测与合集

临时位置：`temp/2026-08-25/audio-scream/`。

当前阈值针对特定录音中的 limiter 形态哀嚎校准，不是通用的“尖叫检测器”。后续可
把特征提取、事件策略、校准数据和合集编译拆开，并用可替换的 detector profile 与
固定 fixture 测试。

## 资源调度与平台适配

正式代码中的 `src/scripts/clipping/resource_scheduler.js` 已经把阈值和进程名放进配置，但采集实现仍
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

## 旧切片工作流目录迁移

公共模块已经进入 `src/scripts/clipping/`，并保留了
`src/scripts/clip_resource_adaptive.js`、`src/scripts/clip_output_path.js` 兼容入口。
`topic_clipper.js`、`own_stream_clipper.js`、`manual_clip_queue.js` 和
`background_clip_runner.js` 仍是历史 CLI/模块入口，暂不直接搬动，以免影响外部脚本和
文档命令。后续若要继续整理，应先给这些实现导出明确的 `main()`，再把实现迁到
`src/scripts/clipping/workflows/`，根目录只保留兼容包装。
