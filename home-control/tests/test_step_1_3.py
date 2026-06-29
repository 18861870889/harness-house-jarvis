"""
Step 1.3 Tests: control_device — safety check, execution, audit, error handling.

Tests cover the full control flow: safety enforcement → service call → audit logging.
All tests mock HA REST API (no live HA needed).
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
    """Temporary audit log file."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".jsonl", delete=False) as f:
        path = f.name
    yield path
    os.unlink(path)


@pytest.fixture
def tmp_policy():
    """Temporary safety policy file."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write("{}")
        path = f.name
    yield path
    os.unlink(path)


@pytest.fixture
def mock_client():
    """A HAClient with mocked REST methods."""
    client = HAClient(base_url="http://localhost:8123", token="fake")
    client.call_service = MagicMock(return_value={})
    client.get_states = MagicMock(return_value=[])
    return client


@pytest.fixture
def safety(tmp_policy):
    """SafetyChecker with temp policy file."""
    return SafetyChecker(policy_path=tmp_policy, devices_dir="/nonexistent")


@pytest.fixture
def audit(tmp_audit):
    """AuditLogger with temp file."""
    return AuditLogger(path=tmp_audit)


def make_args(entity_id, action, value="", confirmed=False):
    """Build a mock argparse namespace for control command."""
    args = MagicMock()
    args.entity_id = entity_id
    args.action = action
    args.value = value
    args.confirmed = confirmed
    return args


# ── Safety Enforcement Tests ──

class TestSafetyEnforcement:
    """Test that safety levels correctly gate command execution."""

    def test_block_prevents_execution(self, mock_client, safety, audit, tmp_audit):
        """A block-level device should not execute, and audit should log 'blocked'."""
        safety.set_safety_level("lock.front_door", "block")
        args = make_args("lock.front_door", "unlock")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_not_called()

        lines = open(tmp_audit).read().strip().split("\n")
        entry = json.loads(lines[-1])
        assert entry["result"] == "blocked"
        assert entry["risk_level"] == "block"
        assert entry["entity_id"] == "lock.front_door"

    def test_need_confirm_blocks_without_confirmation(self, mock_client, safety, audit, tmp_audit):
        """need_confirm without --confirmed should block and indicate needs_confirmation."""
        safety.set_safety_level("climate.bedroom", "need_confirm")
        args = make_args("climate.bedroom", "set_temperature", value="25", confirmed=False)

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_not_called()

        lines = open(tmp_audit).read().strip().split("\n")
        entry = json.loads(lines[-1])
        assert entry["result"] == "blocked"
        assert entry["risk_level"] == "need_confirm"

    def test_need_confirm_executes_with_confirmation(self, mock_client, safety, audit, tmp_audit):
        """need_confirm with --confirmed should proceed to execution."""
        safety.set_safety_level("climate.bedroom", "need_confirm")
        args = make_args("climate.bedroom", "set_temperature", value="25", confirmed=True)

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once()

        lines = open(tmp_audit).read().strip().split("\n")
        entry = json.loads(lines[-1])
        assert entry["result"] == "confirmed"
        assert entry["risk_level"] == "need_confirm"

    def test_allow_auto_executes_directly(self, mock_client, safety, audit, tmp_audit):
        """allow_auto should execute without confirmation."""
        safety.set_safety_level("switch.living_room", "allow_auto")
        args = make_args("switch.living_room", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once()

        lines = open(tmp_audit).read().strip().split("\n")
        entry = json.loads(lines[-1])
        assert entry["result"] == "executed"

    def test_block_not_bypassed_by_confirmation(self, mock_client, safety, audit):
        """--confirmed should NOT bypass a block-level device."""
        safety.set_safety_level("lock.front_door", "block")
        args = make_args("lock.front_door", "unlock", confirmed=True)

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_not_called()

    def test_domain_default_applied(self, mock_client, safety, audit, tmp_audit):
        """Unknown entity uses domain default (light → allow_auto, lock → block)."""
        # light → allow_auto by default
        args = make_args("light.unknown_light", "turn_on")
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)
        mock_client.call_service.assert_called_once()

        # lock → block by default
        mock_client.call_service.reset_mock()
        args = make_args("lock.unknown_lock", "unlock")
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)
        mock_client.call_service.assert_not_called()


# ── Service Data Construction Tests ──

class TestServiceData:
    """Test that service data is correctly constructed for different actions."""

    def test_turn_on(self, mock_client, safety, audit):
        """turn_on should call switch.turn_on with entity_id."""
        safety.set_safety_level("switch.test", "allow_auto")
        args = make_args("switch.test", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once_with(
            "switch", "turn_on", {"entity_id": "switch.test"}
        )

    def test_turn_off(self, mock_client, safety, audit):
        """turn_off should call domain.turn_off."""
        safety.set_safety_level("light.test", "allow_auto")
        args = make_args("light.test", "turn_off")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once_with(
            "light", "turn_off", {"entity_id": "light.test"}
        )

    def test_set_temperature(self, mock_client, safety, audit):
        """set_temperature should include temperature as float."""
        safety.set_safety_level("climate.test", "allow_auto")
        args = make_args("climate.test", "set_temperature", value="25.5")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once_with(
            "climate", "set_temperature", {"entity_id": "climate.test", "temperature": 25.5}
        )

    def test_set_position(self, mock_client, safety, audit):
        """set_position should include position as int."""
        safety.set_safety_level("cover.test", "allow_auto")
        args = make_args("cover.test", "set_position", value="50")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once_with(
            "cover", "set_position", {"entity_id": "cover.test", "position": 50}
        )

    def test_toggle(self, mock_client, safety, audit):
        """toggle should call domain.toggle."""
        safety.set_safety_level("switch.test", "allow_auto")
        args = make_args("switch.test", "toggle")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_called_once_with(
            "switch", "toggle", {"entity_id": "switch.test"}
        )

    def test_set_humidity(self, mock_client, safety, audit):
        """set_humidity should pass humidity value as string."""
        safety.set_safety_level("climate.test", "allow_auto")
        args = make_args("climate.test", "set_humidity", value="60")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        call_args = mock_client.call_service.call_args
        assert call_args[0][0] == "climate"
        assert call_args[0][1] == "set_humidity"
        assert call_args[0][2]["humidity"] == "60"

    def test_no_value_for_non_set_action(self, mock_client, safety, audit):
        """turn_on without --value should not add any extra fields."""
        safety.set_safety_level("switch.test", "allow_auto")
        args = make_args("switch.test", "turn_on", value="")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        call_args = mock_client.call_service.call_args
        assert call_args[0][2] == {"entity_id": "switch.test"}

    def test_domain_extraction(self, mock_client, safety, audit):
        """Domain should be correctly extracted from entity_id."""
        safety.set_safety_level("vacuum.test", "allow_auto")
        args = make_args("vacuum.test", "start")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        call_args = mock_client.call_service.call_args
        assert call_args[0][0] == "vacuum"
        assert call_args[0][1] == "start"


# ── Audit Logging Tests ──

class TestAuditLogging:
    """Test that audit entries are correctly written for all outcomes."""

    def test_audit_on_success(self, mock_client, safety, audit, tmp_audit):
        """Successful execution writes 'executed' audit entry with latency."""
        safety.set_safety_level("switch.test", "allow_auto")
        args = make_args("switch.test", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "executed"
        assert entry["latency_ms"] >= 0
        assert entry["entity_id"] == "switch.test"
        assert entry["action"] == "turn_on"
        assert entry["risk_level"] == "allow_auto"

    def test_audit_on_blocked(self, mock_client, safety, audit, tmp_audit):
        """Blocked execution writes 'blocked' audit entry with reason."""
        safety.set_safety_level("lock.test", "block")
        args = make_args("lock.test", "unlock")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "blocked"
        assert "block" in entry["reason"]
        assert entry["latency_ms"] == 0  # No execution, no latency

    def test_audit_on_error(self, mock_client, safety, audit, tmp_audit):
        """Failed execution writes 'error' audit entry with error message."""
        safety.set_safety_level("switch.test", "allow_auto")
        mock_client.call_service = MagicMock(side_effect=Exception("HA service unavailable"))
        args = make_args("switch.test", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "error"
        assert "HA service unavailable" in entry["reason"]

    def test_audit_on_confirmed(self, mock_client, safety, audit, tmp_audit):
        """Confirmed execution writes 'confirmed' audit entry."""
        safety.set_safety_level("climate.test", "need_confirm")
        args = make_args("climate.test", "set_temperature", value="25", confirmed=True)

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "confirmed"
        assert entry["risk_level"] == "need_confirm"

    def test_audit_value_recorded(self, mock_client, safety, audit, tmp_audit):
        """The --value should be recorded in audit log."""
        safety.set_safety_level("climate.test", "allow_auto")
        args = make_args("climate.test", "set_temperature", value="26.5")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["value"] == "26.5"


# ── Error Handling Tests ──

class TestErrorHandling:
    """Test error handling for HA failures and edge cases."""

    def test_ha_connection_error(self, mock_client, safety, audit, tmp_audit):
        """When HA is unreachable, should log 'error' and print error JSON."""
        safety.set_safety_level("switch.test", "allow_auto")
        mock_client.call_service = MagicMock(side_effect=ConnectionError("Network unreachable"))
        args = make_args("switch.test", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "error"
        assert "Network unreachable" in entry["reason"]

    def test_ha_timeout_error(self, mock_client, safety, audit, tmp_audit):
        """When HA times out, should log 'error'."""
        import requests
        safety.set_safety_level("switch.test", "allow_auto")
        mock_client.call_service = MagicMock(side_effect=requests.Timeout("Request timed out"))
        args = make_args("switch.test", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["result"] == "error"

    def test_unknown_domain_defaults_block(self, mock_client, safety, audit):
        """An entity with an unknown domain (not in DOMAIN_DEFAULTS) should default to block."""
        args = make_args("unknown_domain.test", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        mock_client.call_service.assert_not_called()

    def test_no_entity_dot_in_id(self, mock_client, safety, audit):
        """An entity_id without a dot (no domain) should be handled gracefully."""
        # "unknown" has no domain separator → domain is empty string
        # DOMAIN_DEFAULTS doesn't have "" → defaults to "block"
        args = make_args("malformed_entity", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        # Should be blocked (unknown domain defaults to block)
        mock_client.call_service.assert_not_called()


# ── Latency Tracking Tests ──

class TestLatencyTracking:
    """Test that latency is measured and recorded."""

    def test_latency_recorded_on_success(self, mock_client, safety, audit, tmp_audit):
        """Latency should be a non-negative integer (milliseconds)."""
        safety.set_safety_level("switch.test", "allow_auto")
        args = make_args("switch.test", "turn_on")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert isinstance(entry["latency_ms"], int)
        assert entry["latency_ms"] >= 0

    def test_latency_zero_on_blocked(self, mock_client, safety, audit, tmp_audit):
        """Blocked commands should have 0 latency (no HA call made)."""
        safety.set_safety_level("lock.test", "block")
        args = make_args("lock.test", "unlock")

        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), \
             patch.object(ctrl, "AuditLogger", return_value=audit):
            ctrl.cmd_control(args)

        entry = json.loads(open(tmp_audit).read().strip().split("\n")[-1])
        assert entry["latency_ms"] == 0
