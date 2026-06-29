"""
Tests for home-control skill — Step 1.1 skeleton verification.
Covers: file structure, HAClient, SafetyChecker, AuditLogger, control CLI.
All tests use mocks — no real HA connection required.
"""

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Paths
SKILL_DIR = Path(__file__).parent.parent
SCRIPTS_DIR = SKILL_DIR / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))


# ── Skill Structure Tests ──

class TestSkillStructure:
    """Verify the skill directory structure is correct."""

    def test_skill_md_exists(self):
        assert (SKILL_DIR / "SKILL.md").exists()

    def test_scripts_dir_exists(self):
        assert (SKILL_DIR / "scripts").exists()

    def test_control_py_exists(self):
        assert (SCRIPTS_DIR / "control.py").exists()

    def test_ha_client_exists(self):
        assert (SCRIPTS_DIR / "ha_client.py").exists()

    def test_safety_exists(self):
        assert (SCRIPTS_DIR / "safety.py").exists()

    def test_audit_exists(self):
        assert (SCRIPTS_DIR / "audit.py").exists()

    def test_skill_md_has_frontmatter(self):
        content = (SKILL_DIR / "SKILL.md").read_text()
        assert content.startswith("---")
        assert "name: home-control" in content

    def test_skill_md_documents_commands(self):
        content = (SKILL_DIR / "SKILL.md").read_text()
        assert "list" in content
        assert "control" in content
        assert "state" in content
        assert "safety" in content


# ── HAClient Tests ──

class TestHAClient:
    """Test HA client REST and cache functionality (mocked)."""

    def test_init_with_defaults(self):
        from ha_client import HAClient
        client = HAClient(base_url="http://localhost:8123", token="test_token")
        assert client.base_url == "http://localhost:8123"
        assert client.token == "test_token"
        assert client.ws_url == "ws://localhost:8123/api/websocket"

    def test_init_strips_trailing_slash(self):
        from ha_client import HAClient
        client = HAClient(base_url="http://localhost:8123/", token="t")
        assert client.base_url == "http://localhost:8123"

    def test_get_states_mock(self):
        from ha_client import HAClient
        client = HAClient(base_url="http://localhost:8123", token="t")
        mock_resp = MagicMock()
        mock_resp.json.return_value = [
            {"entity_id": "switch.test", "state": "off"},
            {"entity_id": "light.lamp", "state": "on"},
        ]
        mock_resp.raise_for_status = MagicMock()
        with patch("ha_client.requests.get", return_value=mock_resp):
            states = client.get_states()
        assert len(states) == 2
        assert states[0]["entity_id"] == "switch.test"

    def test_init_state_cache(self):
        from ha_client import HAClient
        client = HAClient(base_url="http://localhost:8123", token="t")
        mock_resp = MagicMock()
        mock_resp.json.return_value = [
            {"entity_id": "switch.test", "state": "off"},
            {"entity_id": "light.lamp", "state": "on"},
        ]
        mock_resp.raise_for_status = MagicMock()
        with patch("ha_client.requests.get", return_value=mock_resp):
            client.init_state_cache()

        assert client.get_cached_state("switch.test")["state"] == "off"
        assert client.get_cached_state("light.lamp")["state"] == "on"
        assert client.get_cached_state("nonexistent") is None

    def test_call_service_mock(self):
        from ha_client import HAClient
        client = HAClient(base_url="http://localhost:8123", token="t")
        mock_resp = MagicMock()
        mock_resp.json.return_value = {}
        mock_resp.raise_for_status = MagicMock()
        mock_resp.text = "{}"
        with patch("ha_client.requests.post", return_value=mock_resp):
            result = client.call_service("switch", "turn_on", {"entity_id": "switch.test"})
        assert result == {}

    def test_get_state_404(self):
        from ha_client import HAClient
        client = HAClient(base_url="http://localhost:8123", token="t")
        mock_resp = MagicMock()
        mock_resp.status_code = 404
        with patch("ha_client.requests.get", return_value=mock_resp):
            result = client.get_state("switch.nonexistent")
        assert result is None

    def test_update_cache(self):
        from ha_client import HAClient
        client = HAClient(base_url="http://localhost:8123", token="t")
        client._update_cache("switch.test", {"entity_id": "switch.test", "state": "on"})
        assert client.get_cached_state("switch.test")["state"] == "on"

    def test_get_all_cached_states(self):
        from ha_client import HAClient
        client = HAClient(base_url="http://localhost:8123", token="t")
        client._update_cache("a", {"state": "on"})
        client._update_cache("b", {"state": "off"})
        all_states = client.get_all_cached_states()
        assert "a" in all_states
        assert "b" in all_states


# ── SafetyChecker Tests ──

