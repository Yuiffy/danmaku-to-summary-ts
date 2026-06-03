# ASR 热词实验记录

日期：2026-06-03

## 环境

- Python 当前可导入 `funasr`。
- Python 当前不可导入 `vllm`，因此 `fun_asr_nano_vllm` 只验证到依赖检查和清晰失败。
- 可运行实验使用 `fun_asr_nano`，热词和后处理逻辑与 vLLM 后端共用同一份 `hotwords` / corrections。

## 正样本：岁己 / 小岁

命令：

```bash
node src/scripts/asr/hotword_benchmark.js --root "D:/files/videos/DDTV录播/21452505_七海Nana7mi/2026_06_01" --limit 1 --window 20 --backend fun_asr_nano
```

片段：

- SRT 命中：`呃然后就是穗即跟我说能不能叫他岁岁呀还是叫他小岁`
- clip 时长：约 26.39s

结果：

| 版本 | 耗时 | RTF | 结果摘要 |
| --- | ---: | ---: | --- |
| baseline | 48.289s | 1.8298 | `穗姐跟我说，能不能叫他穗穗呀？还是叫他小穗？` |
| tuned | 47.911s | 1.8154 | `岁己跟我说，能不能叫他岁岁呀？还是叫他小岁？` |

结论：

- tuned 命中 `岁己`、`岁岁`、`小岁`。
- 同段里 `碎几根看看` 保持未替换，没有被误改成 `岁己根看看`。
- 汇总指标：baseline `suiTargetHitRate=0`，tuned `suiTargetHitRate=1`；baseline `xiaoSuiHits=0/1`，tuned `xiaoSuiHits=1/1`。

## Paraformer + CAM++：内建 pipeline

根据 FunASR 文档和 issue 2944 方向，当前 `paraformer` 后端改为 `AutoModel(model="paraformer-zh", vad_model="fsmn-vad", punc_model="ct-punc", spk_model="cam++")` 一次性串联，不再手动 VAD 切段。

### 设备的问题样本

来源：

```text
D:/files/videos/DDTV录播/1967216004_三理Mit3uri/2026_05_19/录制-1967216004-20260519-200319-782-3d后日谈！.m4a
02:40:58 起 28s
```

命令：

```bash
ffmpeg -y -ss 02:40:58 -t 28 -i "...3d后日谈！.m4a" -ar 16000 -ac 1 tmp/asr-paraformer-device-clip.wav
node -e "... asr.transcribeParaformer(...) ..."
```

结果：

- 加载 `fsmn-vad`、`ct-punc`、`cam++`。
- 返回 `sentence_info: 11 句`。
- 关键句输出为：`我的家就是可能是设备的问题，`
- 每句带 `speaker: SPEAKER_00`。
- 没有再出现 `是 / 东北` 这种跨 VAD 边界误切。

### 岁己 / 小岁样本

命令：

```bash
node src/scripts/asr/hotword_benchmark.js --root "D:/files/videos/DDTV录播/21452505_七海Nana7mi/2026_06_01" --limit 1 --window 20 --backend paraformer --output tmp/asr-paraformer-positive-cross-segment
```

结果：

| 版本 | 耗时 | RTF | 结果摘要 |
| --- | ---: | ---: | --- |
| baseline | 25.704s | 0.9740 | `岁吉...岁吉...小碎` |
| tuned | 25.597s | 0.9699 | `岁己...岁己...小岁` |

结论：

- Paraformer + CAM++ 成功走 `sentence_info: 14 句`。
- tuned 通过热词和全文上下文 corrections 修正 `岁吉 -> 岁己`、`小碎 -> 小岁`。
- corrections 已改为先用全文判断上下文，再逐 segment 替换，避免 sentence_info 分句导致同一句语境丢失。

## 负样本：随机

命令：

```bash
node src/scripts/asr/hotword_benchmark.js --root "D:/files/videos/DDTV录播/80397_阿梓从小就很可爱/2026_06_02" --limit 1 --window 20 --backend fun_asr_nano
```

片段：

- SRT 命中：`一大堆的现在就从资料库随机播放音乐`
- clip 时长：约 27.95s

结果：

| 版本 | 耗时 | RTF | 结果摘要 |
| --- | ---: | ---: | --- |
| baseline | 47.535s | 1.7007 | `现在就从资料库随机播放音乐` |
| tuned | 47.260s | 1.6908 | `现在就从资料库随机播放音乐` |

结论：

- tuned 保留 `随机播放音乐`。
- 没有出现 `随机/随即 -> 岁己` 的误替换。

Paraformer + CAM++ 复测：

```bash
node src/scripts/asr/hotword_benchmark.js --root "D:/files/videos/DDTV录播/80397_阿梓从小就很可爱/2026_06_02" --limit 1 --window 20 --backend paraformer --output tmp/asr-paraformer-negative-final
```

