#!/usr/bin/env python3
"""
Preference Manager — records command patterns and persists to Obsidian.

Tracks how the user interacts with devices, identifies patterns, and
saves preferences to the Obsidian vault for LLM context injection.
"""
from __future__ import annotations

import json
import os
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

OBSIDIAN_VAULT = os.environ.get(
    "OBSIDIAN_VAULT",
    os.path.expanduser("~/Documents/Obsidian-Vault"),
)
PREFERENCES_DIR = os.path.join(OBSIDIAN_VAULT, "home-control", "preferences")
PREFERENCE_LOG = os.path.join(PREFERENCES_DIR, "command-log.jsonl")
PREFERENCE_NOTE = os.path.join(PREFERENCES_DIR, "user-preferences.md")


class PreferenceManager:
    """Records and analyzes user command patterns."""

    def __init__(
        self,
        log_path: str = PREFERENCE_LOG,
        note_path: str = PREFERENCE_NOTE,
    ):
        self.log_path = log_path
        self.note_path = note_path
        os.makedirs(os.path.dirname(log_path), exist_ok=True)

    def record(
        self,
        entity_id: str,
        action: str,
        value: str = "",
        room: str = "",
        timestamp: str | None = None,
    ) -> dict:
        """Record a command observation."""
        if timestamp is None:
            timestamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")

        entry = {
            "timestamp": timestamp,
            "epoch": int(time.time()),
            "entity_id": entity_id,
            "action": action,
            "value": value,
            "room": room,
        }

        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        return entry

    def load_observations(self, limit: int = 500) -> list[dict]:
        """Load recent command observations."""
        if not os.path.exists(self.log_path):
            return []

        entries = []
        with open(self.log_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue

        return entries[-limit:]

    def analyze_patterns(self) -> dict:
        """Analyze command patterns from observations."""
        observations = self.load_observations()

        if not observations:
            return {
                "total_commands": 0,
                "top_devices": [],
                "top_actions": [],
                "time_patterns": [],
                "room_patterns": [],
                "suggestions": [],
            }

        # Top devices
        device_counter = Counter(obs["entity_id"] for obs in observations)
        top_devices = device_counter.most_common(10)

        # Top actions
        action_counter = Counter(
            f"{obs['entity_id']}.{obs['action']}" for obs in observations
        )
        top_actions = action_counter.most_common(10)

        # Time patterns (hour of day)
        hour_counter = Counter()
        for obs in observations:
            try:
                ts = obs.get("timestamp", "")
                # Extract hour from ISO timestamp
                hour_match = re.search(r"T(\d{2}):", ts)
                if hour_match:
                    hour_counter[int(hour_match.group(1))] += 1
            except Exception:
                continue

        time_patterns = [
            {"hour": h, "count": c}
            for h, c in sorted(hour_counter.items())
            if c >= 2  # Only show hours with 2+ commands
        ]

        # Room patterns
        room_counter = Counter(obs.get("room", "unknown") for obs in observations)
        room_patterns = room_counter.most_common(10)

        # Generate suggestions
        suggestions = self._generate_suggestions(
            observations, top_devices, time_patterns
        )

        return {
            "total_commands": len(observations),
            "top_devices": [{"entity_id": e, "count": c} for e, c in top_devices],
            "top_actions": [{"action": a, "count": c} for a, c in top_actions],
            "time_patterns": time_patterns,
            "room_patterns": [{"room": r, "count": c} for r, c in room_patterns],
            "suggestions": suggestions,
        }

    def _generate_suggestions(
        self,
        observations: list[dict],
        top_devices: list[tuple],
        time_patterns: list[dict],
    ) -> list[dict]:
        """Generate automation suggestions from patterns."""
        suggestions = []

        # If a device is controlled at a consistent time, suggest automation
        for entity_id, count in top_devices[:5]:
            if count < 3:
                continue

            # Find the most common hour for this device
            device_obs = [o for o in observations if o["entity_id"] == entity_id]
            hours = []
            for obs in device_obs:
                ts = obs.get("timestamp", "")
                hour_match = re.search(r"T(\d{2}):", ts)
                if hour_match:
                    hours.append(int(hour_match.group(1)))

            if hours:
                hour_counter = Counter(hours)
                most_common_hour, hour_count = hour_counter.most_common(1)[0]
                if hour_count >= 2:
                    # Find the most common action for this device
                    action_counter = Counter(obs["action"] for obs in device_obs)
                    most_common_action = action_counter.most_common(1)[0][0]

                    suggestions.append({
                        "type": "time_based_automation",
                        "description": f"每天{most_common_hour}点关 {entity_id}" if most_common_action == "turn_off" else f"每天{most_common_hour}点开 {entity_id}",
                        "entity_id": entity_id,
                        "action": most_common_action,
                        "hour": most_common_hour,
                        "frequency": count,
                        "confidence": hour_count / len(hours),
                    })

        return suggestions

    def save_to_obsidian(self) -> str:
        """Save analyzed preferences to Obsidian note."""
        patterns = self.analyze_patterns()

        lines = [
            "---",
            "type: preference",
            f"total_commands: {patterns['total_commands']}",
            f"updated_at: {time.strftime('%Y-%m-%dT%H:%M:%S%z')}",
            "---",
            "",
            "# 用户偏好",
            "",
            f"总命令数: {patterns['total_commands']}",
            "",
            "## 常用设备",
            "",
        ]

        for d in patterns["top_devices"][:10]:
            lines.append(f"- `{d['entity_id']}` ({d['count']} 次)")

        lines.extend(["", "## 常用操作", ""])
        for a in patterns["top_actions"][:10]:
            lines.append(f"- `{a['action']}` ({a['count']} 次)")

        lines.extend(["", "## 时间模式", ""])
        for tp in patterns["time_patterns"]:
            lines.append(f"- {tp['hour']:02d}:00 — {tp['count']} 次命令")

        lines.extend(["", "## 房间模式", ""])
        for rp in patterns["room_patterns"]:
            lines.append(f"- {rp['room']} ({rp['count']} 次)")

        lines.extend(["", "## 自动化建议", ""])
        if patterns["suggestions"]:
            for s in patterns["suggestions"]:
                conf_pct = int(s.get("confidence", 0) * 100)
                lines.append(
                    f"- **{s['description']}** (置信度 {conf_pct}%, 频率 {s['frequency']}次)"
                )
        else:
            lines.append("暂无建议")

        lines.append("")

        with open(self.note_path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines))

        return self.note_path

    def get_context_for_llm(self) -> str:
        """Format preferences as LLM context string."""
        patterns = self.analyze_patterns()

        if patterns["total_commands"] == 0:
            return "暂无用户偏好数据。"

        lines = ["用户偏好摘要:"]

        if patterns["top_devices"]:
            top3 = patterns["top_devices"][:3]
            device_strs = [f"{d['entity_id']}({d['count']}次)" for d in top3]
            lines.append(f"常用设备: {', '.join(device_strs)}")

        if patterns["time_patterns"]:
            peak_hours = [f"{tp['hour']:02d}:00" for tp in patterns["time_patterns"][:3]]
            lines.append(f"活跃时段: {', '.join(peak_hours)}")

        if patterns["suggestions"]:
            for s in patterns["suggestions"][:2]:
                lines.append(f"建议: {s['description']}")

        return " | ".join(lines)
