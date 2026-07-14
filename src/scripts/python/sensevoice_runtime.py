import contextlib
import os
import signal
import subprocess
import sys
import time


def log_progress(message):
    print(f"[ASR] {message}", file=sys.stderr, flush=True)


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


class GpuThrottle:
    def __init__(self, payload, device):
        config = payload.get("gpu_throttle")
        if isinstance(config, bool):
            config = {"enabled": config}
        if not isinstance(config, dict):
            config = {}

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
        self.last_check_at = 0.0
        self.last_busy = False
        self.failure_warned = False
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

    @staticmethod
    def _parse_metric(value):
        text = str(value or "").strip()
        if not text or text == "-":
            return None
        try:
            return float(text)
        except ValueError:
            return None

    def _sample_gpu_processes(self):
        cmd = [self.nvidia_smi, "pmon", "-c", str(self.sample_count), "-s", "um"]
        kwargs = {
            "capture_output": True,
            "text": True,
            "timeout": self.command_timeout_s,
        }
        if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        proc = subprocess.run(cmd, **kwargs)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "nvidia-smi pmon failed").strip())

        processes = []
        for line in proc.stdout.splitlines():
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

    def _is_gpu_busy(self):
        busy = []
        for item in self._sample_gpu_processes():
            if item["pid"] in self.self_pids:
                continue
            sm = item.get("sm")
            mem = item.get("mem")
            fb_mb = item.get("fb_mb")
            if (
                (sm is not None and sm >= self.busy_sm_threshold)
                or (mem is not None and mem >= self.busy_mem_threshold)
                or (fb_mb is not None and fb_mb >= self.busy_fb_threshold_mb)
            ):
                busy.append(item)
        if not busy:
            return False, ""
        busy.sort(key=lambda item: max(item.get("sm") or 0, item.get("mem") or 0), reverse=True)
        item = busy[0]
        return True, (
            f"pid={item['pid']} name={item['name']} "
            f"sm={item.get('sm')}% mem={item.get('mem')}% fb={item.get('fb_mb')}MB"
        )

    def wait_if_busy(self, stage):
        if not self.enabled:
            return
        now = time.monotonic()
        if not self.last_busy and now - self.last_check_at < self.check_interval_s:
            return

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
                return

            self.last_busy = busy
            self.last_check_at = time.monotonic()
            if not busy:
                if waited > 0:
                    log_progress(f"GPU 已空闲，继续 {stage}，已等待 {waited:.0f}s")
                return

            if waited <= 0:
                log_progress(f"检测到其他 GPU 进程繁忙，暂停 {stage}: {reason}")
            if self.max_wait_s > 0 and waited >= self.max_wait_s:
                log_progress(f"GPU 节流等待达到上限 {self.max_wait_s:.0f}s，继续 {stage}")
                return

            sleep_s = self.wait_s
            if self.max_wait_s > 0:
                sleep_s = min(sleep_s, max(1.0, self.max_wait_s - waited))
            time.sleep(sleep_s)
            waited += sleep_s
