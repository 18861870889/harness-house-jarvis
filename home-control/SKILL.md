---
name: home-control
description: "Home automation control via Home Assistant. Provides device control, state query, and safety enforcement."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [home-automation, smart-home, home-assistant, iot]
---

# Home Control

Control smart home devices through Home Assistant. This skill provides safe, audited device control with real-time state awareness.

## Available Commands

### List all devices
```bash
python3 scripts/control.py list
```
Returns all devices with their current state, room, and safety level.

### Control a device
```bash
python3 scripts/control.py control <entity_id> <action> [--value <value>]
```
Examples:
- `python3 scripts/control.py control switch.xxx turn_on`
- `python3 scripts/control.py control switch.xxx turn_off`
- `python3 scripts/control.py control climate.xxx set_temperature --value 25`

Safety check is performed before execution. If the device is `block`, the command is rejected. If `need_confirm`, confirmation is required.

### Query device state
```bash
python3 scripts/control.py state <entity_id>
```
Returns the current state of a device from the in-memory cache (instant, no HA API call).

### Query all states
```bash
python3 scripts/control.py states
```
Returns all device states from cache.

## Safety Levels

Each device has a safety level stored in Obsidian:
- `allow_auto`: Low-risk devices (lights, fans). Can be controlled automatically.
- `need_confirm`: Medium-risk devices (AC, curtains). Require user confirmation.
- `block`: High-risk devices (door locks, gas valves). Cannot be auto-controlled.

The LLM **cannot** override safety levels. The check is in deterministic Python code.

## Audit Trail

Every control command is logged to `data/audit.jsonl` with:
- timestamp, entity_id, action, result, latency, risk_level

## Error Handling

- HA unreachable → "无法连接家居系统"
- Device not found → "未找到设备 <entity_id>"
- Safety blocked → "设备 <name> 不允许自动控制"
- Invalid action → "不支持的操作 <action>"

## Context

When the user says something like "开灯" or "把空调调到25度", use the device list and room context to determine which entity to control. If ambiguous, ask the user for clarification.
