# 自定义 AI Prompts 功能说明

## 概述

现在系统支持为特定主播配置专用的 AI 生成 prompts，包括：
1. **晚安回复 prompt** (`goodnightReply`)
2. **漫画脚本生成 prompt** (`comicScript`)
3. **漫画图片生成 prompt** (`comicImage`)

## 配置方式

在 `config/production.json` 的 `ai.roomSettings` 中，为特定房间添加 `customPrompts` 字段：

```json
{
  "ai": {
    "roomSettings": {
      "612978": {
        "audioOnly": true,
        "characterDescription": "吃蛋挞的折棒，黑色长发、紫红瞳的喜欢三国杀的女生；喜欢打扮成三国人物的样子。",
        "anchorName": "折棒爷",
        "fanName": "折棒棒",
        "enableTextGeneration": true,
        "enableComicGeneration": true,
        "enableDelayedReply": false,
        "customPrompts": {
          "goodnightReply": "你的自定义晚安回复 prompt...",
          "comicScript": "你的自定义漫画脚本生成 prompt...",
          "comicImage": "你的自定义漫画图片生成 prompt..."
        }
      }
    }
  }
}
```

## Prompt 模板变量

### 晚安回复 (goodnightReply)

可用变量：
- `{anchor}` - 主播名称
- `{fan}` - 粉丝名称
- `{wordLimit}` - 字数限制
- `{highlightContent}` - 直播内容摘要

### 漫画脚本生成 (comicScript)

可用变量：
- `{character_desc}` - 角色描述
- `{highlight_content}` - 直播内容摘要

### 漫画图片生成 (comicImage)

可用变量：
- `{character_desc}` - 角色描述
- `{comic_content}` - 生成的漫画脚本内容

## 示例：折棒爷的三国杀主题配置

已为房间 `612978`（折棒爷）配置了三国杀主题的自定义 prompts：

### 晚安回复特点
- 强调三国杀游戏元素（武将、技能、操作）
- 包含吃蛋挞、cosplay 三国人物等特色内容
- 使用三国杀术语和梗

### 漫画脚本特点
- 如果直播涉及三国杀，会在分镜中体现武将形象、技能效果
- 如果涉及 cosplay，会突出服装和造型特点

### 漫画图片特点
- 强调黑色长发、紫红瞳的角色特征
- 可融入三国杀元素（武将形象、卡牌、技能特效）
- 突出 cosplay 服装细节

## 工作原理

1. **优先级**：自定义 prompt > 默认 prompt
2. **JavaScript 文本生成器** (`ai_text_generator.js`)：
   - `buildPrompt()` 函数会检查房间配置中的 `customPrompts.goodnightReply`
   - 如果存在，使用自定义 prompt 并替换变量
   - 否则使用默认模板

3. **Python 漫画生成器** (`ai_comic_generator.py`)：
   - `build_comic_generation_prompt()` 检查 `customPrompts.comicScript`
   - `build_comic_prompt()` 检查 `customPrompts.comicImage`
   - 支持自定义模板的变量替换

## 使用建议

1. **保持一致性**：确保三个 prompt 的风格和主题一致
2. **测试验证**：添加自定义 prompt 后，测试生成效果
3. **变量使用**：确保在自定义 prompt 中正确使用变量占位符
4. **备份配置**：修改前备份原配置文件

## 扩展其他主播

要为其他主播添加自定义 prompts，只需在对应的房间配置中添加 `customPrompts` 字段即可。例如：

```json
"25788785": {
  "anchorName": "小岁",
  "fanName": "饼干岁",
  "customPrompts": {
    "goodnightReply": "小岁专属的晚安回复 prompt...",
    "comicScript": "小岁专属的漫画脚本 prompt...",
    "comicImage": "小岁专属的图片生成 prompt..."
  }
}
```