结果：

| 版本 | 耗时 | RTF | 结果摘要 |
| --- | ---: | ---: | --- |
| baseline | 27.971s | 1.0007 | `现在就从资料库随机播放音乐` |
| tuned | 27.954s | 1.0001 | `现在就从资料库随机播放音乐` |

结论：Paraformer tuned 也保留 `随机播放音乐`，没有误改成 `岁己`。

## vLLM 状态

参考文档：

- FunASR vLLM guide: `AutoModelVLLM` 支持 `hotwords=["张三", "北京"]`，离线服务协议也支持 `spk` 说话人分离。
- vLLM 官方安装文档：vLLM 不原生支持 Windows；Windows 上应使用 WSL / Linux 环境或社区 fork。

环境检查：

```bash
npm run asr:vllm-doctor
```

命令：

```bash
node src/scripts/asr/hotword_benchmark.js --root "D:/files/videos/DDTV录播/21452505_七海Nana7mi/2026_06_01" --limit 1 --window 20 --backend fun_asr_nano_vllm
```

当前结果：

```text
vLLM 未安装，无法使用 fun_asr_nano_vllm
请在当前 Python 环境安装 vLLM 及匹配 CUDA/PyTorch 依赖；也可以临时改用 --asr-backend fun_asr_nano 或 sensevoice。
```

结论：代码路径和错误提示可用，但真实 vLLM 准确率/速度必须等本机补齐 `vllm` 后再跑同一批 benchmark。

当前 benchmark 已改为默认记录失败而不中断报告。即使 vLLM 不可用，也会写入：

```bash
node src/scripts/asr/hotword_benchmark.js --root "D:/files/videos/DDTV录播/21452505_七海Nana7mi/2026_06_01" --limit 1 --window 20 --backend fun_asr_nano_vllm --output tmp/asr-hotword-benchmark-vllm-fail
```

报告摘要：

```json
{
  "candidateCount": 1,
  "runCount": 2,
  "okRuns": 0,
  "failedRuns": 2,
  "averageRealtimeFactor": null
}
```

失败原因记录为 `vLLM 未安装，无法使用 fun_asr_nano_vllm`。

## 混合后端报告

命令：

```bash
node src/scripts/asr/hotword_benchmark.js --root "D:/files/videos/DDTV录播/21452505_七海Nana7mi/2026_06_01" --limit 1 --window 20 --backend fun_asr_nano,fun_asr_nano_vllm --output tmp/asr-hotword-benchmark-multi
```

结果摘要：

```json
{
  "candidateCount": 1,
  "runCount": 4,
  "okRuns": 2,
  "failedRuns": 2,
  "averageRealtimeFactor": 1.8759,
  "byBackend": {
    "fun_asr_nano": {
      "okRuns": 2,
      "failedRuns": 0,
      "averageRealtimeFactor": 1.8759
    },
    "fun_asr_nano_vllm": {
      "okRuns": 0,
      "failedRuns": 2,
      "averageRealtimeFactor": null
    }
  }
}
```

结论：

- benchmark 可以一次比较多个后端。
- vLLM 缺依赖时会写入失败项，不会覆盖或污染 `fun_asr_nano` 的可用准确率/速度。
- 当前同片段 `fun_asr_nano` tuned 仍命中 `岁己/小岁`，baseline 未命中。

## 一键实验入口

为了减少最终 vLLM 实测时的手工步骤，新增：

```bash
npm run asr:vllm-experiment
```

默认会执行：

1. `node src/scripts/asr/asr_vllm_doctor.js --json`
2. 正样本目录 benchmark：`21452505_七海Nana7mi/2026_06_01`
3. 负样本目录 benchmark：`80397_阿梓从小就很可爱/2026_06_02`
4. 写入合并报告：`tmp/asr-vllm-experiment/summary.json`

默认后端为 `fun_asr_nano,fun_asr_nano_vllm`，所以可以同时保留非 vLLM Nano 的对照速度/准确率，并记录 vLLM 结果或失败原因。

当前环境可以先做无 ASR 冒烟：

```bash
npm run asr:vllm-experiment -- --no-asr
```

装好 vLLM 后再运行真实实验：

```bash
npm run asr:vllm-experiment -- --backend fun_asr_nano,fun_asr_nano_vllm --limit 1 --window 20
```

安装前探测：

```bash
python -m pip install --dry-run "vllm>=0.12.0"
```

当前结果显示 pip 可解析到 `vllm-0.22.0.tar.gz`，但当前环境仍无法 `import vllm`。由于这是 Windows / Python 3.12 环境，真实安装可能走源码构建，建议先用 doctor 保留环境快照，再决定是否在当前 Python 环境、单独 venv、WSL 或 Linux CUDA 环境安装。
