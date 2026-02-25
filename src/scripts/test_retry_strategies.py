#!/usr/bin/env python3
"""
测试图片生成重试策略配置
验证策略列表的构建和去重逻辑
"""

def test_retry_strategies():
    """测试重试策略配置"""
    
    # 模拟传入的 model 参数
    model = "nano-banana"
    
    # ========== 图片生成重试策略配置 ==========
    # 每个策略包含：type (sync/async) 和 model
    # 可以通过调整列表顺序来改变重试优先级
    retry_strategies = [
        # 第一顺位：Gemini 异步 API（失败不扣费，成本低）
        {"type": "async", "model": "gemini-3-pro-image-preview-async"},
        # 第二顺位：nano-banana（原第一顺位）
        {"type": "sync", "model": model},
        # 第三顺位及以后：其他备选模型
        {"type": "sync", "model": "gpt-image-1.5"},
        {"type": "sync", "model": "gemini-2.5-flash-image-vip"},
        {"type": "sync", "model": "gemini-3-pro-image-preview/nano-banana-2"},
    ]
    
    # 去重：如果传入的 model 已经在列表中，移除重复项
    seen_models = set()
    unique_strategies = []
    for strategy in retry_strategies:
        strategy_key = f"{strategy['type']}:{strategy['model']}"
        if strategy_key not in seen_models:
            seen_models.add(strategy_key)
            unique_strategies.append(strategy)
    retry_strategies = unique_strategies
    
    strategy_list = [f"{s['type']}:{s['model']}" for s in retry_strategies]
    print(f"[INFO] 图片生成重试策略: {strategy_list}")
    # ========================================
    
    # 验证结果
    print("\n=== 策略详情 ===")
    for i, strategy in enumerate(retry_strategies, 1):
        print(f"{i}. 类型: {strategy['type']:6s} | 模型: {strategy['model']}")
    
    print(f"\n总共 {len(retry_strategies)} 个策略")
    
    # 验证第一个是异步策略
    assert retry_strategies[0]['type'] == 'async', "第一个策略应该是异步类型"
    assert retry_strategies[0]['model'] == 'gemini-3-pro-image-preview-async', "第一个策略应该是 Gemini 异步"
    
    # 验证第二个是 nano-banana
    assert retry_strategies[1]['type'] == 'sync', "第二个策略应该是同步类型"
    assert retry_strategies[1]['model'] == 'nano-banana', "第二个策略应该是 nano-banana"
    
    print("\n✅ 所有验证通过！")

if __name__ == "__main__":
    test_retry_strategies()
