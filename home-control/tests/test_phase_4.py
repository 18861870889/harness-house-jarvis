"""
Phase 4 Tests: Automation CRUD + YAML generation + preference learning + context injection.

Tests cover:
  4.1: AutomationManager CRUD (create/list/get/update/delete/trigger)
  4.2: YAML generator (natural language → HA automation spec)
  4.3: PreferenceManager (command pattern recording + persistence)
  4.4: Context injection (LLM context from Obsidian preferences)
  4.5: Integration ("每天23点关灯" → automation creation + execution)
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
from automation_manager import AutomationManager
from yaml_generator import (
    generate_automation, validate_spec,
    parse_time_trigger, parse_sun_trigger, parse_numeric_trigger,
    parse_action,
)
from preference_manager import PreferenceManager


# ── Step 4.1: AutomationManager CRUD ──

class TestAutomationManagerCRUD:
    """Test HA automation CRUD operations."""

    @pytest.fixture
    def manager(self):
        mgr = AutomationManager(base_url="http://localhost:8123", token="fake")
        return mgr

    def test_create_automation(self, manager):
        """Create should POST to /api/config/automation/config."""
        spec = {
            "alias": "每晚关灯",
            "trigger": [{"platform": "time", "at": "23:00:00"}],
            "action": [{"service": "light.turn_off", "target": {"entity_id": "all"}}],
        }
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = json.dumps({"id": "auto_123"})
        mock_response.json.return_value = {"id": "auto_123"}

        with patch("requests.post", return_value=mock_response):
            result = manager.create(spec)

        assert result == {"id": "auto_123"}

    def test_list_automations(self, manager):
        """List should return only automation.* entities."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = [
            {"entity_id": "automation.test1", "state": "on"},
            {"entity_id": "light.test", "state": "on"},
            {"entity_id": "automation.test2", "state": "off"},
        ]
        mock_response.raise_for_status = MagicMock()

        with patch("requests.get", return_value=mock_response):
            automations = manager.list()

        assert len(automations) == 2
        assert all(a["entity_id"].startswith("automation.") for a in automations)

    def test_get_automation(self, manager):
        """Get should return a single automation state."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"entity_id": "automation.test", "state": "on"}
        mock_response.raise_for_status = MagicMock()

        with patch("requests.get", return_value=mock_response):
            result = manager.get("automation.test")

        assert result["entity_id"] == "automation.test"

    def test_get_automation_not_found(self, manager):
        """Get should return None for 404."""
        mock_response = MagicMock()
        mock_response.status_code = 404

        with patch("requests.get", return_value=mock_response):
            result = manager.get("automation.nonexistent")

        assert result is None

    def test_delete_automation(self, manager):
        """Delete should return True on success."""
        mock_response = MagicMock()
        mock_response.status_code = 200

        with patch("requests.delete", return_value=mock_response):
            result = manager.delete("auto_123")

        assert result is True

    def test_delete_automation_failure(self, manager):
        """Delete should return False on failure."""
        mock_response = MagicMock()
        mock_response.status_code = 500
        mock_response.text = "Internal error"

        with patch("requests.delete", return_value=mock_response):
            result = manager.delete("auto_123")

        assert result is False

    def test_trigger_automation(self, manager):
        """Trigger should call automation.trigger service."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = json.dumps({"ok": True})
        mock_response.json.return_value = {"ok": True}
        mock_response.raise_for_status = MagicMock()

        with patch("requests.post", return_value=mock_response):
            result = manager.trigger("automation.test")

        assert result == {"ok": True}

    def test_create_logs_audit(self, manager):
        """Create should log to audit trail."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "{}"
        mock_response.json.return_value = {}
        mock_response.raise_for_status = MagicMock()

        manager.audit = MagicMock()

        with patch("requests.post", return_value=mock_response):
            manager.create({"alias": "test", "trigger": [], "action": []})

        manager.audit.log.assert_called_once()

    def test_update_automation(self, manager):
        """Update should POST to /api/config/automation/config/{id}."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = "{}"
        mock_response.json.return_value = {}
        mock_response.raise_for_status = MagicMock()

        with patch("requests.post", return_value=mock_response):
            result = manager.update("auto_123", {"alias": "updated"})

        assert result == {}


# ── Step 4.2: YAML Generator ──

