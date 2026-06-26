"""
Harness Command Tool for Hermes Agent

This tool lets Hermes (acting as Jarvis) control smart home devices
through the Harness House safe execution pipeline.

Harness House API: http://localhost:5173/api/hcm/command
All device operations go through: Safety Gate -> Policy Gate -> Decision Review -> Execute
Hermes never calls Home Assistant directly.
"""

import json
import os
import requests
from tools.registry import registry

HARNESS_HOUSE_URL = os.getenv("HARNESS_HOUSE_URL", "http://localhost:5173")
HARNESS_COMMAND_TIMEOUT = int(os.getenv("HARNESS_COMMAND_TIMEOUT", "8"))


def check_requirements() -> bool:
    """Check if Harness House is reachable."""
    try:
        r = requests.get(f"{HARNESS_HOUSE_URL}/api/runtime/status", timeout=2)
        return r.status_code == 200
    except Exception:
        return False


def harness_command(input: str, dry_run: bool = False, session_id: str = "") -> str:
    """
    Control smart home devices through Harness House.

    Args:
        input: User's natural language command, e.g. "关客厅灯", "太亮了", "客厅灯开了吗"
        dry_run: If True, simulate without actually controlling devices
        session_id: Session ID for conversation context continuity

    Returns:
        JSON string with execution result
    """
    try:
        resp = requests.post(
            f"{HARNESS_HOUSE_URL}/api/hcm/command",
            json={
                "input": input,
                "source": "voice",
                "dryRun": dry_run,
                "sessionId": session_id,
            },
            timeout=HARNESS_COMMAND_TIMEOUT,
        )
        result = resp.json()

        status = result.get("status", "unknown")
        summary = result.get("explanation", {}).get("summary", "")
        latency = result.get("latencyMs", 0)

        if status == "executed":
            return json.dumps({
                "ok": True,
                "status": "executed",
                "message": summary or "已执行",
                "latency_ms": latency,
            }, ensure_ascii=False)

        if status == "answered":
            return json.dumps({
                "ok": True,
                "status": "answered",
                "message": summary or "查询完成",
                "latency_ms": latency,
            }, ensure_ascii=False)

        if status == "dry_run":
            return json.dumps({
                "ok": True,
                "status": "dry_run",
                "message": f"模拟执行：{summary}",
                "latency_ms": latency,
            }, ensure_ascii=False)

        if status == "needs_confirmation":
            return json.dumps({
                "ok": False,
                "status": "needs_confirmation",
                "message": f"需要你确认：{summary}",
                "latency_ms": latency,
            }, ensure_ascii=False)

        if status == "needs_clarification":
            return json.dumps({
                "ok": False,
                "status": "needs_clarification",
                "message": f"我不太确定：{summary}",
                "latency_ms": latency,
            }, ensure_ascii=False)

        if status == "rejected":
            return json.dumps({
                "ok": False,
                "status": "rejected",
                "message": f"被安全策略拒绝：{summary}",
                "latency_ms": latency,
            }, ensure_ascii=False)

        if status == "no_action":
            return json.dumps({
                "ok": False,
                "status": "no_action",
                "message": summary or "没有找到可执行的设备",
                "latency_ms": latency,
            }, ensure_ascii=False)

        # partial_failure, error, etc.
        return json.dumps({
            "ok": False,
            "status": status,
            "message": summary or f"执行状态：{status}",
            "latency_ms": latency,
        }, ensure_ascii=False)

    except requests.exceptions.Timeout:
        return json.dumps({
            "ok": False,
            "status": "timeout",
            "message": "设备控制服务响应超时，请稍后再试",
        }, ensure_ascii=False)

    except requests.exceptions.ConnectionError:
        return json.dumps({
            "ok": False,
            "status": "service_unavailable",
            "message": "Harness House 服务未运行，请检查 localhost:5173",
        }, ensure_ascii=False)

    except Exception as e:
        return json.dumps({
            "ok": False,
            "status": "error",
            "message": f"设备控制异常：{e}",
        }, ensure_ascii=False)


registry.register(
    name="harness_command",
    toolset="homeassistant",
    schema={
        "name": "harness_command",
        "description": (
            "控制家里的智能设备（灯、空调、窗帘、风扇、电视等）。"
            "用户说任何关于家里设备的话都调这个工具——无论是控制、查询还是状态检查。"
            "会经过 Harness House 安全执行链路，高风险设备（燃气热水器、门锁等）会要求确认。"
            "传入用户原话，不要改写。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "description": "用户的原话，如'关客厅灯''太亮了''书房空调调到25度''客厅灯开了吗'",
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "是否只模拟不真执行。默认 false。",
                    "default": False,
                },
            },
            "required": ["input"],
        },
    },
    handler=lambda args, **kw: harness_command(
        input=args.get("input", ""),
        dry_run=args.get("dry_run", False),
    ),
    check_fn=check_requirements,
)
