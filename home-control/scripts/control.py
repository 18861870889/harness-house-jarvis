#!/usr/bin/env python3
from __future__ import annotations
"""
Home Control CLI — main entry point.

Usage:
    python3 control.py list                     # List all devices + states
    python3 control.py states                    # All device states (cache)
    python3 control.py state <entity_id>         # Single device state
    python3 control.py control <entity_id> <action> [--value <value>]
    python3 control.py safety <entity_id>        # Get safety level
    python3 control.py safety <entity_id> <level> # Set safety level

Environment:
    HA_BASE_URL  — Home Assistant URL (default: http://homeassistant.local:8123)
    HA_TOKEN     — Home Assistant Long-Lived Access Token
"""

import argparse
import json
import os
import sys
import time

# Add scripts dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from ha_client import HAClient
from safety import SafetyChecker
from audit import AuditLogger


def get_client() -> HAClient:
    """Create a HA client with current env config."""
    token = os.environ.get("HA_TOKEN", "")
    base_url = os.environ.get("HA_BASE_URL", "http://homeassistant.local:8123")
    if not token:
        print(json.dumps({"error": "HA_TOKEN not configured"}, ensure_ascii=False))
        sys.exit(1)
    return HAClient(base_url=base_url, token=token)


def cmd_list(args):
    """List all devices with their states.

    By default fetches from REST API (full snapshot). With --cache, uses
    the in-memory WebSocket state cache (instant, no HA API call).
    """
    client = get_client()
    safety = SafetyChecker()

    # Use cache or REST
    if getattr(args, "cache", False):
        client.init_state_cache()
        raw_states = list(client.get_all_cached_states().values())
    else:
        raw_states = client.get_states()

    # Domain filter
    domain_filter = getattr(args, "domain", None)

    # Only show controllable domains (not sensors, numbers, etc.)
    controllable_domains = {
        "switch", "light", "climate", "cover", "fan", "lock",
        "media_player", "vacuum", "button", "select", "input_boolean",
    }

    devices = []
    for s in raw_states:
        eid = s.get("entity_id", "")
        domain = eid.split(".")[0] if "." in eid else ""

        # Apply domain filter
        if domain_filter and domain != domain_filter:
            continue

        # Skip non-controllable domains unless --all
        if not getattr(args, "all", False) and domain not in controllable_domains:
            continue

        devices.append({
            "entity_id": eid,
            "name": s.get("attributes", {}).get("friendly_name", eid),
            "state": s.get("state"),
            "domain": domain,
            "safety": safety.get_safety_level(eid),
        })

    # Sort: by domain, then by name
    devices.sort(key=lambda d: (d["domain"], d["name"]))
    print(json.dumps({"count": len(devices), "devices": devices}, ensure_ascii=False, indent=2))


def cmd_states(args):
    """Get all cached states."""
    client = get_client()
    client.init_state_cache()
    states = client.get_all_cached_states()
    summary = {eid: s.get("state") for eid, s in states.items()}
    print(json.dumps({"count": len(summary), "states": summary}, ensure_ascii=False, indent=2))


def cmd_state(args):
    """Get a single device state."""
    client = get_client()
    client.init_state_cache()
    state = client.get_cached_state(args.entity_id)
    if not state:
        print(json.dumps({"error": f"未找到设备 {args.entity_id}"}, ensure_ascii=False))
        sys.exit(1)
    print(json.dumps({
        "entity_id": state.get("entity_id"),
        "state": state.get("state"),
        "attributes": state.get("attributes", {}),
    }, ensure_ascii=False, indent=2))


