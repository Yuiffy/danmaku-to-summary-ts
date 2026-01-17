import requests
import json
import os
import sys
import time
import traceback
import locale

# 设置编码
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# 获取项目配置
def get_config_path():
    """获取配置文件路径，优先级: /config/production.json > /config/default.json > /src/scripts/config.json"""
    env = os.environ.get('NODE_ENV', 'development')
    # 脚本在 src/scripts 目录，外部配置在 config 目录
    scripts_dir = os.path.dirname(__file__)
    project_root = os.path.dirname(os.path.dirname(scripts_dir))
    config_dir = os.path.join(project_root, 'config')
    
    # 优先级顺序
    possible_paths = [
        os.path.join(config_dir, 'production.json' if env == 'production' else 'default.json'),
        os.path.join(config_dir, 'default.json'),
        os.path.join(os.path.dirname(__file__), 'config.json'),
    ]
    
    print(f"[DEBUG] 查找配置文件路径...")
    for config_path in possible_paths:
        print(f"[DEBUG] 检查路径: {config_path} (存在: {os.path.exists(config_path)})")
        if os.path.exists(config_path):
            print(f"[DEBUG] 找到配置文件: {config_path}")
            return config_path
    
    # 如果都不存在，返回脚本目录的config.json
    fallback_path = os.path.join(os.path.dirname(__file__), 'config.json')
    print(f"[DEBUG] 未找到配置文件，使用备用路径: {fallback_path}")
    return fallback_path

CONFIG_PATH = get_config_path()

def load_config():
    """加载配置文件"""
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                return json.load(f)
    except Exception as e:
        print(f"[ERROR] 加载配置文件失败: {e}")
        traceback.print_exc()
    
    return {}

def is_tuzi_configured(config):
    """检查tuZi图像生成配置是否有效"""
    tuzi_config = config.get("ai", {}).get("comic", {}).get("tuZi", {})
    return tuzi_config.get("enabled", False) and tuzi_config.get("apiKey", "") and tuzi_config["apiKey"].strip() != ""

def test_tuzi_api():
    """测试tuZi API连接"""
    print("测试tuZi API连接...")
    
    # 加载配置
    config = load_config()
    if not config:
        print("[ERROR] 无法加载配置文件")
        return False
    
    # 检查配置
    if not is_tuzi_configured(config):
        print("[ERROR] tuZi API未配置或未启用")
        return False
    
    tuzi_config = config["ai"]["comic"]["tuZi"]
    api_key = tuzi_config["apiKey"]
    base_url = tuzi_config.get("baseUrl", "https://api.tu-zi.com")
    
    # 设置代理
    proxy_url = tuzi_config.get("proxy", "")
    proxies = {}
    if proxy_url:
        proxies = {
            "http": proxy_url,
            "https": proxy_url
        }
        print(f"使用代理: {proxy_url}")
    
    # 构建API请求
    api_url = f"{base_url}/v1/chat/completions"
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json"
    }
    
    # 简单的测试提示词
    payload = {
        "model": tuzi_config.get("model", "nano-banana"),
        "messages": [
            {
                "role": "user",
                "content": "Hello, this is a test message."
            }
        ],
        "temperature": 0.7,
        "max_tokens": 100
    }
    
    print(f"正在调用API: {api_url}")
    
    try:
        response = requests.post(api_url, headers=headers, json=payload, timeout=30, proxies=proxies)
        
        print(f"[INFO] 响应状态码: {response.status_code}")
        print(f"[INFO] 响应头: {dict(response.headers)}")
        
        if response.status_code == 200:
            result = response.json()
            print("[SUCCESS] API调用成功")
            print(f"[INFO] 响应内容: {json.dumps(result, ensure_ascii=False, indent=2)[:500]}...")
            return True
        else:
            print(f"[ERROR] API调用失败: {response.status_code}")
            print(f"[INFO] 响应内容: {response.text[:500]}...")
            return False
            
    except requests.exceptions.Timeout:
        print("[ERROR] 请求超时")
        return False
    except requests.exceptions.ConnectionError as e:
        print(f"[ERROR] 连接错误: {e}")
        return False
    except Exception as e:
        print(f"[ERROR] 其他错误: {e}")
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_tuzi_api()
    sys.exit(0 if success else 1)