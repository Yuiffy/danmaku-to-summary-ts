# 说话人识别 Reference Enrollment 经验笔记

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

1. **FunASR auto_model.py 第896行会 `del result["spk_embedding"]`**
   - 解决：注释掉该行（修改了 FunASR 源码 `D:\develop\Python\Lib\site-packages\funasr\auto\auto_model.py`）
   - `return_spk_res=False` 会跳过整个 spk 处理块，不可用

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

## 代码位置
- `sensevoice_transcribe.py` 里已有 `build_speaker_reference_centroids`（行694）和 `classify_speaker_embeddings`
- 测试脚本：`tmp/paraformer_test/test_enrollment_v4.py`（最佳版本）和 `test_enrollment_v6.py`

## 待优化
- [ ] 尝试更长的参考音频（5-10 分钟），提高 centroid 质量
- [ ] 对十六萤↔莉蔻高相似度问题，尝试用 per-chunk matching 代替 centroid matching
- [ ] 换克罗雅的参考素材（选聊天直播而非游戏直播）
- [ ] 将 reference enrollment 集成到 `transcribe_paraformer_builtin()` 流程中
- [ ] 参考 centroid 持久化存储（避免每次重新提取）
