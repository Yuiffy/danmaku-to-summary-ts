"""Pure admission decisions; timestamps are epoch seconds, days use Shanghai time."""
from __future__ import annotations

DEFAULT_LIMITS = dict(dailyLimit=300, userDailyLimit=30, userWindowLimit=10,
                      intervalSeconds=60, maxActive=1, independentInterval=False)


def policy(payload):
    value = payload.get("admission", DEFAULT_LIMITS)
    if not isinstance(value, dict) or set(value) != set(DEFAULT_LIMITS):
        raise ValueError("invalid admission policy")
    for key, upper in (("dailyLimit", 300), ("userDailyLimit", 300), ("userWindowLimit", 50),
                       ("intervalSeconds", 3600), ("maxActive", 4)):
        if type(value[key]) is not int or not 1 <= value[key] <= upper:
            raise ValueError("invalid admission limit")
    if type(value["independentInterval"]) is not bool:
        raise ValueError("invalid interval policy")
    return value


def admitted_at(task):
    if "qq_admitted_at" in task:
        return task["qq_admitted_at"]
    return task.get("created_at") if task.get("status") not in {"draft", "cancelled"} else None


def admission(tasks, owner, limits, now, exclude=None):
    scoped = [task for task in tasks if task.get("qq", {}).get("app") == owner["app"] and task.get("id") != exclude]
    mine = [task for task in scoped if task["qq"]["user"] == owner["user"]]
    if sum(task.get("status") in {"pending", "submitted", "needs_review", "paused"} for task in mine) >= limits["maxActive"]:
        return dict(status="busy")
    history = sorted((at, task["qq"]["user"]) for task in scoped if isinstance((at := admitted_at(task)), int))
    personal = [at for at, user in history if user == owner["user"]]
    midnight = ((now + 28800) // 86400 + 1) * 86400 - 28800
    today = midnight - 86400
    window = [at for at in personal if at > now - 18000]
    gates = []
    if sum(at >= today for at in personal) >= limits["userDailyLimit"]:
        gates.append(("user_daily", midnight))
    if len(window) >= limits["userWindowLimit"]:
        gates.append(("user_window", window[-limits["userWindowLimit"]] + 18000))
    if sum(at >= today for at, _ in history) >= limits["dailyLimit"]:
        gates.append(("global_daily", midnight))
    starts = personal if limits["independentInterval"] else [at for at, _ in history]
    if starts and starts[-1] + limits["intervalSeconds"] > now:
        gates.append(("user_interval" if limits["independentInterval"] else "interval", starts[-1] + limits["intervalSeconds"]))
    if gates:
        return dict(status="limited", limitReason=gates[0][0], retryAt=max(until for _, until in gates) * 1000)
    return None
