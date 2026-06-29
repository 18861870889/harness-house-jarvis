#!/usr/bin/env python3
"""
Data migration: HCM overlay JSON + spatial-editor JSON → Obsidian notes.

Reads device assignments, room definitions, and safety bindings from the
Harness House data files, and generates Obsidian-formatted markdown notes
with YAML frontmatter for each room and device.
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# ── Config ──

BASE_DIR = os.environ.get(
    "HARNESS_HOUSE_DIR",
    os.path.expanduser("~/harness-house-jarvis"),
)
OBSIDIAN_VAULT = os.environ.get(
    "OBSIDIAN_VAULT",
    os.path.expanduser("~/Documents/Obsidian-Vault"),
)
HOME_CONTROL_DIR = os.path.join(OBSIDIAN_VAULT, "home-control")

# Subdirectories
ROOMS_DIR = os.path.join(HOME_CONTROL_DIR, "rooms")
DEVICES_DIR = os.path.join(HOME_CONTROL_DIR, "devices")
SCENES_DIR = os.path.join(HOME_CONTROL_DIR, "scenes")
PREFERENCES_DIR = os.path.join(HOME_CONTROL_DIR, "preferences")
AUTOMATIONS_DIR = os.path.join(HOME_CONTROL_DIR, "automations")

# Room name mapping (English key → Chinese display name)
ROOM_DISPLAY_NAMES = {
    "balcony": "阳台",
    "bath": "公卫",
    "cat_room": "猫猫房",
    "dining": "餐厅",
    "entry": "入户",
    "kitchen": "厨房",
    "living": "客厅",
    "master": "主卧",
    "master_bath": "主卫",
    "second": "次卧",
    "study": "书房",
}


def load_json(path: str) -> dict:
    """Load a JSON file."""
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def extract_device_name(asset_id: str) -> str:
    """Extract a human-readable name from an asset_id like 'asset_living_客厅主射灯'."""
    # Remove prefix
    if asset_id.startswith("asset_"):
        parts = asset_id.split("_", 2)
        if len(parts) >= 3:
            return parts[2]
    # For ha_ hashed IDs, return as-is
    return asset_id


def extract_room_from_asset(asset_id: str) -> str | None:
    """Extract room key from asset_id like 'asset_living_客厅主射灯' → 'living'."""
    if asset_id.startswith("asset_"):
        parts = asset_id.split("_", 2)
        if len(parts) >= 3:
            return parts[1]
    return None


def generate_room_note(room_key: str, room_display: str, devices: list[dict]) -> str:
    """Generate an Obsidian markdown note for a room."""
    lines = []
    lines.append("---")
    lines.append(f"room_id: {room_key}")
    lines.append(f"name: {room_display}")
    lines.append(f"device_count: {len(devices)}")
    lines.append("type: room")
    lines.append("---")
    lines.append("")
    lines.append(f"# {room_display}")
    lines.append("")
    lines.append("## 设备列表")
    lines.append("")
    lines.append("| 设备 | entity_id | 安全级别 |")
    lines.append("|------|-----------|----------|")
    for d in devices:
        lines.append(f"| [[{d['name']}]] | `{d.get('entity_id', d.get('asset_id', ''))}` | {d.get('safety', 'unknown')} |")
    lines.append("")
    lines.append("## 场景")
    lines.append("")
    lines.append("<!-- 在此添加房间场景，如：看电影、睡觉、阅读 -->")
    lines.append("")

    return "\n".join(lines)


def generate_device_note(device: dict) -> str:
    """Generate an Obsidian markdown note for a device."""
    lines = []
    lines.append("---")
    lines.append(f"entity_id: \"{device.get('entity_id', device.get('asset_id', ''))}\"")
    lines.append(f"name: {device.get('name', 'unknown')}")
    lines.append(f"room: {device.get('room', 'unknown')}")
    lines.append(f"safety: {device.get('safety', 'allow_auto')}")
    lines.append(f"domain: {device.get('domain', 'unknown')}")
    lines.append("type: device")
    if device.get("aliases"):
        lines.append(f"aliases: [{', '.join(device['aliases'])}]")
    lines.append("---")
    lines.append("")
    lines.append(f"# {device.get('name', 'unknown')}")
    lines.append("")
    lines.append(f"**房间**: [[{ROOM_DISPLAY_NAMES.get(device.get('room', ''), device.get('room', ''))}]]")
    lines.append(f"**entity_id**: `{device.get('entity_id', device.get('asset_id', ''))}`")
    lines.append(f"**安全级别**: `{device.get('safety', 'allow_auto')}`")
    lines.append("")
    lines.append("## 别名")
    lines.append("<!-- 用户可能用这些名称指代此设备 -->")
    if device.get("aliases"):
        for a in device["aliases"]:
            lines.append(f"- {a}")
    else:
        lines.append("<!-- 无别名 -->")
    lines.append("")

    return "\n".join(lines)


def generate_preference_note(observations: list, candidates: list) -> str:
    """Generate a preference note from learning memory."""
    lines = []
    lines.append("---")
    lines.append("type: preference")
    lines.append(f"observation_count: {len(observations)}")
    lines.append(f"candidate_count: {len(candidates)}")
    lines.append("---")
    lines.append("")
    lines.append("# 用户偏好")
    lines.append("")
    lines.append("## 命令模式")
    lines.append("")
    if observations:
        lines.append("| 时间 | 设备 | 操作 | 值 |")
        lines.append("|------|------|------|-----|")
        for obs in observations[:20]:
            ts = obs.get("timestamp", obs.get("ts", ""))
            eid = obs.get("entity_id", obs.get("entityId", ""))
            action = obs.get("action", "")
            value = obs.get("value", "")
            lines.append(f"| {ts} | {eid} | {action} | {value} |")
    else:
        lines.append("暂无观察记录")
    lines.append("")
    lines.append("## 候选偏好")
    lines.append("")
    if candidates:
        for c in candidates[:10]:
            lines.append(f"- {json.dumps(c, ensure_ascii=False)}")
    else:
        lines.append("暂无候选偏好")
    lines.append("")

    return "\n".join(lines)


def migrate():
    """Main migration function."""
    # Load data
    overlay_path = os.path.join(BASE_DIR, "data", "home-model-overlay.local.json")
    spatial_path = os.path.join(BASE_DIR, "data", "spatial-editor.local.json")
    learning_path = os.path.join(BASE_DIR, "data", "learning-memory.local.json")

    overlay = load_json(overlay_path) if os.path.exists(overlay_path) else {}
    spatial = load_json(spatial_path) if os.path.exists(spatial_path) else {}
    learning = load_json(learning_path) if os.path.exists(learning_path) else {}

    state = spatial.get("state", {})
    device_assignments = state.get("deviceAssignments", {})
    custom_rooms = state.get("customRooms", [])
    bindings = overlay.get("providers", {}).get("home_assistant", {}).get("bindings", {})

    # Create directories
    for d in [ROOMS_DIR, DEVICES_DIR, SCENES_DIR, PREFERENCES_DIR, AUTOMATIONS_DIR]:
        os.makedirs(d, exist_ok=True)

    # Build room → devices mapping
    room_devices: dict[str, list[dict]] = {}
    all_devices: list[dict] = []

    for asset_id, room_key in device_assignments.items():
        room_key = room_key or "unassigned"
        device_name = extract_device_name(asset_id)
        room_display = ROOM_DISPLAY_NAMES.get(room_key, room_key)

        # Try to find HA entity binding
        binding = bindings.get(asset_id, {})
        safety = binding.get("decision", "allow_auto")  # default to allow_auto for assets

        # Check if this is an HA entity_id
        domain = asset_id.split(".")[0] if "." in asset_id else "unknown"

        device = {
            "asset_id": asset_id,
            "entity_id": asset_id if "." in asset_id else "",
            "name": device_name,
            "room": room_key,
            "room_display": room_display,
            "safety": safety,
            "domain": domain,
            "aliases": [],
        }

        if room_key not in room_devices:
            room_devices[room_key] = []
        room_devices[room_key].append(device)
        all_devices.append(device)

    # Also add HA entities from bindings that aren't in spatial editor
    spatial_entity_ids = {d["asset_id"] for d in all_devices}
    for entity_id, binding in bindings.items():
        if entity_id not in spatial_entity_ids:
            domain = entity_id.split(".")[0] if "." in entity_id else "unknown"
            # Skip non-controllable domains for device notes
            if domain in ("number", "select", "text", "event", "sensor", "binary_sensor", "update"):
                continue
            device = {
                "asset_id": entity_id,
                "entity_id": entity_id,
                "name": binding.get("friendly_name", entity_id),
                "room": "unassigned",
                "room_display": "未分配",
                "safety": binding.get("decision", "block"),
                "domain": domain,
                "aliases": [],
            }
            room_devices.setdefault("unassigned", []).append(device)
            all_devices.append(device)

    # Generate room notes
    room_count = 0
    for room_key, devices in room_devices.items():
        room_display = ROOM_DISPLAY_NAMES.get(room_key, room_key)
        # Check custom rooms
        for cr in custom_rooms:
            if cr["id"] == room_key:
                room_display = cr["name"]
                break

        note = generate_room_note(room_key, room_display, devices)
        safe_key = re.sub(r"[^\w]", "_", room_key)
        path = os.path.join(ROOMS_DIR, f"{safe_key}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(note)
        room_count += 1

    # Generate device notes (only for controllable domains)
    controllable_domains = {"switch", "light", "climate", "cover", "fan", "lock",
                           "media_player", "vacuum", "button"}
    device_count = 0
    for device in all_devices:
        if device["domain"] not in controllable_domains and device["domain"] != "unknown":
            continue
        # For asset-based devices, still create notes
        note = generate_device_note(device)
        safe_name = re.sub(r"[^\w\u4e00-\u9fff]", "_", device["name"])
        path = os.path.join(DEVICES_DIR, f"{safe_name}.md")
        with open(path, "w", encoding="utf-8") as f:
            f.write(note)
        device_count += 1

    # Generate preference note
    observations = learning.get("observations", [])
    candidates = learning.get("candidates", [])
    pref_note = generate_preference_note(observations, candidates)
    with open(os.path.join(PREFERENCES_DIR, "user-preferences.md"), "w", encoding="utf-8") as f:
        f.write(pref_note)

    # Generate index note
    index_lines = [
        "---",
        "type: index",
        "---",
        "",
        "# Home Control 知识库",
        "",
        f"- 房间数: {room_count}",
        f"- 设备数: {device_count}",
        f"- 安全绑定数: {len(bindings)}",
        f"- 学习观察数: {len(observations)}",
        "",
        "## 房间",
        "",
    ]
    for room_key in sorted(room_devices.keys()):
        room_display = ROOM_DISPLAY_NAMES.get(room_key, room_key)
        safe_rk = re.sub(r"[^\w]", "_", room_key)
        index_lines.append(f"- [[{safe_rk}|{room_display}]]")
    index_lines.extend(["", "## 设备", "", f"共 {device_count} 个设备笔记", ""])
    index_lines.extend(["", "## 偏好", "", "- [[user-preferences|用户偏好]]", ""])

    with open(os.path.join(HOME_CONTROL_DIR, "index.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(index_lines))

    # Generate policies.json for safety checker fallback
    policies = {}
    for device in all_devices:
        eid = device.get("entity_id") or device["asset_id"]
        if device["safety"] in ("allow_auto", "need_confirm", "block"):
            policies[eid] = device["safety"]
    policies_path = os.path.join(HOME_CONTROL_DIR, "policies.json")
    with open(policies_path, "w", encoding="utf-8") as f:
        json.dump(policies, f, ensure_ascii=False, indent=2)

    print(f"✅ Migration complete:")
    print(f"  Rooms: {room_count}")
    print(f"  Devices: {device_count}")
    print(f"  Policies: {len(policies)}")
    print(f"  Observations: {len(observations)}")
    print(f"  Candidates: {len(candidates)}")
    print(f"  Vault: {HOME_CONTROL_DIR}")

    return {
        "rooms": room_count,
        "devices": device_count,
        "policies": len(policies),
        "observations": len(observations),
        "candidates": len(candidates),
    }


if __name__ == "__main__":
    migrate()
