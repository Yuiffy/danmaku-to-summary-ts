#!/usr/bin/env python
"""
封面生成器 - 支持添加关键文字、标题等元素
"""
import os
import sys
import subprocess
from pathlib import Path
from typing import Optional, Tuple, List
import json

try:
    from PIL import Image, ImageDraw, ImageFont, ImageFilter
except ImportError:
    print("[ERROR] 请安装 Pillow: pip install Pillow")
    sys.exit(1)


class CoverGenerator:
    """封面生成器"""
    
    # 默认配置
    DEFAULT_CONFIG = {
        'font_path': None,  # 会自动查找系统中文字体（优先粗体）
        'title_font_size': 110,
        'subtitle_font_size': 52,
        'title_max_chars_per_line': 16,  # 每行最大字符数（自动换行）
        'title_line_spacing': 16,  # 行间距
        'text_color': (255, 255, 255),  # 白色
        'stroke_color': (0, 0, 0),  # 描边颜色（纯黑）
        'stroke_width': 7,  # 描边宽度（像素）
        'subtitle_stroke_width': 4,  # 副标题描边宽度
        'padding': 40,  # 文字边距
        'output_size': (1920, 1200),  # B站推荐封面尺寸 16:10
    }
    
    def __init__(self, config: Optional[dict] = None):
        self.config = {**self.DEFAULT_CONFIG, **(config or {})}
        self.font_path = self._find_font()
    
    def _find_font(self) -> str:
        """查找系统中的中文字体"""
        if self.config.get('font_path') and os.path.exists(self.config['font_path']):
            return self.config['font_path']
        
        # Windows 常见中文字体路径
        font_candidates = [
            # 粗体优先（封面文字需要醒目）
            'C:/Windows/Fonts/msyhbd.ttc',  # 微软雅黑粗体
            'C:/Windows/Fonts/msyhl.ttc',   # 微软雅黑细体
            'C:/Windows/Fonts/msyh.ttc',    # 微软雅黑常规
            # 思源黑体
            'C:/Windows/Fonts/NotoSansCJK-Bold.ttc',
            'C:/Windows/Fonts/NotoSansCJK-Regular.ttc',
            'C:/Windows/Fonts/SourceHanSans-Bold.ttc',
            'C:/Windows/Fonts/SourceHanSans-Regular.ttc',
            # 黑体
            'C:/Windows/Fonts/simhei.ttf',
            # 用户目录字体
            os.path.expanduser('~/AppData/Local/Microsoft/Windows/Fonts/msyhbd.ttc'),
            os.path.expanduser('~/AppData/Local/Microsoft/Windows/Fonts/msyh.ttc'),
        ]
        
        for font_path in font_candidates:
            if os.path.exists(font_path):
                print(f"[INFO] 使用字体: {font_path}")
                return font_path
        
        print("[WARN] 未找到中文字体，使用默认字体")
        return None
    
    def _load_font(self, size: int):
        """加载字体"""
        try:
            if self.font_path:
                return ImageFont.truetype(self.font_path, size)
            else:
                return ImageFont.load_default()
        except Exception as e:
            print(f"[WARN] 加载字体失败: {e}，使用默认字体")
            return ImageFont.load_default()
    
    @staticmethod
    def _wrap_text(text: str, max_chars: int) -> list:
        """
        将文本按最大字符数自动换行。
        支持中文（按字符分割）和英文（尽量按空格分割）。
        """
        if len(text) <= max_chars:
            return [text]
        
        lines = []
        current = ''
        for char in text:
            # 中文字符或当前行加一个字符仍在限制内
            if len(current) + 1 <= max_chars:
                current += char
            else:
                # 如果是英文，尝试在最近的空格处断行
                if ' ' in current:
                    # 找最后一个空格
                    last_space = current.rfind(' ')
                    lines.append(current[:last_space])
                    current = current[last_space + 1:] + char
                else:
                    lines.append(current)
                    current = char
        if current:
            lines.append(current)
        return lines
    
    def extract_frame(self, video_path: str, timestamp: float = 0.0, output_path: str = None) -> str:
        """
        从视频截取关键帧
        
        Args:
            video_path: 视频路径
            timestamp: 截取时间戳（秒），0表示第一帧
            output_path: 输出图片路径，None则自动生成
        
        Returns:
            截取的图片路径
        """
        if not os.path.exists(video_path):
            raise FileNotFoundError(f"视频文件不存在: {video_path}")
        
        if output_path is None:
            base_dir = os.path.dirname(video_path)
            output_path = os.path.join(base_dir, f'_cover_frame_{int(timestamp)}.jpg')
        
        # 使用 ffmpeg 截取指定时间戳的画面
        cmd = [
            'ffmpeg',
            '-i', video_path,
            '-ss', str(timestamp),  # 定位到指定时间
            '-vframes', '1',
            '-q:v', '2',  # 高质量
            '-loglevel', 'error',
            output_path,
            '-y'
        ]
        
        try:
            subprocess.run(cmd, check=True, timeout=30)
            print(f"[INFO] 已截取视频帧: {output_path} (time={timestamp}s)")
            return output_path
        except Exception as e:
            raise RuntimeError(f"截取视频帧失败: {e}")
    
    def find_key_frame(self, video_path: str, duration_ratio: float = 0.1) -> float:
        """
        查找关键帧（简单策略：取视频前10%位置）
        可扩展为：检测场景变化、检测人脸、检测高光时刻等
        
        Args:
            video_path: 视频路径
            duration_ratio: 关键帧位置占视频时长的比例
        
        Returns:
            关键帧时间戳（秒）
        """
        try:
            # 使用 ffprobe 获取视频时长
            cmd = [
                'ffprobe',
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'json',
                video_path
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            data = json.loads(result.stdout)
            duration = float(data['format']['duration'])
            
            # 取视频前10%位置（避免黑屏开头）
            timestamp = duration * duration_ratio
            print(f"[INFO] 视频时长: {duration:.1f}s, 关键帧位置: {timestamp:.1f}s")
            return timestamp
        except Exception as e:
            print(f"[WARN] 获取视频时长失败: {e}，使用第一帧")
            return 0.0
    
    def add_text_to_cover(
        self,
        image_path: str,
        title: str,
        subtitle: Optional[str] = None,
        output_path: Optional[str] = None,
        text_position: str = 'center',  # 'top', 'bottom', 'center'
        with_shadow: bool = False,  # 保留参数但默认关闭（用描边替代）
        with_bg_bar: bool = False,  # 保留参数但默认关闭
    ) -> str:
        """
        在封面上添加文字（居中、描边样式，无背景条）
        
        Args:
            image_path: 原始图片路径
            title: 主标题（必填）
            subtitle: 副标题（可选）
            output_path: 输出路径，None则自动生成
            text_position: 文字位置（默认居中）
            with_shadow: 已弃用（用描边替代）
            with_bg_bar: 已弃用（无背景条）
        
        Returns:
            生成的封面路径
        """
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"图片不存在: {image_path}")
        
        # 打开图片
        img = Image.open(image_path).convert('RGB')
        
        # 调整尺寸为推荐封面尺寸
        target_size = self.config['output_size']
        img = img.resize(target_size, Image.Resampling.LANCZOS)
        
        # 创建绘图层
        draw = ImageDraw.Draw(img)
        
        # 加载字体
        title_font = self._load_font(self.config['title_font_size'])
        subtitle_font = self._load_font(self.config['subtitle_font_size'])
        
        text_color = self.config['text_color']
        stroke_color = self.config['stroke_color']
        stroke_width = self.config['stroke_width']
        subtitle_stroke_width = self.config['subtitle_stroke_width']
        
        # 使用 textbbox + anchor='mm' 精确测量
        # 计算主标题尺寸（用 mm anchor 更准确）
        title_bbox = draw.textbbox((0, 0), title, font=title_font, anchor='mm')
        title_width = title_bbox[2] - title_bbox[0]
        title_height = title_bbox[3] - title_bbox[1]
        
        # 计算副标题尺寸
        if subtitle:
            subtitle_bbox = draw.textbbox((0, 0), subtitle, font=subtitle_font, anchor='mm')
            subtitle_width = subtitle_bbox[2] - subtitle_bbox[0]
            subtitle_height = subtitle_bbox[3] - subtitle_bbox[1]
        else:
            subtitle_width = 0
            subtitle_height = 0
        
        # 总文字高度（标题 + 间距 + 副标题）
        title_subtitle_gap = 20
        total_text_height = title_height + (subtitle_height + title_subtitle_gap if subtitle else 0)
        
        # 确定文字中心 Y 坐标
        img_width, img_height = target_size
        padding = self.config['padding']
        
        if text_position == 'top':
            center_y = padding + total_text_height // 2
        elif text_position == 'center':
            center_y = int(img_height * 0.72)  # 偏下，避免挡住人脸
        else:  # bottom
            center_y = img_height - padding - total_text_height // 2
        
        # 计算标题和副标题的基线 Y
        if subtitle:
            title_center_y = center_y - (subtitle_height + title_subtitle_gap) // 2
            subtitle_center_y = center_y + (title_height + title_subtitle_gap) // 2
        else:
            title_center_y = center_y
            subtitle_center_y = center_y
        
        # 自动换行：将标题按最大字符数分行
        max_chars = self.config.get('title_max_chars_per_line', 16)
        title_lines = self._wrap_text(title, max_chars)
        line_spacing = self.config.get('title_line_spacing', 16)
        
        # 重新计算多行标题的总高度
        single_title_height = title_height
        if len(title_lines) > 1:
            title_total_height = title_height * len(title_lines) + line_spacing * (len(title_lines) - 1)
        else:
            title_total_height = title_height
        
        # 重新计算位置（因为多行高度变了）
        total_text_height = title_total_height + (subtitle_height + title_subtitle_gap if subtitle else 0)
        
        if text_position == 'top':
            center_y = padding + total_text_height // 2
        elif text_position == 'center':
            center_y = int(img_height * 0.72)
        else:
            center_y = img_height - padding - total_text_height // 2
        
        if subtitle:
            title_center_y = center_y - (subtitle_height + title_subtitle_gap) // 2
            subtitle_center_y = center_y + (title_total_height + title_subtitle_gap) // 2
        else:
            title_center_y = center_y
            subtitle_center_y = center_y
        
        # 绘制主标题（逐行绘制，居中 + 描边）
        title_x = img_width // 2
        if len(title_lines) == 1:
            draw.text(
                (title_x, title_center_y),
                title,
                font=title_font,
                fill=text_color,
                stroke_width=stroke_width,
                stroke_fill=stroke_color,
                anchor='mm',
            )
        else:
            # 多行：从 title_center_y 向上下展开
            block_height = title_height * len(title_lines) + line_spacing * (len(title_lines) - 1)
            first_line_y = title_center_y - block_height // 2 + title_height // 2
            for i, line in enumerate(title_lines):
                line_y = first_line_y + i * (title_height + line_spacing)
                draw.text(
                    (title_x, line_y),
                    line,
                    font=title_font,
                    fill=text_color,
                    stroke_width=stroke_width,
                    stroke_fill=stroke_color,
                    anchor='mm',
                )
        
        # 绘制副标题
        if subtitle:
            subtitle_x = img_width // 2
            draw.text(
                (subtitle_x, subtitle_center_y),
                subtitle,
                font=subtitle_font,
                fill=text_color,
                stroke_width=subtitle_stroke_width,
                stroke_fill=stroke_color,
                anchor='mm',
            )
        
        # 保存结果
        if output_path is None:
            base_dir = os.path.dirname(image_path)
            output_path = os.path.join(base_dir, '_cover_with_text.jpg')
        
        img.save(output_path, 'JPEG', quality=95)
        print(f"[INFO] 封面已生成: {output_path}")
        
        return output_path
    
    def generate_cover(
        self,
        video_path: str,
        title: str,
        subtitle: Optional[str] = None,
        output_path: Optional[str] = None,
        use_key_frame: bool = True,
    ) -> str:
        """
        完整封面生成流程：截取帧 -> 添加文字
        
        Args:
            video_path: 视频路径
            title: 主标题
            subtitle: 副标题
            output_path: 输出路径
            use_key_frame: 是否使用关键帧（否则用第一帧）
        
        Returns:
            生成的封面路径
        """
        # 1. 截取视频帧
        if use_key_frame:
            timestamp = self.find_key_frame(video_path)
        else:
            timestamp = 0.0
        
        frame_path = self.extract_frame(video_path, timestamp)
        
        # 2. 添加文字
        final_path = self.add_text_to_cover(
            image_path=frame_path,
            title=title,
            subtitle=subtitle,
            output_path=output_path,
        )
        
        # 3. 清理临时帧文件（可选）
        if frame_path != final_path and os.path.exists(frame_path):
            try:
                os.remove(frame_path)
            except:
                pass
        
        return final_path


