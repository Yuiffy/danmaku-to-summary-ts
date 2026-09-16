# 说话人识别 Reference Enrollment 经验笔记

> **历史实验记录**：本页保留早期 reference enrollment 的样本、相似度和素材质量结论，不代表当前运行架构。当前实现与验证见 [ASR Backend 配置](asr-backends.md)：reference matching 已集成到 post-ASR adaptive speaker engine，不再要求修改 FunASR site-packages。

## 背景
单视角多人联动录播（如十六萤4人联动），cam++ 无监督聚类几乎无法区分说话人（SPEAKER_00 占 98.7%）。

## 方案：Reference Enrollment
用单人直播提取 cam++ embedding 作为参考向量（centroid），对联动音频做 cosine similarity 匹配。

## 测试结果（十六萤×灰泽满×莉蔻×克罗雅 4人联动）

### 参考素材
从每人单人直播中截取 2 分钟（跳过前 5 分钟），切成 8 秒 chunks，提取 embedding 取均值作为 centroid。

### Cross-speaker similarity
| Pair | Cosine Sim |
|------|-----------|
| 十六萤 ↔ 莉蔻 | **0.620**（异常高） |
| 灰泽满 ↔ 莉蔻 | 0.334 |
| 十六萤 ↔ 灰泽满 | 0.312 |
| 其他 pair | < 0.1 |

### 效果对比
| 方法 | 十六萤 | 灰泽满 | 莉蔻 | 克罗雅 | UNKNOWN |
|------|--------|--------|------|--------|---------|
| 无监督聚类 | 98.7% | 0.3% | 0.3% | 0.1% | - |
| Reference (时间对齐) | 57% | 19% | 14% | 0.2% | 4% |
| Reference (逐句提取) | 67% | 8% | 9% | 1.5% | 12% |

### 关键发现

1. **当时 FunASR 内建 speaker 返回会删除 `spk_embedding`**
   - 当时实验通过修改本机 site-packages 暴露 embedding；这不是当前部署要求。
   - 当前主 Paraformer 故意不走内建 speaker block，而是在 ASR 后调用独立 CAM++。

2. **embedding 与 sentence 数量不对齐**
   - sentence_info: 6558 条（按标点切句）
   - spk_embedding: 13246 行（按 sv_chunk 滑窗切分，约每秒一个）
   - 需要做时间对齐，不能简单 1:1 映射

3. **十六萤↔莉蔻相似度异常高（0.620）**
   - 原因待查：可能是设备特征相似、声音本身接近、或参考素材选取问题
   - 导致部分莉蔻的话被误判为十六萤

4. **克罗雅几乎识别不出**
   - 可能原因：参考素材选自生化危机游戏直播（情绪波动大），或她在联动里说话少
   - 优化方向：换更平稳的直播做参考，增加参考时长

5. **远场声音（语音软件传来的）embedding 偏向近场宿主**
   - 单视角录播的物理限制，所有声音都经过同一个麦克风
   - 但 reference enrollment 已经显著优于无监督聚类

## 当前代码位置

- Adaptive speaker、reference prototypes、聚类与 matching：`src/scripts/python/sensevoice_speaker.py`
- 原生 Paraformer 的 post-ASR 集成与 CAM++ cache：`src/scripts/python/sensevoice_paraformer.py`
- 当前单元测试：`tests/test_sensevoice_speaker.py`
- Canonical reference manifest：`data/asr_speaker_refs/manifest.json`

## 当前状态与历史待优化

- [x] Reference enrollment 已集成到 `transcribe_paraformer_builtin()` 的 post-ASR 流程。
- [x] 已支持 adaptive probe、probe embedding reuse、lazy reference prototypes 和 score/runner-up margin。
- [x] 说话人候选段使用 FSMN-VAD 外层区间与 Paraformer 字幕时间戳边界；`speaker_probe_max_chunks` 只限制均匀探测样本数，不是固定时长切块。
- [x] 同一主播支持按 `state` 登记多份参考，各状态独立构建受支持原型；已用栞栞的 `calm_chat` 与 `excited_game` 两个状态验证。
- [x] planned roster 仅作为评估元数据；所有合格参考始终参与开放集竞争，陌生声音证据不足时保留匿名标签。
- [x] cluster 实名需要重复 chunk 支持，逐句实名还需要该句自身与同一主播一致，避免游戏内语音随整个簇被批量实名。
- [x] 已有 batching、single/multiple/inconclusive、fail-open、forced mode 和 reference matching 单元测试。
- [ ] 继续为已有主播补充经过人工复核、覆盖稳定声学状态的参考素材；不把未经跨场验证的候选音频直接加入参考库。
- [ ] 对十六萤↔莉蔻高相似度问题，尝试更好的 reference 素材或 per-chunk 评估。
- [ ] 换克罗雅的参考素材（选聊天直播而非游戏直播）。
- [ ] 如模型加载成本仍显著，再评估 prototype 持久化；当前常驻 worker 会在进程内复用 reference/cache。
