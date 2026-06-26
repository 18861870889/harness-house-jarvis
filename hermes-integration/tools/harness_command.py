"""
Harness Command Tool for Hermes Agent

This tool lets Hermes (acting as Jarvis) control smart home devices
through the Harness House safe execution pipeline.

Two modes:
  1. Normal mode: pass user's raw speech, Harness House calls its own LLM (DeepSeek) to understand intent.
     - Two LLM calls: Hermes(GLM) + Harness House(DeepSeek) ≈ 7s total
  2. Skip-planner mode: Hermes already understood the intent and provides a planner_draft.
     Harness House skips its LLM call, goes straight to Safety Gate → Execute.
     - One LLM call: only Hermes(GLM) ≈ 3.5s total

Safety is never skipped: Safety Gate, Policy Gate, Decision Review, and Provider Simulation
always run regardless of mode.

Harness House API: http://localhost:5173/api/hcm/command
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


def harness_command(
    input: str,
    dry_run: bool = False,
    planner_draft: dict = None,
    skip_planner: bool = False,
) -> str:
    """
    Control smart home devices through Harness House.

    Args:
        input: User's natural language command, e.g. "关客厅灯", "太亮了"
        dry_run: If True, simulate without controlling real devices
        planner_draft: Pre-computed intent plan from Hermes LLM. When provided
                       with skip_planner=True, Harness House skips its own LLM
                       call (~3.5s saved). Format:
                       {
                         "intent_type": "device_control",
                         "intent": "打开书房射灯",
                         "confidence": 0.9,
                         "actions": [{"target": "书房射灯", "capability": "power", "value": true}]
                       }
        skip_planner: If True, use planner_draft instead of calling Harness House's LLM

    Returns:
        JSON string with execution result
    """
    try:
        payload = {
            "input": input,
            "source": "voice",
            "dryRun": dry_run,
        }

        if skip_planner and planner_draft:
            payload["skipPlanner"] = True
            payload["plannerDraft"] = planner_draft

        resp = requests.post(
            f"{HARNESS_HOUSE_URL}/api/hcm/command",
            json=payload,
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
            "用户说任何关于家里设备的话都调这个工具。"
            "传入用户原话，不要改写。"
            "会经过 Harness House 安全执行链路，高风险设备会要求确认。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "description": "用户的原话，如'关客厅灯''太亮了''书房空调调到25度'",
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "是否只模拟不真执行。默认 false。",
                    "default": False,
                },
                "skip_planner": {
                    "type": "boolean",
                    "description": "如果 Hermes 已理解意图并提供了 planner_draft，设为 true 跳过 Harness House 的 LLM 调用，节省约3.5秒。",
                    "default": False,
                },
                "planner_draft": {
                    "type": "object",
                    "description": "预计算的意图计划。格式: {\"intent_type\":\"device_control\",\"intent\":\"打开书房射灯\",\"confidence\":0.9,\"actions\":[{\"target\":\"书房射灯\",\"capability\":\"power\",\"value\":true}]}",
                },
            },
            "required": ["input"],
        },
    },
    handler=lambda args, **kw: harness_command(
        input=args.get("input", ""),
        dry_run=args.get("dry_run", False),
        planner_draft=args.get("planner_draft"),
        skip_planner=args.get("skip_planner", False),
    ),
    check_fn=check_requirements,
)
