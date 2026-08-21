import contextlib
import csv
import ctypes
import os
import signal
import struct
import subprocess
import sys
import time


def log_progress(message):
    print(f"[ASR] {message}", file=sys.__stderr__ or sys.stderr, flush=True)


def set_timing(payload, key, seconds):
    timings = payload.setdefault("_timings", {})
    timings[key] = round(float(seconds), 3)


@contextlib.contextmanager
def suppress_model_output():
    """FunASR prints tqdm/rtf diagnostics to stdout/stderr for every generate call."""
    with open(os.devnull, "w", encoding="utf-8") as devnull:
        with contextlib.redirect_stdout(devnull), contextlib.redirect_stderr(devnull):
            yield


class StageTimeout:
    def __init__(self, seconds, label):
        self.seconds = int(float(seconds or 0))
        self.label = label
        self.previous_handler = None

    def __enter__(self):
        if self.seconds <= 0 or not hasattr(signal, "SIGALRM"):
            return self
        self.previous_handler = signal.getsignal(signal.SIGALRM)

        def _handler(_signum, _frame):
            raise TimeoutError(f"{self.label} 超时 {self.seconds}s")

        signal.signal(signal.SIGALRM, _handler)
        signal.alarm(self.seconds)
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.seconds > 0 and hasattr(signal, "SIGALRM"):
            signal.alarm(0)
            signal.signal(signal.SIGALRM, self.previous_handler)
        return False


def coerce_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def _resource_guard_config(payload):
    config = payload.get("resource_guard") if isinstance(payload, dict) else None
    return config if isinstance(config, dict) else {}


def _gpu_throttle_config(payload):
    config = payload.get("gpu_throttle") if isinstance(payload, dict) else None
    if isinstance(config, bool):
        config = {"enabled": config}
    return config if isinstance(config, dict) else {}


def _merged_throttle_section(payload, name):
    """Allow pressure policy to live beside either legacy config section."""
    gpu_config = _gpu_throttle_config(payload)
    resource_config = _resource_guard_config(payload)
    merged = {}
    if isinstance(gpu_config.get(name), dict):
        merged.update(gpu_config[name])
    if isinstance(resource_config.get(name), dict):
        merged.update(resource_config[name])
    return merged


def _normalize_process_name(value):
    text = str(value or "").strip().replace("\\", "/").rsplit("/", 1)[-1].lower()
    if text and not text.endswith(".exe"):
        text += ".exe"
    return text


def _list_windows_process_names():
    """Return image names from tasklist; failure is deliberately fail-open."""
    if os.name != "nt":
        return set()
    kwargs = {
        "capture_output": True,
        "text": True,
        "timeout": 3,
    }
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        result = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], **kwargs)
        if result.returncode != 0:
            return set()
        names = set()
        for row in csv.reader((result.stdout or "").splitlines()):
            if row:
                normalized = _normalize_process_name(row[0])
                if normalized:
                    names.add(normalized)
        return names
    except Exception:
        return set()


