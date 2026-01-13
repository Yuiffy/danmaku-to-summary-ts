# 参考图片存放说明

## 目录结构

参考图片应该存放在以下目录：

```
d:/workspace/myrepo/danmaku-to-summary-ts/public/reference_images/
```

## 如何存放图片

1. 将你的参考图片文件（如 `26966466.jpg`）复制到上述目录
2. 图片路径示例：`public/reference_images/26966466.jpg`

## 在代码中引用

在 Next.js 项目中，可以通过以下方式引用这些图片：

### 方法 1：使用 Next.js Image 组件
```tsx
import Image from 'next/image';

// 在组件中使用
<Image
  src="/reference_images/26966466.jpg"
  alt="参考图片描述"
  width={500}
  height={300}
/>
```

### 方法 2：作为普通图片标签
```tsx
<img src="/reference_images/26966466.jpg" alt="参考图片描述" />
```

### 方法 3：在 CSS 中引用
```css
.background {
  background-image: url('/reference_images/26966466.jpg');
}
```

## 注意事项

1. **路径前缀**：`public` 目录下的文件会自动映射到根路径 `/`
2. **文件组织**：建议按功能或模块组织图片，例如：
   - `public/reference_images/ui-design/`
   - `public/reference_images/workflow/`
   - `public/reference_images/screenshots/`
3. **命名规范**：使用有意义的文件名，避免特殊字符和空格

## 示例

如果你有图片 `26966466.jpg`，应该放在：
```
public/reference_images/26966466.jpg
```

然后在代码中可以通过 `/reference_images/26966466.jpg` 访问。

## 其他可选位置

如果你更喜欢将图片放在其他位置，也可以考虑：

1. **`src/assets/`**：需要导入使用
   ```tsx
   import referenceImage from '@/assets/reference_images/26966466.jpg';
   ```

2. **`src/app/`**：作为页面特定资源

但 `public/reference_images/` 是最简单直接的方式。