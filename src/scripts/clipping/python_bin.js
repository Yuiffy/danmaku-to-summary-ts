// 统一解析切片链路使用的 Python 解释器。
// 本机 PATH 上可能有多个 python，装依赖的往往不是第一个；这里允许用环境变量显式指定。
const OVERRIDE_KEYS = ['CLIP_PYTHON_PATH', 'PYTHON_PATH'];

function resolvePythonBin(fallback = 'python') {
    for (const key of OVERRIDE_KEYS) {
        const value = String(process.env[key] || '').trim();
        if (value) return value;
    }
    return fallback;
}

module.exports = { resolvePythonBin, OVERRIDE_KEYS };