class AsrResourceGuard:
    """Pause ASR while configured interactive applications are running."""

    def __init__(self, payload, process_names_fn=None, sleep_fn=None, monotonic_fn=None):
        config = _resource_guard_config(payload)
        raw_names = config.get("game_process_names") or config.get("process_names") or []
        if isinstance(raw_names, str):
            raw_names = [raw_names]
        self.game_process_names = {
            normalized
            for normalized in (_normalize_process_name(item) for item in raw_names)
            if normalized
        }
        self.enabled = coerce_bool(config.get("enabled"), False)
        self.pause_when_game_running = coerce_bool(
            config.get("pause_when_game_running"), True
        )
        self.poll_interval_s = max(0.25, float(config.get("poll_interval_s", 3) or 3))
        self.wait_s = max(0.25, float(config.get("wait_s", 15) or 15))
        self.max_wait_s = max(0.0, float(config.get("max_wait_s", 0) or 0))
        self._process_names_fn = process_names_fn or _list_windows_process_names
        self._sleep = sleep_fn or time.sleep
        self._monotonic = monotonic_fn or time.monotonic
        self._last_check_at = None
        self._last_game_running = False
        self._failure_warned = False

    @property
    def active(self):
        return bool(
            self.enabled
            and self.pause_when_game_running
            and self.game_process_names
        )

    def game_running(self, force=False):
        if not self.active:
            return False
        now = self._monotonic()
        if (
            not force
            and self._last_check_at is not None
            and now - self._last_check_at < self.poll_interval_s
        ):
            return self._last_game_running
        try:
            observed = self._process_names_fn()
            if isinstance(observed, bool):
                running = observed
            else:
                normalized = {
                    _normalize_process_name(item)
                    for item in (observed or [])
                }
                running = bool(self.game_process_names.intersection(normalized))
            self._last_game_running = running
            self._last_check_at = now
            return running
        except Exception as exc:
            if not self._failure_warned:
                log_progress(f"游戏进程检测不可用，继续 ASR: {exc}")
                self._failure_warned = True
            self._last_game_running = False
            self._last_check_at = now
            return False

    def wait_if_game_active(self, stage):
        if not self.active:
            return 0.0

        waited = 0.0
        announced = False
        while self.game_running(force=waited > 0):
            if not announced:
                names = ", ".join(sorted(self.game_process_names))
                log_progress(f"检测到游戏运行，暂停 {stage}: {names}")
                announced = True
            if self.max_wait_s > 0 and waited >= self.max_wait_s:
                log_progress(
                    f"游戏保护等待达到上限 {self.max_wait_s:.0f}s，继续 {stage}"
                )
                return waited
            sleep_s = self.wait_s
            if self.max_wait_s > 0:
                sleep_s = min(sleep_s, max(0.25, self.max_wait_s - waited))
            self._sleep(sleep_s)
            waited += sleep_s

        if waited > 0:
            log_progress(f"游戏已退出，继续 {stage}，已等待 {waited:.0f}s")
        return waited


def _torch_thread_config(payload):
    resource_config = _resource_guard_config(payload)
    cpu_config = payload.get("cpu_throttle") if isinstance(payload, dict) else None
    cpu_config = cpu_config if isinstance(cpu_config, dict) else {}
    thread_count = resource_config.get("torch_num_threads")
    if thread_count is None:
        thread_count = cpu_config.get("torch_num_threads")
    interop_count = resource_config.get("torch_num_interop_threads")
    if interop_count is None:
        interop_count = cpu_config.get("torch_num_interop_threads")
    try:
        thread_count = max(0, int(float(thread_count))) if thread_count is not None else 0
    except (TypeError, ValueError):
        thread_count = 0
    try:
        interop_count = max(0, int(float(interop_count))) if interop_count is not None else 0
    except (TypeError, ValueError):
        interop_count = 0
    return thread_count, interop_count


def _windows_cpu_set_records(kernel32):
    get_cpu_sets = getattr(kernel32, "GetSystemCpuSetInformation", None)
    if get_cpu_sets is None:
        return []
    required = ctypes.c_ulong(0)
    get_cpu_sets(None, 0, ctypes.byref(required), None, 0)
    if required.value <= 0:
        return []
    buffer = ctypes.create_string_buffer(required.value)
    if not get_cpu_sets(buffer, required.value, ctypes.byref(required), None, 0):
        return []

    records = []
    offset = 0
    total = required.value
    while offset + 8 <= total:
        size, item_type = struct.unpack_from("<II", buffer.raw, offset)
        if size < 20 or offset + size > total:
            break
        if item_type == 0:
            cpu_set_id = struct.unpack_from("<I", buffer.raw, offset + 8)[0]
            efficiency_class = buffer.raw[offset + 18]
            records.append((cpu_set_id, efficiency_class))
        offset += size
    return records


