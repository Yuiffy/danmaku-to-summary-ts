# 增强功能使用说明

## 概述

本增强功能为danmaku-to-summary-ts项目添加了三个核心功能：
1. **音频处理**：将指定直播间的视频转为音频以节省存储空间
2. **AI文本生成**：使用Gemini API生成"饼干岁"风格的晚安回复
3. **AI漫画生成**：使用Hugging Face AI Comic Factory生成直播总结漫画

## 快速开始

### 1. 安装依赖

```bash
# 安装Node.js依赖
npm install @google/generative-ai gradio-client axios

# 安装Python依赖（用于漫画生成）
pip install gradio-client requests
```

### 2. 配置设置

编辑 `src/scripts/config.json` 文件：

```json
{
  "audioProcessing": {
    "enabled": true,
    "audioOnlyRooms": [26966466],
    "keepOriginalVideo": false,
    "ffmpegPath": "ffmpeg"
  },
  "aiServices": {
    "gemini": {
      "enabled": true,
      "apiKey": "YOUR_GEMINI_API_KEY_HERE",
      "model": "gemini-1.5-flash",
      "temperature": 0.7
    },
    "huggingFace": {
      "enabled": true,
      "apiToken": "YOUR_HUGGING_FACE_TOKEN_HERE",
      "comicFactoryModel": "jbilcke-hf/ai-comic-factory"
    }
  },
  "roomSettings": {
    "26966466": {
      "audioOnly": true,
      "referenceImage": "reference_images/26966466.jpg",
      "enableTextGeneration": true,
      "enableComicGeneration": true
    }
  }
}
```

### 3. 准备参考图片

1. 创建目录：`src/scripts/reference_images/`
2. 将直播间参考图片放入该目录，命名格式：`{房间ID}.jpg`
   - 例如：`26966466.jpg` 对应房间26966466
3. 参考图片用于AI漫画生成保持角色一致性

## 功能详解

### 音频处理功能

#### 配置项
- `audioOnlyRooms`: 需要转为音频的直播间ID数组
- `keepOriginalVideo`: 是否保留原始视频文件（false则删除）
- `ffmpegPath`: ffmpeg可执行文件路径

#### 工作流程
1. DDTV录制完成后触发webhook
2. 检查房间ID是否在`audioOnlyRooms`列表中
3. 如果是，使用ffmpeg将视频转为音频（复制音频流，不重新编码）
4. 根据配置决定是否删除原始视频

#### 测试命令
```bash
node audio_processor.js <视频文件路径>
```

### AI文本生成功能

#### 配置项
- `apiKey`: Gemini API密钥（从Google AI Studio获取）
- `model`: 使用的模型（推荐gemini-1.5-flash）
- `temperature`: 生成温度（0.0-1.0，越高越有创意）

#### 提示词模板
基于提供的prompt模板，生成"饼干岁"风格的晚安回复，包含：
- 开场白（根据直播时间决定早安/午安/晚安）
- 3-5个直播亮点回顾
- 生活碎碎念和趣事
- 情感关怀和落款

#### 输出文件
`{文件名}_晚安回复.md`，与AI_HIGHLIGHT文件同目录

#### 测试命令
```bash
node ai_text_generator.js <AI_HIGHLIGHT.txt路径>
```

### AI漫画生成功能

#### 配置项
- `apiToken`: Hugging Face API令牌
- `comicFactoryModel`: AI Comic Factory模型

#### 工作流程
1. 读取AI_HIGHLIGHT内容
2. 根据房间ID查找参考图片
3. 构建包含角色描述的提示词
4. 调用Hugging Face AI Comic Factory生成漫画
5. 保存为PNG图片

#### 输出文件
`{文件名}_COMIC_FACTORY.png`，与AI_HIGHLIGHT文件同目录

#### 测试命令
```bash
node ai_comic_generator.js <AI_HIGHLIGHT.txt路径>
```

## 使用方式

### 方式1：增强版主脚本（推荐）

```bash
# 处理单个文件
node enhanced_auto_summary.js <视频文件> [弹幕文件]

# 处理目录
node enhanced_auto_summary.js <目录路径>
```

### 方式2：Webhook自动处理

