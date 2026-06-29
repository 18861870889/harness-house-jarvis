"""
Step 1.5 Tests: get_device_state — query single device state from cache.

Tests cover: cache hit, cache miss (entity not found), cache freshness,
attributes display, and error handling.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from unittest.mock import MagicMock, patch

import pytest

# Add scripts dir to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from ha_client import HAClient
import control as ctrl


# ── Fixtures ──

@pytest.fixture
def mock_client():
    client = HAClient(base_url="http://localhost:8123", token="fake")
    return client


def make_state_args(entity_id):
    args = MagicMock()
    args.entity_id = entity_id
    return args


def capture_output():
    import io
    from contextlib import redirect_stdout
    buf = io.StringIO()
    return buf, redirect_stdout(buf)


SAMPLE_STATE = {
    "entity_id": "climate.bedroom_ac",
    "state": "cool",
    "attributes": {
        "friendly_name": "卧室空调",
        "temperature": 25,
        "current_temperature": 23.5,
        "fan_mode": "auto",
        "hvac_modes": ["off", "cool", "heat", "auto"],
    },
}


# ── State Query Tests ──

class TestStateQuery:
    """Test querying a single device state from cache."""

    def test_state_returns_entity_id_and_state(self, mock_client):
        """state command should return entity_id and state."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_cached_state = MagicMock(return_value=SAMPLE_STATE)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_state(make_state_args("climate.bedroom_ac"))

        result = json.loads(buf.getvalue())
        assert result["entity_id"] == "climate.bedroom_ac"
        assert result["state"] == "cool"

    def test_state_returns_attributes(self, mock_client):
        """state command should return full attributes."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_cached_state = MagicMock(return_value=SAMPLE_STATE)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_state(make_state_args("climate.bedroom_ac"))

        result = json.loads(buf.getvalue())
        assert result["attributes"]["temperature"] == 25
        assert result["attributes"]["fan_mode"] == "auto"

    def test_state_not_found(self, mock_client):
        """Querying a non-existent entity should print error and exit."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_cached_state = MagicMock(return_value=None)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            with pytest.raises(SystemExit) as exc_info:
                ctrl.cmd_state(make_state_args("light.nonexistent"))

        assert exc_info.value.code == 1
        result = json.loads(buf.getvalue())
        assert "error" in result
        assert "light.nonexistent" in result["error"]

    def test_state_uses_cache_not_rest(self, mock_client):
        """state command should use cached state, not call REST get_state."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_cached_state = MagicMock(return_value=SAMPLE_STATE)
        mock_client.get_state = MagicMock()  # REST method — should not be called

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_state(make_state_args("climate.bedroom_ac"))

        mock_client.get_state.assert_not_called()
        mock_client.get_cached_state.assert_called_once_with("climate.bedroom_ac")

    def test_state_init_cache_called(self, mock_client):
        """state command should call init_state_cache before reading."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_cached_state = MagicMock(return_value=SAMPLE_STATE)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_state(make_state_args("climate.bedroom_ac"))

        mock_client.init_state_cache.assert_called_once()


# ── All States Query Tests ──

class TestAllStatesQuery:
    """Test the 'states' command (all cached states)."""

    def test_states_returns_all(self, mock_client):
        """states command should return all cached entity states."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_all_cached_states = MagicMock(return_value={
            "light.a": {"state": "on"},
            "switch.b": {"state": "off"},
            "climate.c": {"state": "cool"},
        })

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_states(MagicMock())

        result = json.loads(buf.getvalue())
        assert result["count"] == 3
        assert result["states"]["light.a"] == "on"
        assert result["states"]["switch.b"] == "off"

    def test_states_empty_cache(self, mock_client):
        """states with empty cache should return count=0."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_all_cached_states = MagicMock(return_value={})

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_states(MagicMock())

        result = json.loads(buf.getvalue())
        assert result["count"] == 0
        assert result["states"] == {}


# ── Edge Cases ──

class TestEdgeCases:
    """Test edge cases for state query."""

    def test_state_with_empty_attributes(self, mock_client):
        """Entity with no attributes should not crash."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_cached_state = MagicMock(return_value={
            "entity_id": "switch.test",
            "state": "on",
            "attributes": {},
        })

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_state(make_state_args("switch.test"))

        result = json.loads(buf.getvalue())
        assert result["attributes"] == {}

    def test_state_with_missing_attributes_key(self, mock_client):
        """Entity without attributes key should use empty dict."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_cached_state = MagicMock(return_value={
            "entity_id": "switch.test",
            "state": "on",
        })

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_state(make_state_args("switch.test"))

        result = json.loads(buf.getvalue())
        assert result["attributes"] == {}

    def test_state_complex_attributes(self, mock_client):
        """Complex attributes (lists, nested dicts) should be returned."""
        mock_client.init_state_cache = MagicMock()
        mock_client.get_cached_state = MagicMock(return_value={
            "entity_id": "climate.test",
            "state": "auto",
            "attributes": {
                "hvac_modes": ["off", "cool", "heat", "auto"],
                "preset_mode": "away",
                "target_temp": 24.5,
            },
        })

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), ctx:
            ctrl.cmd_state(make_state_args("climate.test"))

        result = json.loads(buf.getvalue())
        assert result["attributes"]["hvac_modes"] == ["off", "cool", "heat", "auto"]
        assert result["attributes"]["target_temp"] == 24.5
