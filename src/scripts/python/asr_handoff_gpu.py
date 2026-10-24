"""Windows GPU engine counters: exclude our model PID without pausing inference."""
import ctypes
import math
import os
import re


def external_engines(rows, own_pid):
    engines = {}
    for name, value, status in rows:
        if status not in (0, 1) or not math.isfinite(value) or value < 0:
            continue
        match = re.fullmatch(r'pid_(\d+)_(.+)', name)
        if not match or int(match[1]) == own_pid:
            continue
        engine = match[2]
        engines[engine] = engines.get(engine, 0) + value
    # Processes share an engine; summing different engines would double-count
    # parallel work. Across adapters this is deliberately conservative.
    return min(100, max(engines.values(), default=0))


class WindowsGpuCounters:
    def __init__(self):
        self.query = ctypes.c_void_p()
        self.util = ctypes.c_void_p()
        self.memory = ctypes.c_void_p()
        self.ready = False
        if os.name != 'nt':
            return
        from ctypes import wintypes as w
        class Value(ctypes.Structure):
            _fields_ = [('status', w.DWORD), ('value', ctypes.c_double)]
        class Item(ctypes.Structure):
            _fields_ = [('name', w.LPWSTR), ('value', Value)]
        self.Item = Item
        self.api = ctypes.WinDLL('pdh')
        self.api.PdhOpenQueryW.argtypes = [w.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(ctypes.c_void_p)]
        self.api.PdhAddEnglishCounterW.argtypes = [ctypes.c_void_p, w.LPCWSTR, ctypes.c_size_t, ctypes.POINTER(ctypes.c_void_p)]
        self.api.PdhCollectQueryData.argtypes = [ctypes.c_void_p]
        self.api.PdhGetFormattedCounterArrayW.argtypes = [ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD), ctypes.POINTER(w.DWORD), ctypes.c_void_p]
        self.api.PdhCloseQuery.argtypes = [ctypes.c_void_p]
        try:
            if self.api.PdhOpenQueryW(None, 0, ctypes.byref(self.query)):
                raise OSError('GPU counter query unavailable')
            for target, name in ((self.util, r'\GPU Engine(*)\Utilization Percentage'),
                                 (self.memory, r'\GPU Process Memory(*)\Dedicated Usage')):
                if self.api.PdhAddEnglishCounterW(self.query, name, 0, ctypes.byref(target)):
                    raise OSError('GPU counter unavailable')
            self.api.PdhCollectQueryData(self.query)  # Rate counters require two observations.
            self.ready = True
        except OSError:
            self.close()

    def _rows(self, counter):
        from ctypes import wintypes as w
        size, count = w.DWORD(), w.DWORD()
        self.api.PdhGetFormattedCounterArrayW(counter, 0x200, ctypes.byref(size), ctypes.byref(count), None)
        if not 0 < size.value <= 16 * 1024 * 1024:
            return None
        buffer = ctypes.create_string_buffer(size.value)
        if self.api.PdhGetFormattedCounterArrayW(counter, 0x200, ctypes.byref(size), ctypes.byref(count), buffer):
            return None
        items = ctypes.cast(buffer, ctypes.POINTER(self.Item))
        return [(items[i].name or '', items[i].value.value, items[i].value.status) for i in range(count.value)]

    def sample(self, own_pid=None):
        if not self.ready or self.api.PdhCollectQueryData(self.query):
            return None
        rows, memory = self._rows(self.util), self._rows(self.memory)
        if not rows or not any(status in (0, 1) for _, _, status in rows):
            return None
        own_mb = None
        if own_pid and memory is not None:
            own_mb = sum(value for name, value, status in memory
                         if name.startswith(f'pid_{own_pid}_') and status in (0, 1)
                         and math.isfinite(value) and value >= 0) / 1024 ** 2
        return {'external_util_pct': external_engines(rows, own_pid), 'owned_gpu_mb': own_mb}

    def close(self):
        if self.query.value:
            self.api.PdhCloseQuery(self.query)
            self.query = ctypes.c_void_p()
        self.ready = False
