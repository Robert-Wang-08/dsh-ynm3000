"""Configuration, time and redaction shared by the health reporter."""
import hashlib
import json
import os
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

CST = timezone(timedelta(hours=8))

def instant(value):
    try:
        if isinstance(value, (float, int)) and not isinstance(value, bool):
            return datetime.fromtimestamp(value / 1000, timezone.utc)
        if isinstance(value, str) and value:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else None
    except (ValueError, OverflowError, OSError):
        pass
    return None

def iso(value):
    dt = instant(value)
    return dt.isoformat() if dt else None

def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:24]

def safe_text(value, limit=240):
    text = " ".join(str(value or "").split())
    text = re.sub(r"(?i)(?:bearer|api[_-]?key|app[_-]?secret|access[_-]?token|password)\s*[:= ]\s*[^ ,;]+", "[REDACTED]", text)
    text = re.sub(r"(?i)sk-[A-Za-z0-9_-]{12,}", "[REDACTED]", text)
    text = re.sub(r"(?:oc_|ou_|om_)[A-Za-z0-9_-]{8,}", "[ID]", text)
    text = re.sub(r"[A-Za-z]:[\\/][^，。；; ]+", "[本地路径]", text)
    return text[:limit] or "暂无可用摘要"

def atomic_text(file, text):
    target = Path(file)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, target)

def load_config(file):
    config = json.loads(Path(file).read_text(encoding="utf-8-sig"))
    config["home"] = str(Path(os.path.expandvars(config.get("home") or str(Path.home() / ".dsh"))))
    config["state_dir"] = str(Path(os.path.expandvars(config.get("state_dir") or str(Path.home() / ".dsh/state/superagent-health"))))
    if not isinstance(config.get("instances"), list) or not config["instances"]:
        raise ValueError("instances is required")
    ids = [i["id"] for i in config["instances"]]
    if len(ids) != len(set(ids)):
        raise ValueError("instance ids must be unique")
    for item in config["instances"]:
        from urllib.parse import urlparse
        url = urlparse(item["url"])
        if url.scheme != "http" or url.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("management endpoint must be loopback HTTP")
    return config
