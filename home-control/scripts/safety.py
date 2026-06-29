from __future__ import annotations

"""
Safety policy checker.
Reads device safety levels from Obsidian device notes (YAML frontmatter).
Deterministic enforcement — the LLM cannot override these decisions.
"""

import json
import os
import re
from pathlib import Path

# Default safety policy file (fallback when Obsidian is unavailable)
DEFAULT_POLICY_PATH = os.environ.get(
    "HOME_CONTROL_POLICY_PATH",
    os.path.expanduser("~/Documents/Obsidian-Vault/home-control/policies.json"),
)

# Obsidian vault path for device notes
OBSIDIAN_DEVICES_DIR = os.environ.get(
    "HOME_CONTROL_DEVICES_DIR",
    os.path.expanduser("~/Documents/Obsidian-Vault/home-control/devices"),
)

# Risk-based default safety levels by entity domain
DOMAIN_DEFAULTS = {
    "switch": "allow_auto",      # Lights, fans (via smart switches)
    "light": "allow_auto",       # Direct light entities
    "fan": "allow_auto",         # Fans
    "climate": "need_confirm",   # AC, heating
    "cover": "need_confirm",     # Curtains, blinds
    "lock": "block",             # Door locks
    "alarm_control_panel": "block",  # Alarm systems
    "media_player": "allow_auto",    # TV, speakers
    "vacuum": "need_confirm",    # Robot vacuum
    "button": "allow_auto",      # Buttons (actions)
}

SAFETY_LEVELS = {"allow_auto", "need_confirm", "block"}


class SafetyChecker:
    """Deterministic safety policy enforcement."""

    def __init__(self, policy_path: str = DEFAULT_POLICY_PATH, devices_dir: str = OBSIDIAN_DEVICES_DIR):
        self.policy_path = policy_path
        self.devices_dir = devices_dir
        self._policy_cache: dict[str, str] | None = None

    def get_safety_level(self, entity_id: str) -> str:
        """Get the safety level for an entity. Returns one of: allow_auto, need_confirm, block."""
        policy = self._load_policy()
        if entity_id in policy:
            return policy[entity_id]

        # Try Obsidian device note
        level = self._read_obsidian_safety(entity_id)
        if level:
            return level

        # Fall back to domain default
        domain = entity_id.split(".")[0] if "." in entity_id else ""
        return DOMAIN_DEFAULTS.get(domain, "block")

    def check(self, entity_id: str, action: str) -> dict:
        """
        Check if an action is allowed on an entity.
        Returns {"allowed": bool, "level": str, "reason": str}
        """
        level = self.get_safety_level(entity_id)

        if level == "block":
            return {
                "allowed": False,
                "level": "block",
                "reason": f"设备 {entity_id} 安全级别为 block，禁止自动控制",
            }

        if level == "need_confirm":
            return {
                "allowed": False,
                "level": "need_confirm",
                "reason": f"设备 {entity_id} 需要用户确认后才能控制",
                "needs_confirmation": True,
            }

        return {
            "allowed": True,
            "level": "allow_auto",
            "reason": f"设备 {entity_id} 允许自动控制",
        }

    def set_safety_level(self, entity_id: str, level: str) -> bool:
        """Set the safety level for an entity. Returns True on success."""
        if level not in SAFETY_LEVELS:
            return False

        policy = self._load_policy()
        policy[entity_id] = level
        self._save_policy(policy)
        self._policy_cache = None  # Force reload
        return True

    def _load_policy(self) -> dict[str, str]:
        """Load the safety policy from JSON file."""
        if self._policy_cache is not None:
            return self._policy_cache

        if os.path.exists(self.policy_path):
            with open(self.policy_path) as f:
                self._policy_cache = json.load(f)
        else:
            self._policy_cache = {}
        return self._policy_cache

    def _save_policy(self, policy: dict[str, str]) -> None:
        """Save the safety policy to JSON file."""
        os.makedirs(os.path.dirname(self.policy_path), exist_ok=True)
        with open(self.policy_path, "w") as f:
            json.dump(policy, f, ensure_ascii=False, indent=2)

    def _read_obsidian_safety(self, entity_id: str) -> str | None:
        """Try to read safety level from Obsidian device note frontmatter."""
        if not os.path.exists(self.devices_dir):
            return None

        # Look for a device note that mentions this entity_id
        for note_path in Path(self.devices_dir).glob("*.md"):
            try:
                content = note_path.read_text(encoding="utf-8")
                # Check if this note is for this entity
                if entity_id not in content:
                    continue
                # Parse YAML frontmatter
                match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
                if match:
                    frontmatter = match.group(1)
                    safety_match = re.search(r"safety:\s*(\w+)", frontmatter)
                    if safety_match:
                        level = safety_match.group(1).strip()
                        if level in SAFETY_LEVELS:
                            return level
            except Exception:
                continue
        return None