def cmd_control(args):
    """Control a device with safety check, execution, and audit logging."""
    client = get_client()
    safety = SafetyChecker()
    audit = AuditLogger()

    entity_id = args.entity_id
    action = args.action
    value = args.value
    confirmed = getattr(args, "confirmed", False)

    start = time.time()

    # 1. Safety check
    check = safety.check(entity_id, action)
    if not check["allowed"]:
        # If needs confirmation and user confirmed, proceed
        if check.get("needs_confirmation") and confirmed:
            pass  # Fall through to execution
        else:
            audit.log(
                entity_id=entity_id,
                action=action,
                result="blocked",
                risk_level=check["level"],
                reason=check["reason"],
                value=value or "",
            )
            print(json.dumps({
                "entity_id": entity_id,
                "action": action,
                "status": "blocked",
                "level": check["level"],
                "reason": check["reason"],
                "needs_confirmation": check.get("needs_confirmation", False),
            }, ensure_ascii=False, indent=2))
            return

    # 2. Determine domain and service
    domain = entity_id.split(".")[0] if "." in entity_id else ""
    service_map = {
        "turn_on": "turn_on",
        "turn_off": "turn_off",
        "set_temperature": "set_temperature",
        "set_humidity": "set_humidity",
        "set_fan_mode": "set_fan_mode",
        "set_position": "set_position",
        "toggle": "toggle",
        "start": "start",
        "stop": "stop",
        "pause": "pause",
        "return_to_base": "return_to_base",
    }
    service = service_map.get(action, action)

    # 3. Build service data
    service_data = {"entity_id": entity_id}
    if value and action.startswith("set_"):
        if action == "set_temperature":
            service_data["temperature"] = float(value)
        elif action == "set_position":
            service_data["position"] = int(value)
        else:
            service_data[action.replace("set_", "")] = value

    # 4. Execute
    try:
        client.call_service(domain, service, service_data)
        latency = int((time.time() - start) * 1000)
        result_label = "confirmed" if (check.get("needs_confirmation") and confirmed) else "executed"
        audit.log(
            entity_id=entity_id,
            action=action,
            result=result_label,
            latency_ms=latency,
            risk_level=check["level"],
            value=value or "",
        )
        print(json.dumps({
            "entity_id": entity_id,
            "action": action,
            "status": result_label,
            "service": f"{domain}.{service}",
            "latency_ms": latency,
        }, ensure_ascii=False, indent=2))
    except Exception as e:
        latency = int((time.time() - start) * 1000)
        audit.log(
            entity_id=entity_id,
            action=action,
            result="error",
            latency_ms=latency,
            risk_level=check["level"],
            reason=str(e),
            value=value or "",
        )
        print(json.dumps({
            "entity_id": entity_id,
            "action": action,
            "status": "error",
            "error": str(e),
        }, ensure_ascii=False, indent=2))


def cmd_safety(args):
    """Get or set safety level."""
    safety = SafetyChecker()
    if args.level:
        if args.level not in ("allow_auto", "need_confirm", "block"):
            print(json.dumps({"error": f"Invalid level: {args.level}"}, ensure_ascii=False))
            sys.exit(1)
        safety.set_safety_level(args.entity_id, args.level)
        print(json.dumps({
            "entity_id": args.entity_id,
            "safety": args.level,
            "status": "updated",
        }, ensure_ascii=False, indent=2))
    else:
        level = safety.get_safety_level(args.entity_id)
        print(json.dumps({
            "entity_id": args.entity_id,
            "safety": level,
        }, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Home Control CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    sub_list = sub.add_parser("list", help="List all devices")
    sub_list.add_argument("--cache", action="store_true", help="Use WebSocket state cache instead of REST API")
    sub_list.add_argument("--domain", default=None, help="Filter by domain (e.g., light, switch, climate)")
    sub_list.add_argument("--all", action="store_true", help="Show all entities including sensors")
    sub.add_parser("states", help="All device states (cache)")
    sub_state = sub.add_parser("state", help="Single device state")
    sub_state.add_argument("entity_id", help="Entity ID (e.g., switch.xxx)")

    sub_control = sub.add_parser("control", help="Control a device")
    sub_control.add_argument("entity_id", help="Entity ID")
    sub_control.add_argument("action", help="Action (turn_on, turn_off, set_temperature, etc.)")
    sub_control.add_argument("--value", default="", help="Value for set_* actions")
    sub_control.add_argument("--confirmed", action="store_true", help="User confirmation for need_confirm devices")

    sub_safety = sub.add_parser("safety", help="Get or set safety level")
    sub_safety.add_argument("entity_id", help="Entity ID")
    sub_safety.add_argument("level", nargs="?", help="New level (allow_auto, need_confirm, block)")

    args = parser.parse_args()

    if args.command == "list":
        cmd_list(args)
    elif args.command == "states":
        cmd_states(args)
    elif args.command == "state":
        cmd_state(args)
    elif args.command == "control":
        cmd_control(args)
    elif args.command == "safety":
        cmd_safety(args)


if __name__ == "__main__":
    main()