class TestYAMLGenerator:
    """Test natural language → HA automation spec conversion."""

    def test_parse_time_trigger_23(self):
        """'每天23点' should parse to 23:00:00."""
        trigger = parse_time_trigger("每天23点关灯")
        assert trigger == {"platform": "time", "at": "23:00:00"}

    def test_parse_time_trigger_8_30(self):
        """'每日8:30' should parse to 08:30:00."""
        trigger = parse_time_trigger("每日8:30开灯")
        assert trigger == {"platform": "time", "at": "08:30:00"}

    def test_parse_time_trigger_no_time(self):
        """Text without time should return None."""
        assert parse_time_trigger("开灯") is None

    def test_parse_sun_trigger_sunset(self):
        """'日落' should parse to sunset trigger."""
        trigger = parse_sun_trigger("日落时开灯")
        assert trigger == {"platform": "sun", "event": "sunset"}

    def test_parse_sun_trigger_sunrise(self):
        """'日出' should parse to sunrise trigger."""
        trigger = parse_sun_trigger("日出时关灯")
        assert trigger == {"platform": "sun", "event": "sunrise"}

    def test_parse_numeric_trigger(self):
        """'温度超过28度' should parse to numeric_state trigger."""
        trigger = parse_numeric_trigger("温度超过28度开空调")
        assert trigger["platform"] == "numeric_state"
        assert trigger["above"] == 28.0

    def test_parse_action_light_off(self):
        """'关灯' should parse to light.turn_off."""
        action = parse_action("关灯")
        assert action["service"] == "light.turn_off"

    def test_parse_action_light_on(self):
        """'开灯' should parse to light.turn_on."""
        action = parse_action("开灯")
        assert action["service"] == "light.turn_on"

    def test_parse_action_climate_on(self):
        """'开空调' should parse to climate.turn_on."""
        action = parse_action("开空调")
        assert action["service"] == "climate.turn_on"

    def test_parse_action_cover_close(self):
        """'关窗帘' should parse to cover.close_cover."""
        action = parse_action("关窗帘")
        assert action["service"] == "cover.close_cover"

    def test_generate_automation_time_light(self):
        """Full: '每天23点关灯' → valid spec."""
        spec = generate_automation("每天23点关灯")
        assert spec["alias"] == "每天23点关灯"
        assert spec["trigger"][0]["platform"] == "time"
        assert spec["trigger"][0]["at"] == "23:00:00"
        assert spec["action"][0]["service"] == "light.turn_off"
        assert spec["mode"] == "single"

    def test_generate_automation_sun_light(self):
        """Full: '日落时开灯' → valid spec."""
        spec = generate_automation("日落时开灯")
        assert spec["trigger"][0]["platform"] == "sun"
        assert spec["trigger"][0]["event"] == "sunset"
        assert spec["action"][0]["service"] == "light.turn_on"

    def test_generate_automation_temp_climate(self):
        """Full: '温度超过28度开空调' → valid spec."""
        spec = generate_automation("温度超过28度开空调")
        assert spec["trigger"][0]["platform"] == "numeric_state"
        assert spec["trigger"][0]["above"] == 28.0
        assert spec["action"][0]["service"] == "climate.turn_on"

    def test_generate_automation_with_alias(self):
        """Should accept custom alias."""
        spec = generate_automation("每天23点关灯", alias="夜间关灯")
        assert spec["alias"] == "夜间关灯"

    def test_generate_automation_no_action_raises(self):
        """Unparseable action should raise ValueError."""
        with pytest.raises(ValueError, match="无法解析操作"):
            generate_automation("每天23点做奇怪的事")

    def test_generate_automation_no_trigger_raises(self):
        """No trigger found should raise ValueError."""
        with pytest.raises(ValueError, match="无法解析触发条件"):
            generate_automation("关灯")

    def test_validate_spec_valid(self):
        """Valid spec should return empty error list."""
        spec = {
            "alias": "test",
            "trigger": [{"platform": "time", "at": "23:00:00"}],
            "action": [{"service": "light.turn_off"}],
        }
        errors = validate_spec(spec)
        assert errors == []

    def test_validate_spec_missing_alias(self):
        """Missing alias should report error."""
        errors = validate_spec({"trigger": [], "action": []})
        assert "Missing alias" in errors

    def test_validate_spec_missing_trigger(self):
        """Missing trigger should report error."""
        errors = validate_spec({"alias": "test", "action": []})
        assert "Missing trigger" in errors

    def test_validate_spec_missing_action(self):
        """Missing action should report error."""
        errors = validate_spec({"alias": "test", "trigger": []})
        assert "Missing action" in errors

    def test_validate_spec_trigger_not_list(self):
        """Trigger not a list should report error."""
        errors = validate_spec({
            "alias": "test",
            "trigger": {"platform": "time"},
            "action": [],
        })
        assert any("must be a list" in e for e in errors)