class TestSafetyChecker:
    """Test safety policy enforcement."""

    def test_domain_default_switch(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            assert checker.get_safety_level("switch.test") == "allow_auto"

    def test_domain_default_climate(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            assert checker.get_safety_level("climate.ac") == "need_confirm"

    def test_domain_default_lock(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            assert checker.get_safety_level("lock.front_door") == "block"

    def test_policy_override(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = os.path.join(tmpdir, "policy.json")
            with open(policy_path, "w") as f:
                json.dump({"switch.fridge": "block"}, f)
            checker = SafetyChecker(
                policy_path=policy_path,
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            assert checker.get_safety_level("switch.fridge") == "block"

    def test_check_allow_auto(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            result = checker.check("switch.lamp", "turn_on")
            assert result["allowed"] is True
            assert result["level"] == "allow_auto"

    def test_check_block(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            policy_path = os.path.join(tmpdir, "policy.json")
            with open(policy_path, "w") as f:
                json.dump({"lock.door": "block"}, f)
            checker = SafetyChecker(policy_path=policy_path, devices_dir=os.path.join(tmpdir, "devices"))
            result = checker.check("lock.door", "unlock")
            assert result["allowed"] is False
            assert result["level"] == "block"

    def test_check_need_confirm(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            result = checker.check("climate.ac", "turn_on")
            assert result["allowed"] is False
            assert result["level"] == "need_confirm"
            assert result.get("needs_confirmation") is True

    def test_set_safety_level(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            assert checker.set_safety_level("switch.test", "block") is True
            assert checker.get_safety_level("switch.test") == "block"

    def test_set_invalid_level(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            assert checker.set_safety_level("switch.test", "invalid") is False

    def test_unknown_domain_defaults_to_block(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=os.path.join(tmpdir, "devices"),
            )
            assert checker.get_safety_level("unknown_thing.xyz") == "block"

    def test_obsidian_safety_read(self):
        from safety import SafetyChecker
        with tempfile.TemporaryDirectory() as tmpdir:
            devices_dir = os.path.join(tmpdir, "devices")
            os.makedirs(devices_dir)
            # Create a device note
            note = """---
entity_id: switch.special_light
name: 特殊灯
safety: block
---
This is a special light."""
            (Path(devices_dir) / "特殊灯.md").write_text(note, encoding="utf-8")

            checker = SafetyChecker(
                policy_path=os.path.join(tmpdir, "policy.json"),
                devices_dir=devices_dir,
            )
            assert checker.get_safety_level("switch.special_light") == "block"


# ── AuditLogger Tests ──

class TestAuditLogger:
    """Test audit logging."""

    def test_log_writes_entry(self):
        from audit import AuditLogger
        with tempfile.TemporaryDirectory() as tmpdir:
            logger = AuditLogger(path=os.path.join(tmpdir, "audit.jsonl"))
            entry = logger.log(
                entity_id="switch.test",
                action="turn_on",
                result="executed",
                latency_ms=50,
                risk_level="allow_auto",
            )
            assert entry["entity_id"] == "switch.test"
            assert entry["result"] == "executed"
            assert entry["latency_ms"] == 50

    def test_log_appends(self):
        from audit import AuditLogger
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "audit.jsonl")
            logger = AuditLogger(path=path)
            logger.log("switch.a", "turn_on", "executed")
            logger.log("switch.b", "turn_off", "executed")
            recent = logger.recent(limit=10)
            assert len(recent) == 2
            # Most recent first
            assert recent[0]["entity_id"] == "switch.b"

    def test_recent_empty(self):
        from audit import AuditLogger
        with tempfile.TemporaryDirectory() as tmpdir:
            logger = AuditLogger(path=os.path.join(tmpdir, "audit.jsonl"))
            assert logger.recent() == []

    def test_log_with_reason(self):
        from audit import AuditLogger
        with tempfile.TemporaryDirectory() as tmpdir:
            logger = AuditLogger(path=os.path.join(tmpdir, "audit.jsonl"))
            entry = logger.log(
                entity_id="lock.door",
                action="unlock",
                result="blocked",
                risk_level="block",
                reason="设备安全级别为 block",
            )
            assert entry["reason"] == "设备安全级别为 block"
            assert entry["result"] == "blocked"


# ── Control CLI Tests ──

class TestControlCLI:
    """Test the control.py CLI interface."""

    def test_help(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "control.py"), "--help"],
            capture_output=True, text=True,
        )
        assert result.returncode == 0
        assert "list" in result.stdout
        assert "control" in result.stdout

    def test_safety_get(self):
        env = os.environ.copy()
        env["HOME_CONTROL_POLICY_PATH"] = tempfile.mktemp()
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "control.py"), "safety", "switch.test"],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["safety"] == "allow_auto"

    def test_safety_set(self):
        env = os.environ.copy()
        policy_path = tempfile.mktemp()
        env["HOME_CONTROL_POLICY_PATH"] = policy_path
        # Set to block
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "control.py"), "safety", "switch.test", "block"],
            capture_output=True, text=True, env=env,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert data["safety"] == "block"
        assert data["status"] == "updated"
        # Verify it persisted
        with open(policy_path) as f:
            policy = json.load(f)
        assert policy["switch.test"] == "block"

    def test_control_blocked(self):
        """Test that a blocked device is not controlled."""
        env = os.environ.copy()
        policy_path = tempfile.mktemp()
        with open(policy_path, "w") as f:
            json.dump({"switch.fridge": "block"}, f)
        env["HOME_CONTROL_POLICY_PATH"] = policy_path
        env["HA_TOKEN"] = "fake_token"
        env["HA_BASE_URL"] = "http://localhost:9999"

        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "control.py"), "control", "switch.fridge", "turn_on"],
            capture_output=True, text=True, env=env,
        )
        data = json.loads(result.stdout)
        assert data["status"] == "blocked"
        assert data["level"] == "block"

    def test_no_token_error(self):
        """Test that missing HA_TOKEN produces an error."""
        env = os.environ.copy()
        env.pop("HA_TOKEN", None)
        result = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "control.py"), "list"],
            capture_output=True, text=True, env=env,
        )
        data = json.loads(result.stdout)
        assert "error" in data


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
