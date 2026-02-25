#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GPU显存检测工具
用于在Whisper加载模型前检查显存是否足够
"""

import sys
import subprocess
import json
import time

def check_gpu_memory():
    """
    检查GPU显存状态
    返回: {
        'available': bool,  # 是否有足够显存
        'total_mb': float,  # 总显存(MB)
        'used_mb': float,   # 已用显存(MB)
        'free_mb': float,   # 空闲显存(MB)
        'utilization': float,  # 显存使用率(%)
        'message': str      # 状态信息
    }
    """
    try:
        # 使用nvidia-smi查询显存信息
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.total,memory.used,memory.free', '--format=csv,noheader,nounits'],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode != 0:
            return {
                'available': False,
                'total_mb': 0,
                'used_mb': 0,
                'free_mb': 0,
                'utilization': 0,
                'message': 'nvidia-smi命令执行失败'
            }
        
        # 解析输出 (格式: total, used, free)
        values = result.stdout.strip().split(',')
        if len(values) < 3:
            return {
                'available': False,
                'total_mb': 0,
                'used_mb': 0,
                'free_mb': 0,
                'utilization': 0,
                'message': '无法解析nvidia-smi输出'
            }
        
        total_mb = float(values[0].strip())
        used_mb = float(values[1].strip())
        free_mb = float(values[2].strip())
        utilization = (used_mb / total_mb * 100) if total_mb > 0 else 0
        
        # Whisper large-v3-turbo模型大约需要3-4GB显存
        # 我们要求至少有4.5GB空闲显存才认为可用
        required_mb = 4500
        available = free_mb >= required_mb
        
        if available:
            message = f'显存充足: {free_mb:.0f}MB 可用 (需要 {required_mb}MB)'
        else:
            message = f'显存不足: 仅 {free_mb:.0f}MB 可用 (需要 {required_mb}MB)'
        
        return {
            'available': available,
            'total_mb': total_mb,
            'used_mb': used_mb,
            'free_mb': free_mb,
            'utilization': utilization,
            'message': message
        }
        
    except FileNotFoundError:
        return {
            'available': False,
            'total_mb': 0,
            'used_mb': 0,
            'free_mb': 0,
            'utilization': 0,
            'message': 'nvidia-smi未找到,可能没有安装NVIDIA驱动'
        }
    except subprocess.TimeoutExpired:
        return {
            'available': False,
            'total_mb': 0,
            'used_mb': 0,
            'free_mb': 0,
            'utilization': 0,
            'message': 'nvidia-smi执行超时'
        }
    except Exception as e:
        return {
            'available': False,
            'total_mb': 0,
            'used_mb': 0,
            'free_mb': 0,
            'utilization': 0,
            'message': f'检查显存时出错: {str(e)}'
        }

def wait_for_gpu_memory(max_wait_seconds=1800, check_interval=30):
    """
    等待显存释放
    
    Args:
        max_wait_seconds: 最大等待时间(秒),默认30分钟
        check_interval: 检查间隔(秒),默认30秒
    
    Returns:
        bool: 是否成功获得足够显存
    """
    start_time = time.time()
    check_count = 0
    
    print("🔍 开始检查GPU显存状态...")
    
    while True:
        check_count += 1
        elapsed = time.time() - start_time
        
        # 检查显存
        status = check_gpu_memory()
        
        if check_count == 1 or check_count % 6 == 0:  # 首次和每3分钟输出详细信息
            print(f"\n📊 [显存状态检查 #{check_count}]")
            print(f"   总显存: {status['total_mb']:.0f}MB")
            print(f"   已用: {status['used_mb']:.0f}MB ({status['utilization']:.1f}%)")
            print(f"   空闲: {status['free_mb']:.0f}MB")
            print(f"   状态: {status['message']}")
            print(f"   已等待: {elapsed:.0f}秒")
        else:
            print(f"⏳ 检查显存... {status['message']} (已等待 {elapsed:.0f}秒)")
        
        if status['available']:
            print(f"✅ 显存充足,可以开始处理!")
            return True
        
        # 检查是否超时
        if elapsed >= max_wait_seconds:
            print(f"\n⚠️  等待显存超时 ({max_wait_seconds}秒)")
            print(f"   当前空闲显存: {status['free_mb']:.0f}MB")
            print(f"   💡 建议: 关闭占用显存的程序(游戏、浏览器等)后重试")
            return False
        
        # 等待后重试
        time.sleep(check_interval)

if __name__ == '__main__':
    # 命令行模式
    if len(sys.argv) > 1 and sys.argv[1] == '--wait':
        # 等待模式
        max_wait = int(sys.argv[2]) if len(sys.argv) > 2 else 1800
        success = wait_for_gpu_memory(max_wait_seconds=max_wait)
        sys.exit(0 if success else 1)
    else:
        # 检查模式
        status = check_gpu_memory()
        print(json.dumps(status, ensure_ascii=False, indent=2))
        sys.exit(0 if status['available'] else 1)
