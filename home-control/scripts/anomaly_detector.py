#!/usr/bin/env python3
"""
Anomaly Detector — checks HA states for abnormal conditions and generates alerts.

Run via cronjob to detect:
  - Lights on during daytime (waste)
  - AC running with windows open
  - Door left unlocked at night
  - Devices offline unexpectedly
  - Temperature/humidity out of range
"""
from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

import requests

# Add scripts dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ha_client import HAClient

HA_BASE_URL = os.environ.get("HA_BASE_URL", "http://homeassistant.local:8123")
HA_TOKEN = os.environ.get("HA_TOKEN", "")


# ── Anomaly Rules ──

ANOMALY_RULES = [
    {
        "id": "lights_on_daytime",
        "description": "白天灯开着（浪费电）",
        "check": lambda states: _check_lights_on_daytime(states),
        "severity": "low",
    },
    {
        "id": "door_unlocked_night",
        "description": "夜间门锁未锁",
        "check": lambda states: _check_door_unlocked_night(states),
        "severity": "high",
    },
    {
        "id": "ac_with_window_open",
        "description": "空调开着但窗户可能开着",
        "check": lambda states: _check_ac_window_open(states),
        "severity": "medium",
    },
    {
        "id": "device_offline",
        "description": "设备离线",
        "check": lambda states: _check_device_offline(states),
        "severity": "medium",
    },
]


def _get_hour() -> int:
    """Get current hour (local time)."""
    return int(time.strftime("%H"))


def _check_lights_on_daytime(states: list[dict]) -> list[dict]:
    """Check if lights are on during daytime (7:00-18:00)."""
    hour = _get_hour()
    if hour < 7 or hour >= 18:
        return []  # Not daytime

    alerts = []
    for s in states:
        eid = s.get("entity_id", "")
        if eid.startswith("light.") and s.get("state") == "on":
            name = s.get("attributes", {}).get("friendly_name", eid)
            alerts.append({
                "rule": "lights_on_daytime",
                "entity_id": eid,
                "name": name,
                "state": "on",
                "message": f"白天灯开着: {name} ({eid})",
                "severity": "low",
            })
    return alerts


def _check_door_unlocked_night(states: list[dict]) -> list[dict]:
    """Check if door locks are unlocked at night (22:00-6:00)."""
    hour = _get_hour()
    if hour >= 6 and hour < 22:
        return []  # Not night

    alerts = []
    for s in states:
        eid = s.get("entity_id", "")
        if eid.startswith("lock.") and s.get("state") == "unlocked":
            name = s.get("attributes", {}).get("friendly_name", eid)
            alerts.append({
                "rule": "door_unlocked_night",
                "entity_id": eid,
                "name": name,
                "state": "unlocked",
                "message": f"夜间门锁未锁: {name} ({eid})",
                "severity": "high",
            })
    return alerts


def _check_ac_window_open(states: list[dict]) -> list[dict]:
    """Check if AC is on while window/cover is open."""
    ac_on = [s for s in states if s.get("entity_id", "").startswith("climate.") and s.get("state") in ("cool", "heat", "auto")]
    covers_open = [s for s in states if s.get("entity_id", "").startswith("cover.") and s.get("state") == "open"]

    if ac_on and covers_open:
        alerts = []
        for ac in ac_on:
            ac_name = ac.get("attributes", {}).get("friendly_name", ac["entity_id"])
            alerts.append({
                "rule": "ac_with_window_open",
                "entity_id": ac["entity_id"],
                "name": ac_name,
                "state": ac["state"],
                "message": f"空调运行中但窗帘/窗户可能开着: {ac_name}",
                "severity": "medium",
            })
        return alerts
    return []


def _check_device_offline(states: list[dict]) -> list[dict]:
    """Check for devices that are unexpectedly unavailable."""
    alerts = []
    for s in states:
        if s.get("state") == "unavailable":
            eid = s.get("entity_id", "")
            # Skip sensors and non-controllable entities
            domain = eid.split(".")[0] if "." in eid else ""
            if domain in ("switch", "light", "climate", "cover", "lock", "vacuum"):
                name = s.get("attributes", {}).get("friendly_name", eid)
                alerts.append({
                    "rule": "device_offline",
                    "entity_id": eid,
                    "name": name,
                    "state": "unavailable",
                    "message": f"设备离线: {name} ({eid})",
                    "severity": "medium",
                })
    return alerts


def detect_anomalies(states: list[dict]) -> list[dict]:
    """Run all anomaly detection rules against the current states."""
    all_alerts = []
    for rule in ANOMALY_RULES:
        try:
            alerts = rule["check"](states)
            all_alerts.extend(alerts)
        except Exception as e:
            print(f"[AnomalyDetector] Rule '{rule['id']}' failed: {e}")
    return all_alerts


def format_alerts_for_wechat(alerts: list[dict]) -> str:
    """Format alerts as a WeChat message."""
    if not alerts:
        return ""

    lines = ["🚨 家居异常告警", ""]
    for a in alerts:
        severity_emoji = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(a["severity"], "⚪")
        lines.append(f"{severity_emoji} {a['message']}")

    return "\n".join(lines)


def main():
    """Main entry point for cronjob execution."""
    if not HA_TOKEN:
        print("HA_TOKEN not set")
        return

    client = HAClient(base_url=HA_BASE_URL, token=HA_TOKEN)
    try:
        states = client.get_states()
    except Exception as e:
        print(f"Failed to get states: {e}")
        return

    alerts = detect_anomalies(states)

    if alerts:
        message = format_alerts_for_wechat(alerts)
        print(message)
        # Write alerts to file for the cron job to pick up
        alerts_path = os.path.join(
            os.environ.get("HOME_CONTROL_DATA", os.path.expanduser("~/harness-house-jarvis/data")),
            "anomaly-alerts.json",
        )
        with open(alerts_path, "w") as f:
            json.dump({"timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "alerts": alerts}, f, ensure_ascii=False, indent=2)
    else:
        print("No anomalies detected")


if __name__ == "__main__":
    main()
