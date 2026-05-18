# Gemini 异步图像生成 API 使用说明

## 概述

`tuzi_gemini_async.py` 是一个用于调用 tuZi 平台 Gemini 异步图像生成 API 的封装模块。该 API 采用异步任务模式，失败不扣费，适合作为 `nano-banana` 和 `gpt-image-1.5` 之间的备选方案。

## 特性

- ✅ **异步任务模式**：创建任务后轮询状态，避免长时间阻塞
- ✅ **失败不扣费**：任务失败时不会扣除费用
- ✅ **多图支持**：支持上传多张参考图片
- ✅ **多种分辨率**：支持 1k、2k、4k 三种分辨率
- ✅ **灵活的尺寸比例**：支持 1:1、9:16、16:9 等多种比例

## API 接口

### 创建任务

**端点**: `POST /v1/videos`

**请求格式**: `multipart/form-data`

**参数**:
- `model` (必填): 模型名称
  - `gemini-3-pro-image-preview-async` - 1k 异步
  - `gemini-3-pro-image-preview-2k-async` - 2k 异步
  - `gemini-3-pro-image-preview-4k-async` - 4k 异步
- `prompt` (必填): 图像生成提示词
- `size` (可选): 图像尺寸比例
  - 可选值: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`
- `input_reference` (可选): 参考图片文件或 URL，支持多图

**响应示例**:
```json
{
    "id": "472886112156536836",
    "object": "video",
    "model": "gemini-3-pro-image-preview-async",
    "status": "queued",
    "progress": 0,
    "created_at": 1769600979
}
```

### 查询任务状态

**端点**: `GET /v1/videos/{task_id}`

**响应示例**:
```json
{
    "id": "472886112156536836",
    "status": "completed",
    "progress": 100,
    "url": "https://example.com/generated_image.png"
}
```

**状态值**:
- `queued` - 排队中
- `processing` / `pending` / `running` - 处理中
- `completed` / `succeeded` - 完成
- `failed` / `error` - 失败

## Python 模块使用

### 基本用法

```python
from tuzi_gemini_async import call_tuzi_gemini_async

# 调用 API
result = call_tuzi_gemini_async(
    prompt="一只可爱的小猫咪在草地上玩耍",
    reference_image_paths=["path/to/reference1.jpg", "path/to/reference2.jpg"],
    model="gemini-3-pro-image-preview-async",
    base_url="https://api.tu-zi.com",
    api_key="your_api_key",
    proxy_url="socks5://127.0.0.1:7890",  # 可选
    timeout=60,
    size="9:16",
    max_poll_time=300
)

if result:
    print(f"图像已保存到: {result}")
else:
    print("生成失败")
```

### 参数说明

- `prompt` (str): 图像生成提示词
- `reference_image_paths` (List[str], 可选): 参考图片路径列表
- `model` (str): 模型名称，默认 `gemini-3-pro-image-preview-async`
- `base_url` (str): API 基础 URL，默认 `https://api.tu-zi.com`
- `api_key` (str): API 密钥
- `proxy_url` (str, 可选): 代理 URL
- `timeout` (float): 请求超时时间（秒），默认 360
- `size` (str): 图像尺寸比例，默认 `9:16`
- `max_poll_time` (float): 最大轮询等待时间（秒），默认 300

### 返回值

- 成功: 返回生成的图像文件路径（临时文件）
- 失败: 返回 `None`

## 集成到重试逻辑

在 `tuzi_chat_completions.py` 中，Gemini 异步 API 已被集成到图像生成的重试逻辑中：

1. **第一次尝试**: 使用指定的模型（通常是 `nano-banana`）
2. **第二次尝试**: 如果第一次失败，自动调用 Gemini 异步 API
3. **后续尝试**: 如果 Gemini 异步 API 也失败，继续尝试其他备选模型（`gpt-image-1.5`、`gemini-2.5-flash-image-vip` 等）

这样的设计确保了：
- 优先使用性价比最高的模型
- 失败时有多层备选方案
- Gemini 异步 API 作为中间层，平衡了成本和成功率

## 测试

运行测试脚本：

```bash
python src/scripts/test_gemini_async.py
```

或者直接测试模块：

```bash
python src/scripts/tuzi_gemini_async.py "一只可爱的小猫咪" path/to/reference.jpg
```

## 注意事项

1. **API 密钥**: 确保在配置文件中正确设置了 `ai.comic.tuZi.apiKey`
2. **代理设置**: 如果需要使用代理，在配置文件中设置 `ai.comic.tuZi.proxy`
3. **轮询超时**: 默认最大轮询时间为 300 秒，可根据实际情况调整
4. **文件格式**: 生成的图像默认保存为 PNG 格式
5. **临时文件**: 生成的图像保存在系统临时目录，使用后建议及时清理

## 故障排除

### 任务创建失败
- 检查 API 密钥是否正确
- 检查网络连接和代理设置
- 确认参考图片文件存在且可读

### 任务轮询超时
- 增加 `max_poll_time` 参数
- 检查网络连接是否稳定
- 查看 API 服务状态

### 图像下载失败
- 检查返回的图像 URL 是否有效
- 确认网络连接正常
- 检查代理设置

### 任务完成但提示"未找到图像URL"
- **原因**: API 返回的字段名可能是 `video_url` 而不是 `url`
- **解决方案**: 代码已支持多种字段名（`video_url`、`image_url`、`url` 等）
- **调试方法**: 查看 `[DEBUG] 完整响应` 日志，确认实际返回的字段名
- **示例响应**:
  ```json
  {
    "id": "474290719529545733",
    "status": "completed",
    "progress": 100,
    "video_url": "https://apioss3.sydney-ai.com/img.../image.jpg"
  }
  ```

## 更新日志

### v1.0.0 (2026-02-01)
- 初始版本
- 支持 Gemini 异步图像生成 API
- 支持多图上传
- 集成到重试逻辑中
