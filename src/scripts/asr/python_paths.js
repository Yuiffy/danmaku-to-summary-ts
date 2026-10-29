// Compatibility extraction: JSON payload path mapping for native/WSL Python.
function normalizePathForMap(value) {
    return String(value || '').replace(/\\/g, '/');
}

function getPythonPathMap(options = {}) {
    const raw = options.python_path_map || options.pythonPathMap || [];
    if (Array.isArray(raw)) {
        return raw
            .map((item) => {
                if (Array.isArray(item) && item.length >= 2) {
                    return { from: item[0], to: item[1] };
                }
                if (item && typeof item === 'object') {
                    return { from: item.from || item.source, to: item.to || item.target };
                }
                return null;
            })
            .filter(item => item && item.from && item.to)
            .map(item => ({
                from: normalizePathForMap(item.from),
                to: normalizePathForMap(item.to)
            }))
            .sort((a, b) => b.from.length - a.from.length);
    }
    if (raw && typeof raw === 'object') {
        return Object.entries(raw)
            .map(([from, to]) => ({ from: normalizePathForMap(from), to: normalizePathForMap(to) }))
            .sort((a, b) => b.from.length - a.from.length);
    }
    return [];
}

function translatePythonPath(value, options = {}) {
    if (typeof value !== 'string' || !value.trim()) {
        return value;
    }
    const normalized = normalizePathForMap(value);
    const normalizedLower = normalized.toLowerCase();
    for (const mapping of getPythonPathMap(options)) {
        const from = mapping.from;
        const fromLower = from.toLowerCase();
        if (normalizedLower === fromLower || normalizedLower.startsWith(fromLower)) {
            const suffix = normalized.slice(from.length).replace(/^\/+/, '');
            const target = mapping.to.replace(/\/+$/, '');
            return suffix ? `${target}/${suffix}` : target;
        }
    }
    return value;
}

function shouldTranslatePayloadKey(key) {
    return /(^|_)(path|file)$/i.test(String(key || '')) || /Path$|File$/i.test(String(key || ''));
}

function translatePythonPayloadPaths(value, options = {}, key = '') {
    if (Array.isArray(value)) {
        return value.map(item => translatePythonPayloadPaths(item, options, key));
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([entryKey, entryValue]) => [
                entryKey,
                translatePythonPayloadPaths(entryValue, options, entryKey)
            ])
        );
    }
    if (typeof value === 'string' && shouldTranslatePayloadKey(key)) {
        return translatePythonPath(value, options);
    }
    return value;
}

module.exports = { translatePythonPath, translatePythonPayloadPaths };
