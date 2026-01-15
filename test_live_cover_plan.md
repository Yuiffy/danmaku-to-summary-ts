# 直播封面功能测试计划

## 修改内容

1. **添加了 `get_live_cover_image` 函数**
   - 从录制目录查找对应的 `.cover` 文件
   - 支持多种图片格式：`.jpg`, `.jpeg`, `.png`, `.webp`
   - 文件名格式：`{basename}.cover{ext}`

2. **修改了 `get_room_reference_image` 函数**
   - 添加了可选的 `highlight_path` 参数
   - 优先级顺序：
     1. 房间特定图片（配置中设置）
     2. 直播封面（从录制目录查找）
     3. 默认图片

3. **更新了调用处**
   - 在 `generate_comic_from_highlight` 中传入 `highlight_path` 参数

## 测试场景

### 场景1：有房间设置的情况
- 房间26966466配置了referenceImage
- 应该优先使用配置的房间图片

### 场景2：无房间设置，有直播封面的情况
- 房间没有配置referenceImage
- 录制目录有对应的.cover.jpg文件
- 应该使用直播封面

### 场景3：无房间设置，无直播封面的情况
- 房间没有配置referenceImage
- 录制目录没有.cover文件
- 应该使用默认图片

## 验证方法

运行测试脚本验证功能是否正常工作。

## 预期结果

修改后，当没有设置AI参考图时，会优先使用直播封面而不是默认图。