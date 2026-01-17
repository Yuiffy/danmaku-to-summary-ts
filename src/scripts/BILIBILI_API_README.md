# B站动态回复API服务器

用于调试B站动态回复功能的HTTP接口服务。

## 启动服务

```bash
npm run bilibili:api
```

服务默认运行在 `http://localhost:3000`

## API端点

### 1. 健康检查
```
GET /health
```

**响应示例：**
```json
{
  "success": true,
  "message": "B站API服务器运行中"
}
```

---

### 2. 检查Cookie有效性
```
GET /api/bilibili/check-cookie
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "valid": true,
    "message": "Cookie有效"
  }
}
```

---

### 3. 获取主播动态列表
```
GET /api/bilibili/dynamics/:uid?offset=xxx
```

**参数：**
- `uid` (路径参数): 主播UID
- `offset` (查询参数，可选): 分页偏移量

**响应示例：**
```json
{
  "success": true,
  "data": {
    "uid": "123456789",
    "count": 5,
    "dynamics": [
      {
        "id": "1234567890123456789",
        "type": "DYNAMIC_TYPE_DRAW",
        "content": "今天天气真好~",
        "images": ["https://..."],
        "publishTime": "2024-01-01T12:00:00.000Z",
        "url": "https://www.bilibili.com/opus/1234567890123456789"
      }
    ]
  }
}
```

---

### 4. 发布评论
```
POST /api/bilibili/comment
Content-Type: application/json
```

**请求体：**
```json
{
  "dynamicId": "1234567890123456789",
  "content": "晚安~",
  "images": ["https://..."]  // 可选
}
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "replyId": "987654321",
    "replyTime": 1704110400000,
    "message": "评论发布成功"
  }
}
```

---

### 5. 上传图片
```
POST /api/bilibili/upload
Content-Type: multipart/form-data
```

**请求参数：**
- `image` (文件): 图片文件

**响应示例：**
```json
{
  "success": true,
  "data": {
    "imageUrl": "https://i0.hdslb.com/bfs/...",
    "message": "图片上传成功"
  }
}
```

---

### 6. 发布带图片的评论（一步完成）
```
POST /api/bilibili/comment-with-image
Content-Type: multipart/form-data
```

**请求参数：**
- `dynamicId` (表单字段): 动态ID
- `content` (表单字段): 评论内容
- `image` (文件，可选): 图片文件

**响应示例：**
```json
{
  "success": true,
  "data": {
    "replyId": "987654321",
    "replyTime": 1704110400000,
    "imageUrl": "https://i0.hdslb.com/bfs/...",
    "message": "评论发布成功"
  }
}
```

---

### 7. 获取配置信息
```
GET /api/bilibili/config
```

**响应示例：**
```json
{
  "success": true,
  "data": {
    "enabled": true,
    "anchors": {
      "123456789": {
        "uid": "123456789",
        "name": "主播名称",
        "enabled": true
      }
    },
    "polling": {
      "interval": 60000,
      "maxRetries": 3,
      "retryDelay": 5000
    }
  }
}
```

---

## Postman使用示例

### 1. 检查Cookie有效性
```
GET http://localhost:3000/api/bilibili/check-cookie
```

### 2. 获取主播动态
```
GET http://localhost:3000/api/bilibili/dynamics/123456789
```

### 3. 发布纯文本评论
```
POST http://localhost:3000/api/bilibili/comment
Content-Type: application/json

{
  "dynamicId": "1234567890123456789",
  "content": "晚安~"
}
```

### 4. 上传图片
```
POST http://localhost:3000/api/bilibili/upload
Content-Type: multipart/form-data

Body -> form-data:
- image: [选择图片文件]
```

### 5. 发布带图片的评论
```
POST http://localhost:3000/api/bilibili/comment-with-image
Content-Type: multipart/form-data

Body -> form-data:
- dynamicId: 1234567890123456789
- content: 晚安~
- image: [选择图片文件]
```

---

## 配置

确保 `config/secret.json` 中配置了B站Cookie：

```json
{
  "bilibili": {
    "cookie": "你的B站Cookie",
    "csrf": "你的CSRF Token"
  }
}
```

获取Cookie方法：
1. 登录B站
2. 打开浏览器开发者工具 (F12)
3. 访问任意B站页面
4. 在 Network 标签中找到请求
5. 复制请求头中的 Cookie
6. 从 Cookie 中提取 `bili_jct` 值作为 csrf

---

## 错误响应格式

所有错误响应遵循统一格式：

```json
{
  "success": false,
  "error": "错误描述信息"
}
```

常见错误码：
- `400`: 请求参数错误
- `404`: 资源不存在
- `500`: 服务器内部错误
