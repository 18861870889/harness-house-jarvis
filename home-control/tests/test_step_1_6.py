"""
Step 1.6 Tests: End-to-end integration — simulate "开书房空调" full chain.

Tests the complete flow: list devices → find entity by name/room → 
safety check → confirm → execute → audit log → verify state change.

These tests mock HA REST but test the real control.py command flow end-to-end.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from unittest.mock import MagicMock, patch

import pytest

# Add scripts dir to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from ha_client import HAClient
from safety import SafetyChecker
from audit import AuditLogger
import control as ctrl


# ── Fixtures ──

@pytest.fixture
def tmp_audit():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        path = f.name
    yield path
    os.unlink(path)


@pytest.fixture
def tmp_policy():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write("{}")
        path = f.name
    yield path
    os.unlink(path)


@pytest.fixture
def mock_client():
    client = HAClient(base_url="http://localhost:8123", token="fake")
    client.call_service = MagicMock(return_value={})
    return client


@pytest.fixture
def safety(tmp_policy):
    return SafetyChecker(policy_path=tmp_policy, devices_dir="/nonexistent")


@pytest.fixture
def audit(tmp_audit):
    return AuditLogger(path=tmp_audit)


def capture_output():
    import io
    from contextlib import redirect_stdout
    buf = io.StringIO()
    return buf, redirect_stdout(buf)


# Simulated HA state: a home with devices in different rooms
HOME_DEVICES = [
    # 书房 (Study)
    {"entity_id": "climate.study_ac", "state": "off", "attributes": {"friendly_name": "书房空调", "temperature": 26}},
    {"entity_id": "light.study_main", "state": "on", "attributes": {"friendly_name": "书房主灯"}},
    {"entity_id": "switch.study_fan", "state": "off", "attributes": {"friendly_name": "书房风扇"}},

    # 客厅 (Living Room)
    {"entity_id": "climate.living_ac", "state": "cool", "attributes": {"friendly_name": "客厅空调", "temperature": 24}},
    {"entity_id": "light.living_main", "state": "on", "attributes": {"friendly_name": "客厅主灯"}},
    {"entity_id": "cover.living_curtain", "state": "open", "attributes": {"friendly_name": "客厅窗帘"}},

    # 卧室 (Bedroom)
    {"entity_id": "climate.bedroom_ac", "state": "off", "attributes": {"friendly_name": "卧室空调", "temperature": 25}},
    {"entity_id": "light.bedroom_main", "state": "off", "attributes": {"friendly_name": "卧室主灯"}},

    # 入口 (Entrance)
    {"entity_id": "lock.front_door", "state": "locked", "attributes": {"friendly_name": "前门锁"}},

    # Sensors (non-controllable)
    {"entity_id": "sensor.study_temp", "state": "28.5", "attributes": {"friendly_name": "书房温度"}},
]


# ── Full Chain: "开书房空调" ──

class TestOpenStudyACFullChain:
    """Simulate: user says "开书房空调" → list → find → safety → confirm → execute → audit."""

    def test_find_study_ac_by_name(self, mock_client, safety):
        """Step 1: List devices, find '书房空调'."""
        mock_client.get_states = MagicMock(return_value=HOME_DEVICES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(MagicMock(cache=False, domain="climate", all=False))

        result = json.loads(buf.getvalue())
        # Should find 3 climate entities
        assert result["count"] == 3
        study_ac = next(d for d in result["devices"] if "书房" in d["name"])
        assert study_ac["entity_id"] == "climate.study_ac"
        assert study_ac["state"] == "off"

    def test_study_ac_safety_is_need_confirm(self, mock_client, safety):
        """Step 2: climate domain defaults to need_confirm."""
        level = safety.get_safety_level("climate.study_ac")
        assert level == "need_confirm"

    def test_study_ac_blocked_without_confirmation(self, mock_client, safety, audit, tmp_audit):
        """Step 3: First attempt without --confirmed → blocked."""
        args = MagicMock()
        args.entity_id = "climate.study_ac"
        args.action = "turn_on"
        args.value = ""
        args.confirmed = False

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_not_called()

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "blocked"
        assert entry["risk_level"] == "need_confirm"

    def test_study_ac_executed_with_confirmation(self, mock_client, safety, audit, tmp_audit):
        """Step 4: Second attempt with --confirmed → executed."""
        args = MagicMock()
        args.entity_id = "climate.study_ac"
        args.action = "turn_on"
        args.value = ""
        args.confirmed = True

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once_with(
            "climate", "turn_on", {"entity_id": "climate.study_ac"}
        )

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "confirmed"
        assert entry["entity_id"] == "climate.study_ac"
        assert entry["action"] == "turn_on"

    def test_full_chain_audit_trail(self, mock_client, safety, audit, tmp_audit):
        """Full chain: blocked attempt + confirmed attempt → 2 audit entries."""
        # Attempt 1: blocked
        args1 = MagicMock()
        args1.entity_id = "climate.study_ac"
        args1.action = "turn_on"
        args1.value = ""
        args1.confirmed = False

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args1)

        # Attempt 2: confirmed
        args2 = MagicMock()
        args2.entity_id = "climate.study_ac"
        args2.action = "turn_on"
        args2.value = ""
        args2.confirmed = True

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args2)

        lines = open(tmp_audit).read().strip().split("\n")
        assert len(lines) == 2

        entry1 = json.loads(lines[0])
        entry2 = json.loads(lines[1])
        assert entry1["result"] == "blocked"
        assert entry2["result"] == "confirmed"
        assert entry1["entity_id"] == entry2["entity_id"] == "climate.study_ac"


# ── Full Chain: "开客厅灯" (low risk, no confirmation needed) ──

class TestTurnOnLivingRoomLight:
    """Simulate: user says "开客厅灯" → find → allow_auto → execute directly."""

    def test_light_safety_is_allow_auto(self, safety):
        """light domain defaults to allow_auto."""
        assert safety.get_safety_level("light.living_main") == "allow_auto"

    def test_light_executes_without_confirmation(self, mock_client, safety, audit, tmp_audit):
        """Light should execute directly without --confirmed."""
        args = MagicMock()
        args.entity_id = "light.living_main"
        args.action = "turn_on"
        args.value = ""
        args.confirmed = False

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once_with(
            "light", "turn_on", {"entity_id": "light.living_main"}
        )

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "executed"
        assert entry["risk_level"] == "allow_auto"


# ── Full Chain: "开前门锁" (blocked) ──

class TestOpenFrontDoor:
    """Simulate: user says "开前门锁" → block → rejected even with confirmation."""

    def test_lock_safety_is_block(self, safety):
        """lock domain defaults to block."""
        assert safety.get_safety_level("lock.front_door") == "block"

    def test_lock_blocked_even_with_confirmation(self, mock_client, safety, audit):
        """Door lock should be blocked even with --confirmed."""
        args = MagicMock()
        args.entity_id = "lock.front_door"
        args.action = "unlock"
        args.value = ""
        args.confirmed = True  # Even with confirmation!

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_not_called()


# ── Full Chain: "把卧室空调调到25度" ──

class TestSetBedroomACTemperature:
    """Simulate: user says "把卧室空调调到25度" → find → confirm → set_temperature."""

    def test_set_temperature_with_confirmation(self, mock_client, safety, audit, tmp_audit):
        """Set bedroom AC to 25° with confirmation."""
        args = MagicMock()
        args.entity_id = "climate.bedroom_ac"
        args.action = "set_temperature"
        args.value = "25"
        args.confirmed = True

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once_with(
            "climate", "set_temperature",
            {"entity_id": "climate.bedroom_ac", "temperature": 25.0}
        )

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "confirmed"
        assert entry["value"] == "25"

    def test_set_temperature_blocked_without_confirmation(self, mock_client, safety, audit, tmp_audit):
        """Set bedroom AC to 25° without confirmation → blocked."""
        args = MagicMock()
        args.entity_id = "climate.bedroom_ac"
        args.action = "set_temperature"
        args.value = "25"
        args.confirmed = False

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_not_called()

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "blocked"


# ── Error Scenarios ──

class TestErrorScenarios:
    """Test error scenarios in the full chain."""

    def test_ha_unreachable_during_control(self, mock_client, safety, audit, tmp_audit):
        """If HA goes down during control, audit should log 'error'."""
        mock_client.call_service = MagicMock(side_effect=ConnectionError("HA unreachable"))

        args = MagicMock()
        args.entity_id = "light.living_main"
        args.action = "turn_on"
        args.value = ""
        args.confirmed = False

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "error"
        assert "HA unreachable" in entry["reason"]

    def test_device_not_found_in_list(self, mock_client, safety):
        """Searching for a non-existent device returns empty list."""
        mock_client.get_states = MagicMock(return_value=HOME_DEVICES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(MagicMock(cache=False, domain="media_player", all=False))

        result = json.loads(buf.getvalue())
        assert result["count"] == 0  # No media_player devices

    def test_audit_recent_after_operations(self, mock_client, safety, audit, tmp_audit):
        """Audit recent() should return entries in reverse chronological order."""
        # Execute 3 operations
        for eid, action in [("light.a", "turn_on"), ("light.b", "turn_off"), ("switch.c", "toggle")]:
            args = MagicMock()
            args.entity_id = eid
            args.action = action
            args.value = ""
            args.confirmed = False
            with patch.object(ctrl, "get_client", return_value=mock_client), \
                 patch.object(ctrl, "SafetyChecker", return_value=safety), \
                 patch.object(ctrl, "AuditLogger", return_value=audit):
                ctrl.cmd_control(args)

        recent = audit.recent(limit=3)
        assert len(recent) == 3
        # Most recent first
        assert recent[0]["entity_id"] == "switch.c"
        assert recent[2]["entity_id"] == "light.a"