def _apply_windows_process_policy(config):
    if os.name != "nt":
        return
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        get_current_process = kernel32.GetCurrentProcess
        get_current_process.restype = ctypes.c_void_p
        process_handle = get_current_process()
    except Exception as exc:
        log_progress(f"Windows ASR 调度策略不可用，继续运行: {exc}")
        return

    failures = []

    def apply_policy(label, callback):
        try:
            callback()
        except Exception as exc:
            failures.append(f"{label}: {exc}")

    priority_name = str(config.get("priority") or "").replace("_", "").lower()
    priority_classes = {
        "idle": 0x40,
        "belownormal": 0x4000,
        "normal": 0x20,
        "abovenormal": 0x8000,
        "high": 0x80,
    }
    priority_class = priority_classes.get(priority_name)
    if priority_class is not None:
        def apply_priority():
            set_priority = kernel32.SetPriorityClass
            set_priority.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
            set_priority.restype = ctypes.c_bool
            if not set_priority(process_handle, priority_class):
                raise ctypes.WinError(ctypes.get_last_error())
        apply_policy("进程优先级", apply_priority)

    if coerce_bool(config.get("eco_qos"), False):
        def apply_eco_qos():
            set_information = getattr(kernel32, "SetProcessInformation", None)
            if set_information is None:
                return
            set_information.argtypes = [
                ctypes.c_void_p,
                ctypes.c_int,
                ctypes.c_void_p,
                ctypes.c_uint32,
            ]
            set_information.restype = ctypes.c_bool

            class PowerThrottlingState(ctypes.Structure):
                _fields_ = [
                    ("Version", ctypes.c_uint32),
                    ("ControlMask", ctypes.c_uint32),
                    ("State", ctypes.c_uint32),
                ]

            state = PowerThrottlingState(1, 0x1, 0x1)
            if not set_information(
                process_handle,
                4,
                ctypes.byref(state),
                ctypes.sizeof(state),
            ):
                raise ctypes.WinError(ctypes.get_last_error())
        apply_policy("EcoQoS", apply_eco_qos)

    if coerce_bool(config.get("prefer_e_cores"), False):
        def apply_e_core_preference():
            set_cpu_sets = getattr(kernel32, "SetProcessDefaultCpuSets", None)
            if set_cpu_sets is None:
                return
            set_cpu_sets.argtypes = [
                ctypes.c_void_p,
                ctypes.POINTER(ctypes.c_uint32),
                ctypes.c_uint32,
            ]
            set_cpu_sets.restype = ctypes.c_bool
            records = _windows_cpu_set_records(kernel32)
            if not records:
                return
            requested_class = config.get("e_core_efficiency_class")
            if requested_class is None:
                # On Windows hybrid CPUs the highest efficiency class is the
                # scheduler's E-core class. This remains best-effort.
                requested_class = max(item[1] for item in records)
            requested_class = int(requested_class)
            selected = [
                cpu_set_id
                for cpu_set_id, efficiency_class in records
                if efficiency_class == requested_class
            ]
            if not selected:
                return
            ids = (ctypes.c_uint32 * len(selected))(*selected)
            if not set_cpu_sets(process_handle, ids, len(selected)):
                raise ctypes.WinError(ctypes.get_last_error())
            log_progress(
                f"ASR 已偏向效率核心: CPU sets={len(selected)}, class={requested_class}"
            )
        apply_policy("E-core 偏好", apply_e_core_preference)

    if failures:
        log_progress(
            "部分 Windows ASR 调度策略应用失败，继续运行: " + "; ".join(failures)
        )


def configure_torch_runtime(payload):
    """Apply thread caps after the game guard and before model construction."""
    resource_config = _resource_guard_config(payload)
    cpu_config = payload.get("cpu_throttle") if isinstance(payload, dict) else None
    cpu_config = cpu_config if isinstance(cpu_config, dict) else {}
    if not coerce_bool(resource_config.get("enabled"), False) and not coerce_bool(
        cpu_config.get("enabled"), False
    ):
        return
    thread_count, interop_count = _torch_thread_config(payload)
    if thread_count <= 0 and interop_count <= 0:
        return
    if thread_count > 0:
        os.environ["OMP_NUM_THREADS"] = str(thread_count)
        os.environ["MKL_NUM_THREADS"] = str(thread_count)
    try:
        import torch

        if thread_count > 0:
            torch.set_num_threads(thread_count)
        if interop_count > 0:
            torch.set_num_interop_threads(interop_count)
    except Exception as exc:
        log_progress(f"PyTorch 线程上限应用失败，继续运行: {exc}")