Webhook服务器已自动使用增强版功能：
1. DDTV录制完成 → 触发webhook
2. 音频处理（如果配置）
3. Whisper ASR生成字幕
4. 弹幕融合生成AI_HIGHLIGHT
5. AI文本生成晚安回复
6. AI漫画生成直播漫画

### 方式3：单独使用模块

```bash
# 仅音频处理
node audio_processor.js <视频文件>

# 仅AI文本生成
node ai_text_generator.js <AI_HIGHLIGHT.txt>

# 仅AI漫画生成  
node ai_comic_generator.js <AI_HIGHLIGHT.txt>
```

## 文件结构

```
src/scripts/
├── config.json                    # 配置文件（已扩展）
├── enhanced_auto_summary.js       # 增强版主脚本
├── audio_processor.js             # 音频处理模块
├── ai_text_generator.js           # AI文本生成模块
├── ai_comic_generator.js          # AI漫画生成JS包装器
├── ai_comic_generator.py          # AI漫画生成Python脚本
├── reference_images/              # 参考图片目录
│   ├── 26966466.jpg              # 房间26966466参考图片
│   └── README.txt                # 说明文件
└── test_enhanced_features.js     # 测试脚本
```

## 配置示例

### 多房间配置

```json
{
  "audioProcessing": {
    "enabled": true,
    "audioOnlyRooms": [26966466, 12345678, 87654321],
    "keepOriginalVideo": false
  },
  "roomSettings": {
    "26966466": {
      "audioOnly": true,
      "referenceImage": "reference_images/26966466.jpg",
      "enableTextGeneration": true,
      "enableComicGeneration": true
    },
    "12345678": {
      "audioOnly": false,
      "referenceImage": "reference_images/12345678.png",
      "enableTextGeneration": true,
      "enableComicGeneration": false
    },
    "87654321": {
      "audioOnly": true,
      "referenceImage": "reference_images/87654321.jpg",
      "enableTextGeneration": false,
      "enableComicGeneration": true
    }
  }
}
```

### 环境变量支持

也可以通过环境变量配置：

```bash
# Windows
set GEMINI_API_KEY=your_key_here
set HF_TOKEN=your_token_here

# Linux/Mac
export GEMINI_API_KEY=your_key_here
export HF_TOKEN=your_token_here
```

## 故障排除

### 常见问题

1. **ffmpeg不可用**
   ```
   错误：ffmpeg命令失败
   解决：安装ffmpeg并添加到PATH环境变量
   ```

2. **Gemini API密钥无效**
   ```
   错误：Gemini API未配置
   解决：从Google AI Studio获取有效API密钥
   ```

3. **Hugging Face token无效**
   ```
   错误：Hugging Face API未配置
   解决：从huggingface.co获取有效token
   ```

4. **Python环境问题**
   ```
   错误：Python脚本执行失败
   解决：确保Python已安装，并安装gradio_client库
   ```

5. **参考图片不存在**
   ```
   警告：未找到参考图片
   解决：将参考图片放入reference_images目录
   ```

### 测试功能

运行测试脚本检查所有功能：

```bash
node test_enhanced_features.js
```

## 性能优化建议

1. **音频处理**：对于长视频，考虑使用更高效的音频编码
2. **API调用**：添加缓存机制避免重复调用相同内容
3. **并行处理**：多个文件可以并行处理以提高效率
4. **错误重试**：API调用失败时自动重试

## 扩展开发

### 添加新的AI服务

1. 在`config.json`中添加新服务配置
2. 创建对应的处理模块
3. 在`enhanced_auto_summary.js`中集成新模块
4. 更新配置文件加载逻辑

### 自定义提示词模板

修改`ai_text_generator.js`中的`buildPrompt`函数，调整"饼干岁"的风格和内容要求。

### 支持更多漫画风格

修改`ai_comic_generator.py`中的提示词构建逻辑，支持不同的漫画风格和布局。

## 版本历史

- v1.0.0: 初始版本，实现三大增强功能
- 音频处理：视频转音频，节省存储空间
- AI文本生成：Gemini API生成晚安回复
- AI漫画生成：Hugging Face生成直播漫画

## 许可证

本项目基于原有项目许可证，新增代码遵循相同许可协议。

## 支持与反馈

如有问题或建议，请参考原有项目的支持渠道。