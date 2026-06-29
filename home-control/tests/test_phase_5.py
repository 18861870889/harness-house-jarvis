"""
Phase 5 Tests: Proactive response — anomaly detection, preference analysis, push.

Tests cover:
  5.1: Anomaly detection rules (lights/daytime, door/night, AC/window, offline)
  5.2: Anomaly detector script (cronjob entry point)
  5.3: Preference analyzer script (cronjob entry point)
  5.4: Integration (detect anomaly → format → push message)
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
from anomaly_detector import (
    detect_anomalies, format_alerts_for_wechat,
    _check_lights_on_daytime, _check_door_unlocked_night,
    _check_ac_window_open, _check_device_offline,
    ANOMALY_RULES,
)


# ── Sample States ──

SAMPLE_STATES = [
    {"entity_id": "light.living_room", "state": "on", "attributes": {"friendly_name": "客厅灯"}},
    {"entity_id": "light.bedroom", "state": "off", "attributes": {"friendly_name": "卧室灯"}},
    {"entity_id": "lock.front_door", "state": "locked", "attributes": {"friendly_name": "前门锁"}},
    {"entity_id": "lock.back_door", "state": "unlocked", "attributes": {"friendly_name": "后门锁"}},
    {"entity_id": "climate.living_ac", "state": "cool", "attributes": {"friendly_name": "客厅空调"}},
    {"entity_id": "cover.living_curtain", "state": "open", "attributes": {"friendly_name": "客厅窗帘"}},
    {"entity_id": "switch.garage", "state": "unavailable", "attributes": {"friendly_name": "车库开关"}},
    {"entity_id": "sensor.temperature", "state": "25.0", "attributes": {"friendly_name": "温度"}},
]


# ── Step 5.1: Anomaly Detection Rules ──

class TestAnomalyRules:
    """Test individual anomaly detection rules."""

    def test_lights_on_daytime_triggers(self):
        """Lights on during daytime should trigger alert."""
        with patch("anomaly_detector._get_hour", return_value=10):  # 10 AM
            alerts = _check_lights_on_daytime(SAMPLE_STATES)
        
        # light.living_room is on
        assert len(alerts) == 1
        assert alerts[0]["entity_id"] == "light.living_room"
        assert alerts[0]["severity"] == "low"

    def test_lights_on_daytime_not_daytime(self):
        """At night, no daytime light alerts."""
        with patch("anomaly_detector._get_hour", return_value=22):  # 10 PM
            alerts = _check_lights_on_daytime(SAMPLE_STATES)
        
        assert len(alerts) == 0

    def test_lights_on_daytime_all_off(self):
        """All lights off → no alerts."""
        states = [
            {"entity_id": "light.a", "state": "off", "attributes": {}},
            {"entity_id": "light.b", "state": "off", "attributes": {}},
        ]
        with patch("anomaly_detector._get_hour", return_value=10):
            alerts = _check_lights_on_daytime(states)
        assert len(alerts) == 0

    def test_door_unlocked_night_triggers(self):
        """Unlocked door at night should trigger alert."""
        with patch("anomaly_detector._get_hour", return_value=23):  # 11 PM
            alerts = _check_door_unlocked_night(SAMPLE_STATES)
        
        # lock.back_door is unlocked
        assert len(alerts) == 1
        assert alerts[0]["entity_id"] == "lock.back_door"
        assert alerts[0]["severity"] == "high"

    def test_door_unlocked_night_not_night(self):
        """During day, no night door alerts."""
        with patch("anomaly_detector._get_hour", return_value=12):
            alerts = _check_door_unlocked_night(SAMPLE_STATES)
        assert len(alerts) == 0

    def test_door_locked_at_night_no_alert(self):
        """Locked door at night → no alert."""
        states = [
            {"entity_id": "lock.front", "state": "locked", "attributes": {}},
        ]
        with patch("anomaly_detector._get_hour", return_value=3):  # 3 AM
            alerts = _check_door_unlocked_night(states)
        assert len(alerts) == 0

    def test_ac_window_open_triggers(self):
        """AC on with cover open should trigger alert."""
        alerts = _check_ac_window_open(SAMPLE_STATES)
        assert len(alerts) == 1
        assert alerts[0]["entity_id"] == "climate.living_ac"
        assert alerts[0]["severity"] == "medium"

    def test_ac_no_cover_open(self):
        """AC on with covers closed → no alert."""
        states = [
            {"entity_id": "climate.ac", "state": "cool", "attributes": {}},
            {"entity_id": "cover.curtain", "state": "closed", "attributes": {}},
        ]
        alerts = _check_ac_window_open(states)
        assert len(alerts) == 0

    def test_no_ac_no_alert(self):
        """No AC running → no alert."""
        states = [
            {"entity_id": "cover.curtain", "state": "open", "attributes": {}},
        ]
        alerts = _check_ac_window_open(states)
        assert len(alerts) == 0

    def test_device_offline_triggers(self):
        """Unavailable controllable device should trigger alert."""
        alerts = _check_device_offline(SAMPLE_STATES)
        # switch.garage is unavailable
        assert len(alerts) == 1
        assert alerts[0]["entity_id"] == "switch.garage"
        assert alerts[0]["severity"] == "medium"

    def test_device_offline_ignores_sensors(self):
        """Unavailable sensors should not trigger alert."""
        states = [
            {"entity_id": "sensor.temp", "state": "unavailable", "attributes": {}},
            {"entity_id": "number.brightness", "state": "unavailable", "attributes": {}},
        ]
        alerts = _check_device_offline(states)
        assert len(alerts) == 0

    def test_all_rules_exist(self):
        """All expected anomaly rules should be defined."""
        rule_ids = {r["id"] for r in ANOMALY_RULES}
        assert "lights_on_daytime" in rule_ids
        assert "door_unlocked_night" in rule_ids
        assert "ac_with_window_open" in rule_ids
        assert "device_offline" in rule_ids

    def test_detect_anomalies_combines_all(self):
        """detect_anomalies should combine alerts from all rules."""
        with patch("anomaly_detector._get_hour", return_value=10):  # Daytime
            alerts = detect_anomalies(SAMPLE_STATES)
        
        # Should find: lights on daytime + AC/window + device offline
        rules_found = {a["rule"] for a in alerts}
        assert "lights_on_daytime" in rules_found
        assert "ac_with_window_open" in rules_found
        assert "device_offline" in rules_found

    def test_detect_anomalies_empty_states(self):
        """Empty states → no alerts."""
        alerts = detect_anomalies([])
        assert len(alerts) == 0

    def test_detect_anomalies_handles_rule_errors(self):
        """A failing rule should not crash the detector."""
        bad_states = "not a list"  # Will cause type errors in rules
        alerts = detect_anomalies(bad_states)
        # Should not crash, just return empty (rules catch their own errors)
        # Some rules might return empty, some might raise — but detect_anomalies catches
        assert isinstance(alerts, list)


# ── Step 5.2: Anomaly Detector Script ──

class TestAnomalyDetectorScript:
    """Test the anomaly detector cronjob script."""

    def test_format_alerts_empty(self):
        """Empty alerts → empty string."""
        assert format_alerts_for_wechat([]) == ""

    def test_format_alerts_with_data(self):
        """Should format alerts with emoji and message."""
        alerts = [
            {"message": "夜间门锁未锁: 后门锁", "severity": "high"},
            {"message": "白天灯开着: 客厅灯", "severity": "low"},
        ]
        result = format_alerts_for_wechat(alerts)
        assert "家居异常告警" in result
        assert "后门锁" in result
        assert "客厅灯" in result
        assert "🔴" in result  # high severity emoji
        assert "🟢" in result  # low severity emoji

    def test_format_alerts_medium_severity(self):
        """Medium severity should have yellow emoji."""
        alerts = [{"message": "设备离线", "severity": "medium"}]
        result = format_alerts_for_wechat(alerts)
        assert "🟡" in result

    def test_anomaly_detector_module_importable(self):
        """Module should import without errors."""
        import anomaly_detector
        assert hasattr(anomaly_detector, "detect_anomalies")
        assert hasattr(anomaly_detector, "format_alerts_for_wechat")
        assert hasattr(anomaly_detector, "main")


# ── Step 5.3: Preference Analyzer Script ──

class TestPreferenceAnalyzerScript:
    """Test the preference analyzer cronjob script."""

    def test_preference_analyzer_importable(self):
        """Module should import without errors."""
        import preference_analyzer
        assert hasattr(preference_analyzer, "main")

    def test_preference_analyzer_runs(self, tmp_path):
        """Script should run without errors with test data."""
        import preference_analyzer
        
        # Mock PreferenceManager
        mock_pref = MagicMock()
        mock_pref.analyze_patterns.return_value = {
            "total_commands": 10,
            "top_devices": [{"entity_id": "light.test", "count": 5}],
            "time_patterns": [{"hour": 22, "count": 3}],
            "room_patterns": [],
            "suggestions": [{
                "description": "每天22点关 light.test",
                "confidence": 0.8,
                "frequency": 5,
            }],
        }
        mock_pref.save_to_obsidian.return_value = str(tmp_path / "prefs.md")
        mock_pref.get_context_for_llm.return_value = "常用设备: light.test(5次)"
        
        with patch.object(preference_analyzer, "PreferenceManager", return_value=mock_pref):
            # Should not raise
            preference_analyzer.main()
        
        # Verify methods called
        mock_pref.analyze_patterns.assert_called_once()
        mock_pref.save_to_obsidian.assert_called_once()
        mock_pref.get_context_for_llm.assert_called_once()


# ── Step 5.4: Integration ──

class TestPhase5Integration:
    """End-to-end: detect anomaly → format → push message."""

    def test_full_chain_anomaly_to_wechat(self):
        """Full chain: states → detect → format → WeChat-ready message."""
        states = [
            {"entity_id": "lock.front_door", "state": "unlocked", "attributes": {"friendly_name": "前门锁"}},
            {"entity_id": "light.living", "state": "on", "attributes": {"friendly_name": "客厅灯"}},
            {"entity_id": "switch.garage", "state": "unavailable", "attributes": {"friendly_name": "车库"}},
            {"entity_id": "climate.ac", "state": "cool", "attributes": {"friendly_name": "空调"}},
            {"entity_id": "cover.window", "state": "open", "attributes": {"friendly_name": "窗户"}},
        ]
        
        with patch("anomaly_detector._get_hour", return_value=23):  # Night
            # Step 1: Detect
            alerts = detect_anomalies(states)
            assert len(alerts) > 0
            
            # Step 2: Format
            message = format_alerts_for_wechat(alerts)
            assert "家居异常告警" in message
            assert "前门锁" in message  # Door unlocked at night
            
            # Step 3: Verify message is WeChat-ready (plain text, reasonable length)
            assert len(message) < 1000  # Not too long for WeChat
            assert "\n" in message  # Multi-line format

    def test_no_anomaly_no_message(self):
        """When everything is normal, no message should be generated."""
        states = [
            {"entity_id": "lock.front", "state": "locked", "attributes": {}},
            {"entity_id": "light.living", "state": "off", "attributes": {}},
            {"entity_id": "switch.garage", "state": "on", "attributes": {}},
        ]
        
        with patch("anomaly_detector._get_hour", return_value=12):  # Daytime, no lights on
            alerts = detect_anomalies(states)
            message = format_alerts_for_wechat(alerts)
            assert message == ""

    def test_all_phase5_scripts_exist(self):
        """All Phase 5 scripts should exist."""
        base = os.path.join(os.path.dirname(__file__), "..", "scripts")
        assert os.path.isfile(os.path.join(base, "anomaly_detector.py"))
        assert os.path.isfile(os.path.join(base, "preference_analyzer.py"))

    def test_cronjob_scripts_are_executable(self):
        """Scripts should have a main() function for cronjob execution."""
        import anomaly_detector
        import preference_analyzer
        assert callable(anomaly_detector.main)
        assert callable(preference_analyzer.main)