def prepare_asr_runtime(payload):
    """Set low-impact scheduling, wait for games, then configure torch threads."""
    resource_config = _resource_guard_config(payload)
    guard = AsrResourceGuard(payload)
    if coerce_bool(resource_config.get("enabled"), False):
        _apply_windows_process_policy(resource_config)
    guard.wait_if_game_active("ASR 模型加载")
    configure_torch_runtime(payload)
    return guard


class GpuThrottle:
    """Keep ASR on CUDA while reducing its foreground impact under GPU pressure."""

    def __init__(self, payload, device, sleep_fn=None):
        config = _gpu_throttle_config(payload)

        self.payload = payload
        self.enabled = coerce_bool(config.get("enabled"), False) and str(device).startswith("cuda")
        self.nvidia_smi = str(config.get("nvidia_smi") or "nvidia-smi")
        self.busy_sm_threshold = float(config.get("busy_sm_threshold", 25) or 25)
        self.busy_mem_threshold = float(config.get("busy_mem_threshold", 25) or 25)
        self.busy_fb_threshold_mb = float(config.get("busy_fb_threshold_mb", 512) or 512)
        self.check_interval_s = max(1.0, float(config.get("check_interval_s", 10) or 10))
        self.wait_s = max(1.0, float(config.get("wait_s", 20) or 20))
        self.max_wait_s = max(0.0, float(config.get("max_wait_s", 0) or 0))
        self.sample_count = max(1, int(float(config.get("pmon_sample_count", 2) or 2)))
        self.command_timeout_s = max(2.0, float(config.get("command_timeout_s", 8) or 8))
        self.segment_paraformer = coerce_bool(config.get("segment_paraformer"), True)
        self.soft_gpu = _merged_throttle_section(payload, "soft_gpu")
        self.soft_enabled = self.enabled and coerce_bool(
            self.soft_gpu.get("enabled"), False
        )
        self.soft_sm_threshold = float(self.soft_gpu.get("sm_threshold", 40) or 40)
        self.soft_mem_threshold = float(self.soft_gpu.get("mem_threshold", 40) or 40)
        self.soft_fb_threshold_mb = float(
            self.soft_gpu.get("fb_threshold_mb", 4096) or 4096
        )
        self.soft_total_memory_pct = float(
            self.soft_gpu.get("total_memory_threshold_pct", 75) or 75
        )
        self.include_total_utilization = coerce_bool(
            self.soft_gpu.get("include_total_utilization"), True
        )
        self.low_impact = _merged_throttle_section(payload, "low_impact")
        self.low_impact_batch_size_s = float(
            self.low_impact.get("batch_size_s", 30) or 30
        )
        yield_value = self.low_impact.get("yield_s")
        if yield_value is None:
            yield_value = 0.25
        self.low_impact_yield_s = max(0.0, float(yield_value))
        self.hard_wait = coerce_bool(
            config.get("hard_wait"), not self.soft_enabled
        )
        self.resource_guard = AsrResourceGuard(payload)
        self.last_check_at = 0.0
        self.last_busy = False
        self.soft_pressure = False
        self.pressure_reason = ""
        self.failure_warned = False
        self._pressure_announced = False
        self._sleep_fn = sleep_fn
        self.self_pids = {os.getpid()}
        if coerce_bool(config.get("ignore_parent_pid"), True):
            try:
                self.self_pids.add(os.getppid())
            except Exception:
                pass
        for pid in config.get("ignore_pids") or []:
            try:
                self.self_pids.add(int(pid))
            except Exception:
                pass

    def _sleep_for(self, seconds):
        (self._sleep_fn or time.sleep)(seconds)

    @staticmethod
    def _parse_metric(value):
        text = str(value or "").strip()
        if not text or text == "-":
            return None
        try:
            return float(text)
        except ValueError:
            return None

    def _run_nvidia_smi(self, args):
        kwargs = {
            "capture_output": True,
            "text": True,
            "timeout": self.command_timeout_s,
        }
        if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        proc = subprocess.run([self.nvidia_smi, *args], **kwargs)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "nvidia-smi failed").strip())
        return proc.stdout or ""

    def _sample_gpu_processes(self):
        output = self._run_nvidia_smi(
            ["pmon", "-c", str(self.sample_count), "-s", "um"]
        )
        processes = []
        for line in output.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split()
            if len(parts) < 11:
                continue
            try:
                pid = int(parts[1])
            except ValueError:
                continue
            processes.append({
                "pid": pid,
                "type": parts[2],
                "sm": self._parse_metric(parts[3]),
                "mem": self._parse_metric(parts[4]),
                "fb_mb": self._parse_metric(parts[9]),
                "name": parts[11] if len(parts) > 11 else "unknown",
            })
        return processes

    def _sample_gpu_summary(self):
        output = self._run_nvidia_smi([
            "--query-gpu=utilization.gpu,memory.used,memory.total",
            "--format=csv,noheader,nounits",
        ])
        first_line = next((line.strip() for line in output.splitlines() if line.strip()), "")
        values = [self._parse_metric(item) for item in first_line.split(",")]
        if len(values) < 3 or any(value is None for value in values[:3]):
            raise RuntimeError("nvidia-smi GPU summary 格式无效")
        return {
            "gpu_util": values[0],
            "memory_used_mb": values[1],
            "memory_total_mb": values[2],
        }

    @staticmethod
    def _matches_threshold(item, sm_threshold, mem_threshold, fb_threshold_mb):
        return (
            (item.get("sm") is not None and item["sm"] >= sm_threshold)
            or (item.get("mem") is not None and item["mem"] >= mem_threshold)
            or (item.get("fb_mb") is not None and item["fb_mb"] >= fb_threshold_mb)
        )

    @staticmethod
    def _format_process_reason(item):
        return (
            f"pid={item['pid']} name={item['name']} "
            f"sm={item.get('sm')}% mem={item.get('mem')}% fb={item.get('fb_mb')}MB"
        )

    def _external_processes(self, processes):
        return [item for item in processes if item["pid"] not in self.self_pids]

    def _is_gpu_busy(self):
        busy = [
            item
            for item in self._external_processes(self._sample_gpu_processes())
            if self._matches_threshold(
                item,
                self.busy_sm_threshold,
                self.busy_mem_threshold,
                self.busy_fb_threshold_mb,
            )
        ]
        if not busy:
            return False, ""
        busy.sort(
            key=lambda item: max(item.get("sm") or 0, item.get("mem") or 0),
            reverse=True,
        )
        return True, self._format_process_reason(busy[0])

    def _sample_pressure(self):
        """Sample CUDA and WDDM-visible pressure in one process listing pass."""
        processes = self._sample_gpu_processes()
        external = self._external_processes(processes)
        hard_items = [
            item
            for item in external
            if self._matches_threshold(
                item,
                self.busy_sm_threshold,
                self.busy_mem_threshold,
                self.busy_fb_threshold_mb,
            )
        ]
        soft_items = [
            item
            for item in external
            if self._matches_threshold(
                item,
                self.soft_sm_threshold,
                self.soft_mem_threshold,
                self.soft_fb_threshold_mb,
            )
        ]
        hard_reason = ""
        soft_reason = ""
        if hard_items:
            hard_items.sort(
                key=lambda item: max(item.get("sm") or 0, item.get("mem") or 0),
                reverse=True,
            )
            hard_reason = self._format_process_reason(hard_items[0])
        if soft_items:
            soft_items.sort(
                key=lambda item: max(item.get("sm") or 0, item.get("mem") or 0),
                reverse=True,
            )
            soft_reason = self._format_process_reason(soft_items[0])

        # Windows graphics processes frequently report '-' in pmon. The total
        # utilization sample is the useful signal for games and other 3D apps;
        # only use it when another PID is visible so our own CUDA work is not
        # mistaken for an external foreground application.
        if self.soft_enabled and self.include_total_utilization and external:
            try:
                summary = self._sample_gpu_summary()
            except Exception as exc:
                if not self.failure_warned:
                    log_progress(f"GPU 总利用率检测不可用，继续使用 pmon: {exc}")
                    self.failure_warned = True
            else:
                memory_total = summary["memory_total_mb"]
                memory_pct = (
                    summary["memory_used_mb"] / memory_total * 100
                    if memory_total > 0
                    else 0
                )
                if summary["gpu_util"] >= self.soft_sm_threshold:
                    soft_reason = (
                        f"外部 GPU 进程 {len(external)} 个，GPU 总利用率="
                        f"{summary['gpu_util']:.0f}%"
                    )
                elif memory_pct >= self.soft_total_memory_pct:
                    soft_reason = (
                        f"外部 GPU 进程 {len(external)} 个，GPU 显存使用="
                        f"{memory_pct:.0f}% ({summary['memory_used_mb']:.0f}/"
                        f"{memory_total:.0f}MB)"
                    )

        return bool(hard_items), bool(soft_reason), hard_reason, soft_reason

    def _activate_low_impact_mode(self, stage, reason):
        self.soft_pressure = True
        self.pressure_reason = reason
        self.payload["_asr_gpu_soft_pressure"] = True
        if self.low_impact_batch_size_s > 0:
            current_batch = float(self.payload.get("interactive_batch_size_s", 0) or 0)
            if current_batch <= 0 or current_batch > self.low_impact_batch_size_s:
                self.payload["interactive_batch_size_s"] = self.low_impact_batch_size_s
        if not self._pressure_announced:
            log_progress(
                f"检测到外部 GPU 压力，启用低影响 CUDA 模式: {reason}; "
                f"batch<={self.low_impact_batch_size_s:g}s, "
                f"yield={self.low_impact_yield_s:g}s"
            )
            self._pressure_announced = True
        if self.low_impact_yield_s > 0:
            self._sleep_for(self.low_impact_yield_s)

    def _clear_pressure(self, stage):
        if self.soft_pressure and self._pressure_announced:
            log_progress(f"GPU 压力下降，恢复正常 CUDA 模式: {stage}")
        self.soft_pressure = False
        self.pressure_reason = ""
        self._pressure_announced = False
        self.payload["_asr_gpu_soft_pressure"] = False

    def wait_for_model_load_gap(self, stage):
        """Wait briefly for a GPU gap before a cold model load, never indefinitely."""
        if not self.soft_enabled or not self.soft_pressure:
            return 0.0
        max_wait_s = max(
            0.0,
            float(self.low_impact.get("model_load_max_wait_s", 0) or 0),
        )
        poll_s = max(
            0.25,
            float(self.low_impact.get("model_load_poll_s", 1) or 1),
        )
        if max_wait_s <= 0:
            return 0.0

        waited = 0.0
        while waited < max_wait_s:
            sleep_s = min(poll_s, max_wait_s - waited)
            self._sleep_for(sleep_s)
            waited += sleep_s
            try:
                hard_busy, soft_busy, hard_reason, soft_reason = self._sample_pressure()
            except Exception:
                break
            self.last_check_at = time.monotonic()
            self.last_busy = hard_busy
            if not hard_busy and not soft_busy:
                self._clear_pressure(stage)
                log_progress(f"GPU 出现加载窗口，继续 {stage}，已等待 {waited:.1f}s")
                return waited
            self.soft_pressure = True
            self.pressure_reason = soft_reason or hard_reason

        if waited > 0:
            log_progress(
                f"GPU 加载窗口等待达到上限 {max_wait_s:.1f}s，"
                f"继续低影响 {stage}"
            )
        return waited

    def wait_if_busy(self, stage):
        self.resource_guard.wait_if_game_active(stage)
        if not self.enabled:
            return 0.0
        now = time.monotonic()
        if self.soft_enabled and not self.hard_wait:
            if now - self.last_check_at < self.check_interval_s:
                if self.soft_pressure:
                    self._activate_low_impact_mode(stage, self.pressure_reason)
                return 0.0
        if (
            not self.last_busy
            and not self.soft_pressure
            and now - self.last_check_at < self.check_interval_s
        ):
            return 0.0

        if self.soft_enabled:
            try:
                hard_busy, soft_busy, hard_reason, soft_reason = self._sample_pressure()
                self.last_check_at = time.monotonic()
                self.last_busy = hard_busy
                if soft_busy or hard_busy:
                    reason = soft_reason or hard_reason
                    if self.hard_wait:
                        # Explicit opt-in compatibility mode for deployments
                        # that still prefer waiting over sharing the GPU.
                        waited = 0.0
                        while True:
                            if waited <= 0:
                                log_progress(f"检测到其他 GPU 进程繁忙，暂停 {stage}: {reason}")
                            if self.max_wait_s > 0 and waited >= self.max_wait_s:
                                log_progress(
                                    f"GPU 节流等待达到上限 {self.max_wait_s:.0f}s，继续 {stage}"
                                )
                                break
                            sleep_s = self.wait_s
                            if self.max_wait_s > 0:
                                sleep_s = min(sleep_s, max(1.0, self.max_wait_s - waited))
                            self._sleep_for(sleep_s)
                            waited += sleep_s
                            try:
                                hard_busy, soft_busy, hard_reason, soft_reason = self._sample_pressure()
                            except Exception:
                                break
                            if not hard_busy and not soft_busy:
                                break
                        self.soft_pressure = bool(soft_busy or hard_busy)
                        self.pressure_reason = soft_reason or hard_reason
                        if self.soft_pressure:
                            self._activate_low_impact_mode(stage, self.pressure_reason)
                        else:
                            self._clear_pressure(stage)
                        return waited
                    self._activate_low_impact_mode(stage, reason)
                    return 0.0
                self._clear_pressure(stage)
                return 0.0
            except Exception as exc:
                if not self.failure_warned:
                    log_progress(f"GPU 节流检测不可用，继续 ASR: {exc}")
                    self.failure_warned = True
                self.last_busy = False
                self.last_check_at = time.monotonic()
                self._clear_pressure(stage)
                return 0.0

        # Legacy hard-wait behavior remains available when soft_gpu is absent.
        waited = 0.0
        while True:
            try:
                busy, reason = self._is_gpu_busy()
            except Exception as exc:
                if not self.failure_warned:
                    log_progress(f"GPU 节流检测不可用，继续 ASR: {exc}")
                    self.failure_warned = True
                self.last_busy = False
                self.last_check_at = time.monotonic()
                return waited

            self.last_busy = busy
            self.last_check_at = time.monotonic()
            if not busy:
                if waited > 0:
                    log_progress(f"GPU 已空闲，继续 {stage}，已等待 {waited:.0f}s")
                return waited

            if waited <= 0:
                log_progress(f"检测到其他 GPU 进程繁忙，暂停 {stage}: {reason}")
            if self.max_wait_s > 0 and waited >= self.max_wait_s:
                log_progress(f"GPU 节流等待达到上限 {self.max_wait_s:.0f}s，继续 {stage}")
                return waited

            sleep_s = self.wait_s
            if self.max_wait_s > 0:
                sleep_s = min(sleep_s, max(1.0, self.max_wait_s - waited))
            self._sleep_for(sleep_s)
            waited += sleep_s