# ── Step 4.3: Preference Manager ──

class TestPreferenceManager:
    """Test command pattern recording and persistence."""

    @pytest.fixture
    def pref_mgr(self, tmp_path):
        log = str(tmp_path / "cmd-log.jsonl")
        note = str(tmp_path / "prefs.md")
        return PreferenceManager(log_path=log, note_path=note)

    def test_record_command(self, pref_mgr, tmp_path):
        """Record should write to JSONL log."""
        entry = pref_mgr.record("light.test", "turn_on")
        
        assert entry["entity_id"] == "light.test"
        assert entry["action"] == "turn_on"
        
        # Verify written to file
        lines = open(pref_mgr.log_path).read().strip().split("\n")
        assert len(lines) == 1
        logged = json.loads(lines[0])
        assert logged["entity_id"] == "light.test"

    def test_record_multiple(self, pref_mgr):
        """Multiple records should append to log."""
        for i in range(5):
            pref_mgr.record(f"light.device_{i}", "turn_on")
        
        lines = open(pref_mgr.log_path).read().strip().split("\n")
        assert len(lines) == 5

    def test_load_observations_empty(self, pref_mgr):
        """Empty log should return empty list."""
        assert pref_mgr.load_observations() == []

    def test_load_observations(self, pref_mgr):
        """Should load all observations."""
        for i in range(10):
            pref_mgr.record(f"light.device_{i}", "turn_on")
        
        obs = pref_mgr.load_observations()
        assert len(obs) == 10
        assert obs[0]["entity_id"] == "light.device_0"

    def test_load_observations_limit(self, pref_mgr):
        """Should respect limit parameter."""
        for i in range(20):
            pref_mgr.record(f"light.device_{i}", "turn_on")
        
        obs = pref_mgr.load_observations(limit=5)
        assert len(obs) == 5

    def test_analyze_patterns_empty(self, pref_mgr):
        """No observations → empty patterns."""
        patterns = pref_mgr.analyze_patterns()
        assert patterns["total_commands"] == 0
        assert patterns["top_devices"] == []

    def test_analyze_patterns_top_devices(self, pref_mgr):
        """Should identify most frequently controlled devices."""
        pref_mgr.record("light.a", "turn_on")
        pref_mgr.record("light.a", "turn_off")
        pref_mgr.record("light.a", "turn_on")
        pref_mgr.record("light.b", "turn_on")
        
        patterns = pref_mgr.analyze_patterns()
        assert patterns["total_commands"] == 4
        assert patterns["top_devices"][0]["entity_id"] == "light.a"
        assert patterns["top_devices"][0]["count"] == 3

    def test_analyze_patterns_time(self, pref_mgr):
        """Should identify time patterns."""
        # Record commands at specific hours
        for hour in [8, 8, 8, 22, 22]:
            ts = f"2026-06-01T{hour:02d}:00:00+0800"
            pref_mgr.record("light.test", "turn_on", timestamp=ts)
        
        patterns = pref_mgr.analyze_patterns()
        hours = [tp["hour"] for tp in patterns["time_patterns"]]
        assert 8 in hours
        assert 22 in hours

    def test_save_to_obsidian(self, pref_mgr):
        """Should write preference note to Obsidian."""
        pref_mgr.record("light.test", "turn_on")
        pref_mgr.record("switch.test", "turn_off")
        
        note_path = pref_mgr.save_to_obsidian()
        assert os.path.exists(note_path)
        
        content = open(note_path).read()
        assert "用户偏好" in content
        assert "常用设备" in content
        assert "light.test" in content

    def test_save_to_obsidian_has_suggestions(self, pref_mgr):
        """Should include automation suggestions when patterns are strong."""
        # Create a strong pattern: same device at same hour, 3+ times
        for i in range(5):
            ts = f"2026-06-0{i+1}T23:00:00+0800"
            pref_mgr.record("light.living", "turn_off", timestamp=ts)
        
        pref_mgr.save_to_obsidian()
        content = open(pref_mgr.note_path).read()
        assert "建议" in content
        assert "23" in content  # Should suggest 23:00


