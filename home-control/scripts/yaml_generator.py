#!/usr/bin/env python3
"""
YAML Generator — converts natural language automation descriptions to HA automation specs.

Uses pattern matching to parse common automation requests like:
  - "每天23点关灯" → time trigger + light.turn_off
  - "日落时开灯" → sun trigger + light.turn_on
  - "温度超过28度开空调" → numeric_state trigger + climate.turn_on
"""
from __future__ import annotations

import re
from typing import Any


# ── Pattern matchers ──

TIME_PATTERN = re.compile(
    r"(?:每天|每日|每)?\s*(\d{1,2})\s*(?:[点时]|:|：)\s*(\d{0,2})",
    re.IGNORECASE,
)

SUNRISE_PATTERN = re.compile(r"日出|天亮", re.IGNORECASE)
SUNSET_PATTERN = re.compile(r"日落|天黑|傍晚", re.IGNORECASE)

TEMP_THRESHOLD_PATTERN = re.compile(
    r"温度(?:超过|高于|大于|≥)?\s*(\d+(?:\.\d+)?)\s*度",
    re.IGNORECASE,
)

DEVICE_KEYWORDS = {
    "灯": {"domain": "light", "service": "turn_off", "service_on": "turn_on"},
    "空调": {"domain": "climate", "service": "turn_on", "service_off": "turn_off"},
    "窗帘": {"domain": "cover", "service": "close_cover", "service_on": "open_cover"},
    "风扇": {"domain": "fan", "service": "turn_on", "service_off": "turn_off"},
}

ACTION_KEYWORDS = {
    "关": "off",
    "开": "on",
    "关闭": "off",
    "打开": "on",
}


def parse_time_trigger(text: str) -> dict | None:
    """Extract a time trigger from text like '每天23点' or '每日8:30'."""
    match = TIME_PATTERN.search(text)
    if match:
        hour = int(match.group(1))
        minute = int(match.group(2)) if match.group(2) else 0
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return {
                "platform": "time",
                "at": f"{hour:02d}:{minute:02d}:00",
            }
    return None


def parse_sun_trigger(text: str) -> dict | None:
    """Extract a sun trigger from text."""
    if SUNSET_PATTERN.search(text):
        return {"platform": "sun", "event": "sunset"}
    if SUNRISE_PATTERN.search(text):
        return {"platform": "sun", "event": "sunrise"}
    return None


def parse_numeric_trigger(text: str) -> dict | None:
    """Extract a numeric_state trigger from text like '温度超过28度'."""
    match = TEMP_THRESHOLD_PATTERN.search(text)
    if match:
        threshold = float(match.group(1))
        return {
            "platform": "numeric_state",
            "entity_id": "sensor.temperature",
            "above": threshold,
        }
    return None


def parse_action(text: str) -> dict | None:
    """Parse the action from text."""
    # Check for device keywords (Chinese)
    for keyword, info in DEVICE_KEYWORDS.items():
        if keyword in text:
            # Determine on/off
            action = "on"
            for act_key, act_val in ACTION_KEYWORDS.items():
                if act_key in text:
                    action = act_val
                    break
            
            service = info[f"service{'_on' if action == 'on' else ''}"] if f"service{'_on' if action == 'on' else ''}" in info else info["service"]
            # For lights, use turn_on/turn_off
            if info["domain"] == "light":
                service = "turn_on" if action == "on" else "turn_off"
            elif info["domain"] == "climate":
                service = "turn_on" if action == "on" else "turn_off"
            elif info["domain"] == "cover":
                service = "open_cover" if action == "on" else "close_cover"
            elif info["domain"] == "fan":
                service = "turn_on" if action == "on" else "turn_off"
            
            return {
                "service": f"{info['domain']}.{service}",
                "target": {"entity_id": "all"} if action == "off" else {"entity_id": "all"},
            }
    
    # Check for entity_id domain patterns (e.g., "light.living", "switch.test")
    domain_match = re.search(r'\b(switch|light|climate|cover|fan|lock|vacuum)\.\w+', text)
    if domain_match:
        domain = domain_match.group(1)
        action = "on"
        for act_key, act_val in ACTION_KEYWORDS.items():
            if act_key in text:
                action = act_val
                break
        
        if domain == "light":
            service = "turn_on" if action == "on" else "turn_off"
        elif domain == "climate":
            service = "turn_on" if action == "on" else "turn_off"
        elif domain == "cover":
            service = "open_cover" if action == "on" else "close_cover"
        elif domain == "fan":
            service = "turn_on" if action == "on" else "turn_off"
        else:
            service = "turn_on" if action == "on" else "turn_off"
        
        return {
            "service": f"{domain}.{service}",
            "target": {"entity_id": "all"},
        }
    
    return None


def generate_automation(description: str, alias: str = "") -> dict:
    """Generate an HA automation spec from a natural language description.
    
    Args:
        description: Natural language like "每天23点关灯"
        alias: Optional name for the automation
    
    Returns:
        HA automation spec dict suitable for AutomationManager.create()
    """
    triggers = []
    
    # Try time trigger
    time_trigger = parse_time_trigger(description)
    if time_trigger:
        triggers.append(time_trigger)
    
    # Try sun trigger
    sun_trigger = parse_sun_trigger(description)
    if sun_trigger:
        triggers.append(sun_trigger)
    
    # Try numeric trigger
    numeric_trigger = parse_numeric_trigger(description)
    if numeric_trigger:
        triggers.append(numeric_trigger)
    
    # Parse action
    action = parse_action(description)
    if not action:
        raise ValueError(f"无法解析操作: {description}")
    
    if not triggers:
        raise ValueError(f"无法解析触发条件: {description}")
    
    if not alias:
        alias = description[:50]
    
    spec = {
        "alias": alias,
        "description": description,
        "trigger": triggers,
        "condition": [],
        "action": [action],
        "mode": "single",
    }
    
    return spec


def validate_spec(spec: dict) -> list[str]:
    """Validate an automation spec. Returns list of error messages (empty = valid)."""
    errors = []
    
    if not spec.get("alias"):
        errors.append("Missing alias")
    
    if not spec.get("trigger"):
        errors.append("Missing trigger")
    elif not isinstance(spec["trigger"], list):
        errors.append("Trigger must be a list")
    
    if not spec.get("action"):
        errors.append("Missing action")
    elif not isinstance(spec["action"], list):
        errors.append("Action must be a list")
    
    for i, trigger in enumerate(spec.get("trigger", [])):
        if not isinstance(trigger, dict):
            errors.append(f"Trigger {i} must be a dict")
        elif "platform" not in trigger:
            errors.append(f"Trigger {i} missing platform")
    
    for i, action in enumerate(spec.get("action", [])):
        if not isinstance(action, dict):
            errors.append(f"Action {i} must be a dict")
        elif "service" not in action:
            errors.append(f"Action {i} missing service")
    
    return errors
