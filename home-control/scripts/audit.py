from __future__ import annotations

"""
Audit logger. Records every device control command to a JSONL file.
"""

import json
import os
import time
from pathlib import Path

AUDIT_PATH = os.environ.get(
    "HOME_CONTROL_AUDIT_PATH",
    os.path.expanduser("~/harness-house-jarvis/data/audit.jsonl"),
)


class AuditLogger:
    """Structured audit logging for device control commands."""

    def __init__(self, path: str = AUDIT_PATH):
        self.path = path

    def log(
        self,
        entity_id: str,
        action: str,
        result: str,
        latency_ms: int = 0,
        risk_level: str = "",
        reason: str = "",
        value: str = "",
    ) -> dict:
        """Write an audit entry. Returns the entry dict."""
        entry = {
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "epoch": int(time.time()),
            "entity_id": entity_id,
            "action": action,
            "value": value,
            "result": result,  # "executed", "blocked", "error", "confirmed"
            "latency_ms": latency_ms,
            "risk_level": risk_level,
            "reason": reason,
        }

        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        with open(self.path, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        return entry

    def recent(self, limit: int = 20) -> list[dict]:
        """Read recent audit entries."""
        if not os.path.exists(self.path):
            return []
        entries = []
        lines = Path(self.path).read_text(encoding="utf-8").strip().split("\n")
        for line in reversed(lines):
            if line.strip():
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
            if len(entries) >= limit:
                break
        return entries