def main():
    """命令行测试"""
    import argparse
    
    parser = argparse.ArgumentParser(description='封面生成器')
    parser.add_argument('video', help='视频文件路径')
    parser.add_argument('--title', required=True, help='主标题')
    parser.add_argument('--subtitle', default=None, help='副标题')
    parser.add_argument('--output', default=None, help='输出路径')
    parser.add_argument('--font-size', type=int, default=110, help='标题字体大小 (默认110)')
    parser.add_argument('--position', default='center', choices=['top', 'center', 'bottom'], help='文字位置 (默认居中)')
    parser.add_argument('--no-shadow', action='store_true', help='(已弃用) 兼容旧参数')
    parser.add_argument('--no-bg', action='store_true', help='(已弃用) 兼容旧参数')
    parser.add_argument('--key-frame', action='store_true', help='使用关键帧（而非第一帧）')
    
    args = parser.parse_args()
    
    # 创建生成器
    config = {
        'title_font_size': args.font_size,
    }
    generator = CoverGenerator(config)
    
    # 生成封面
    output = generator.generate_cover(
        video_path=args.video,
        title=args.title,
        subtitle=args.subtitle,
        output_path=args.output,
        use_key_frame=args.key_frame,
    )
    
    print(f"\n✅ 封面生成成功: {output}")
    return 0


if __name__ == '__main__':
    sys.exit(main() or 0)