# ── Step 4.4: Context Injection ──

class TestContextInjection:
    """Test LLM context injection from preferences."""

    @pytest.fixture
    def pref_mgr(self, tmp_path):
        return PreferenceManager(
            log_path=str(tmp_path / "cmd-log.jsonl"),
            note_path=str(tmp_path / "prefs.md"),
        )

    def test_empty_context(self, pref_mgr):
        """No data → default message."""
        ctx = pref_mgr.get_context_for_llm()
        assert "暂无" in ctx

    def test_context_with_devices(self, pref_mgr):
        """Context should include top devices."""
        pref_mgr.record("light.a", "turn_on")
        pref_mgr.record("light.a", "turn_off")
        pref_mgr.record("light.b", "turn_on")
        
        ctx = pref_mgr.get_context_for_llm()
        assert "light.a" in ctx
        assert "常用设备" in ctx

    def test_context_with_time_patterns(self, pref_mgr):
        """Context should include peak hours."""
        for i in range(3):
            ts = f"2026-06-0{i+1}T22:00:00+0800"
            pref_mgr.record("light.test", "turn_off", timestamp=ts)
        
        ctx = pref_mgr.get_context_for_llm()
        assert "22" in ctx or "活跃时段" in ctx

    def test_context_compact(self, pref_mgr):
        """Context should be a single line for easy injection."""
        pref_mgr.record("light.a", "turn_on")
        
        ctx = pref_mgr.get_context_for_llm()
        # Should be a few lines at most, pipe-separated
        lines = ctx.split("\n")
        assert len(lines) <= 5


# ── Step 4.5: Integration ──

class TestPhase4Integration:
    """End-to-end: '每天23点关灯' → automation creation + execution."""

    def test_full_chain_generate_and_validate(self):
        """Generate spec from natural language, validate it."""
        # Step 1: Generate
        spec = generate_automation("每天23点关灯", alias="夜间关灯")
        
        # Step 2: Validate
        errors = validate_spec(spec)
        assert errors == [], f"Validation errors: {errors}"
        
        # Verify spec content
        assert spec["alias"] == "夜间关灯"
        assert spec["trigger"][0]["at"] == "23:00:00"
        assert spec["action"][0]["service"] == "light.turn_off"

    def test_full_chain_with_mock_ha(self):
        """Full chain: generate → create on HA → audit logged."""
        mgr = AutomationManager(base_url="http://localhost:8123", token="fake")
        mgr.audit = MagicMock()
        
        spec = generate_automation("每天23点关灯")
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.text = json.dumps({"id": "auto_new"})
        mock_response.json.return_value = {"id": "auto_new"}
        mock_response.raise_for_status = MagicMock()
        
        with patch("requests.post", return_value=mock_response):
            result = mgr.create(spec)
        
        assert result["id"] == "auto_new"
        mgr.audit.log.assert_called_once()

    def test_preference_to_automation_suggestion(self, tmp_path):
        """Preference pattern → automation suggestion → valid spec."""
        pref = PreferenceManager(
            log_path=str(tmp_path / "cmd-log.jsonl"),
            note_path=str(tmp_path / "prefs.md"),
        )
        
        # Simulate a pattern: turn off lights at 23:00 for 5 days
        for i in range(5):
            ts = f"2026-06-{i+1:02d}T23:00:00+0800"
            pref.record("light.living", "turn_off", timestamp=ts)
        
        patterns = pref.analyze_patterns()
        assert len(patterns["suggestions"]) > 0
        
        suggestion = patterns["suggestions"][0]
        assert suggestion["hour"] == 23
        assert suggestion["action"] == "turn_off"
        
        # Generate automation from suggestion
        desc = suggestion["description"]
        spec = generate_automation(desc)
        errors = validate_spec(spec)
        assert errors == []
        assert spec["trigger"][0]["at"] == "23:00:00"
        assert spec["action"][0]["service"] == "light.turn_off"

    def test_all_scripts_importable(self):
        """All Phase 4 scripts should be importable."""
        import automation_manager
        import yaml_generator
        import preference_manager
        assert hasattr(automation_manager, "AutomationManager")
        assert hasattr(yaml_generator, "generate_automation")
        assert hasattr(preference_manager, "PreferenceManager")