def _windows_cpu_times():
    class FileTime(ctypes.Structure):
        _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]

    idle = FileTime()
    kernel = FileTime()
    user = FileTime()
    if not ctypes.windll.kernel32.GetSystemTimes(
        ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)
    ):
        raise OSError("GetSystemTimes failed")

    def _value(item):
        return (int(item.high) << 32) | int(item.low)

    return _value(idle), _value(kernel), _value(user)


def sample_cpu_percent(sample_interval_s=0.5):
    """Sample total host CPU usage using only the Python standard library."""
    interval = max(0.05, float(sample_interval_s or 0.5))
    if os.name == "nt":
        before = _windows_cpu_times()
        time.sleep(interval)
        after = _windows_cpu_times()
        idle_delta = after[0] - before[0]
        total_delta = (after[1] - before[1]) + (after[2] - before[2])
        if total_delta <= 0:
            return 0.0
        return max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0))

    load_1m = os.getloadavg()[0]
    return max(0.0, min(100.0, load_1m / max(1, os.cpu_count() or 1) * 100.0))


class CpuThrottle:
    def __init__(self, payload, sample_fn=None, sleep_fn=None, monotonic_fn=None):
        config = payload.get("cpu_throttle")
        if isinstance(config, bool):
            config = {"enabled": config}
        if not isinstance(config, dict):
            config = {}

        self.enabled = coerce_bool(config.get("enabled"), False)
        self.busy_threshold = float(config.get("busy_percent_threshold", 80) or 80)
        self.resume_threshold = float(config.get("resume_percent_threshold", 60) or 60)
        self.sample_interval_s = max(0.05, float(config.get("sample_interval_s", 0.5) or 0.5))
        self.check_interval_s = max(0.0, float(config.get("check_interval_s", 5) or 5))
        self.wait_s = max(0.05, float(config.get("wait_s", 5) or 5))
        self.max_wait_s = max(0.0, float(config.get("max_wait_s", 0) or 0))
        self.busy_samples = max(1, int(float(config.get("consecutive_busy_samples", 2) or 2)))
        self.idle_samples = max(1, int(float(config.get("consecutive_idle_samples", 2) or 2)))
        self._sample = sample_fn or (lambda: sample_cpu_percent(self.sample_interval_s))
        self._sleep = sleep_fn or time.sleep
        self._monotonic = monotonic_fn or time.monotonic
        self.last_check_at = 0.0
        self.last_busy = False
        self.failure_warned = False
        self.resource_guard = AsrResourceGuard(payload)

    def wait_if_busy(self, stage):
        self.resource_guard.wait_if_game_active(stage)
        if not self.enabled:
            return 0.0
        now = self._monotonic()
        if not self.last_busy and now - self.last_check_at < self.check_interval_s:
            return 0.0

        waited = 0.0
        consecutive_busy = 0
        consecutive_idle = 0
        announced = False
        while True:
            try:
                cpu_percent = float(self._sample())
            except Exception as exc:
                if not self.failure_warned:
                    log_progress(f"CPU 节流检测不可用，继续 {stage}: {exc}")
                    self.failure_warned = True
                self.last_busy = False
                self.last_check_at = self._monotonic()
                return waited

            self.last_check_at = self._monotonic()
            threshold = self.resume_threshold if announced else self.busy_threshold
            if cpu_percent >= threshold:
                consecutive_busy += 1
                consecutive_idle = 0
            else:
                consecutive_idle += 1
                consecutive_busy = 0

            if not announced and consecutive_busy < self.busy_samples:
                if consecutive_idle > 0:
                    self.last_busy = False
                    return waited
                continue

            if announced and consecutive_idle >= self.idle_samples:
                self.last_busy = False
                log_progress(
                    f"CPU 已恢复，继续 {stage}，当前={cpu_percent:.0f}%，已等待 {waited:.1f}s"
                )
                return waited
            if announced and consecutive_idle > 0:
                continue

            if not announced:
                announced = True
                self.last_busy = True
                log_progress(
                    f"检测到 CPU 繁忙，暂停 {stage}: 当前={cpu_percent:.0f}%，"
                    f"阈值={self.busy_threshold:.0f}%"
                )

            if self.max_wait_s > 0 and waited >= self.max_wait_s:
                log_progress(f"CPU 节流等待达到上限 {self.max_wait_s:.0f}s，继续 {stage}")
                return waited

            sleep_s = self.wait_s
            if self.max_wait_s > 0:
                sleep_s = min(sleep_s, max(0.05, self.max_wait_s - waited))
            self._sleep(sleep_s)
            waited += sleep_s
