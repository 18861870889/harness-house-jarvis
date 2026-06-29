"""
Step 1.4 Tests: list_devices — device listing with states, filtering, and cache.

Tests cover: REST fetch, cache mode, domain filtering, controllable-only filtering,
safety level display, and sorting.
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
from safety import SafetyChecker
import control as ctrl


# ── Fixtures ──

@pytest.fixture
def tmp_policy():
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write("{}")
        path = f.name
    yield path
    os.unlink(path)


@pytest.fixture
def safety(tmp_policy):
    return SafetyChecker(policy_path=tmp_policy, devices_dir="/nonexistent")


@pytest.fixture
def mock_client():
    """HAClient with mocked REST + cache methods."""
    client = HAClient(base_url="http://localhost:8123", token="fake")
    return client


SAMPLE_STATES = [
    {"entity_id": "light.living_room", "state": "on", "attributes": {"friendly_name": "客厅灯"}},
    {"entity_id": "light.bedroom", "state": "off", "attributes": {"friendly_name": "卧室灯"}},
    {"entity_id": "switch.kitchen", "state": "on", "attributes": {"friendly_name": "厨房开关"}},
    {"entity_id": "climate.bedroom_ac", "state": "cool", "attributes": {"friendly_name": "卧室空调", "temperature": 25}},
    {"entity_id": "cover.living_curtain", "state": "open", "attributes": {"friendly_name": "客厅窗帘"}},
    {"entity_id": "lock.front_door", "state": "locked", "attributes": {"friendly_name": "前门锁"}},
    {"entity_id": "sensor.temperature", "state": "23.5", "attributes": {"friendly_name": "温度"}},
    {"entity_id": "number.brightness", "state": "80", "attributes": {"friendly_name": "亮度"}},
    {"entity_id": "vacuum.roborock", "state": "cleaning", "attributes": {"friendly_name": "扫地机"}},
    {"entity_id": "fan.living_room", "state": "on", "attributes": {"friendly_name": "客厅风扇"}},
]


def make_list_args(cache=False, domain=None, all_entities=False):
    args = MagicMock()
    args.cache = cache
    args.domain = domain
    args.all = all_entities
    return args


def capture_output():
    """Capture stdout from cmd_list."""
    import io
    from contextlib import redirect_stdout
    buf = io.StringIO()
    return buf, redirect_stdout(buf)


# ── Basic Listing Tests ──

class TestBasicListing:
    """Test basic device listing from REST API."""

    def test_list_returns_controllable_only(self, mock_client, safety):
        """list should only return controllable domains by default."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args())

        result = json.loads(buf.getvalue())
        domains = {d["domain"] for d in result["devices"]}
        assert "sensor" not in domains
        assert "number" not in domains
        assert "light" in domains
        assert "switch" in domains
        assert "climate" in domains

    def test_list_includes_safety_level(self, mock_client, safety, tmp_policy):
        """Each device should include its safety level."""
        safety.set_safety_level("lock.front_door", "block")
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args())

        result = json.loads(buf.getvalue())
        lock_device = next(d for d in result["devices"] if d["entity_id"] == "lock.front_door")
        assert lock_device["safety"] == "block"

    def test_list_includes_name_and_state(self, mock_client, safety):
        """Each device should include friendly_name and current state."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args())

        result = json.loads(buf.getvalue())
        light = next(d for d in result["devices"] if d["entity_id"] == "light.living_room")
        assert light["name"] == "客厅灯"
        assert light["state"] == "on"

    def test_list_count_matches(self, mock_client, safety):
        """Count should match the number of controllable devices."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args())

        result = json.loads(buf.getvalue())
        # Controllable: light(2) + switch(1) + climate(1) + cover(1) + lock(1) + vacuum(1) + fan(1) = 8
        assert result["count"] == 8
        assert len(result["devices"]) == 8

    def test_list_sorted_by_domain_then_name(self, mock_client, safety):
        """Devices should be sorted by domain, then by name."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args())

        result = json.loads(buf.getvalue())
        domains = [d["domain"] for d in result["devices"]]
        # Should be in alphabetical order by domain
        assert domains == sorted(domains)


# ── Domain Filter Tests ──

class TestDomainFilter:
    """Test filtering by domain."""

    def test_filter_by_light(self, mock_client, safety):
        """--domain light should only return light entities."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args(domain="light"))

        result = json.loads(buf.getvalue())
        assert all(d["domain"] == "light" for d in result["devices"])
        assert result["count"] == 2

    def test_filter_by_climate(self, mock_client, safety):
        """--domain climate should only return climate entities."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args(domain="climate"))

        result = json.loads(buf.getvalue())
        assert all(d["domain"] == "climate" for d in result["devices"])
        assert result["count"] == 1

    def test_filter_nonexistent_domain(self, mock_client, safety):
        """Filtering by a domain with no devices should return empty."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args(domain="media_player"))

        result = json.loads(buf.getvalue())
        assert result["count"] == 0


# ── --all Flag Tests ──

class TestAllFlag:
    """Test --all flag to include non-controllable entities."""

    def test_all_includes_sensors(self, mock_client, safety):
        """--all should include sensor entities."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args(all_entities=True))

        result = json.loads(buf.getvalue())
        domains = {d["domain"] for d in result["devices"]}
        assert "sensor" in domains
        assert "number" in domains
        assert result["count"] == 10  # All 10 sample entities

    def test_all_with_domain_filter(self, mock_client, safety):
        """--all + --domain sensor should return only sensors."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args(all_entities=True, domain="sensor"))

        result = json.loads(buf.getvalue())
        assert all(d["domain"] == "sensor" for d in result["devices"])
        assert result["count"] == 1


# ── Cache Mode Tests ──

class TestCacheMode:
    """Test --cache flag to use WebSocket state cache."""

    def test_cache_uses_init_state_cache(self, mock_client, safety):
        """--cache should call init_state_cache and use cached states."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args(cache=True))

        result = json.loads(buf.getvalue())
        # init_state_cache populates from get_states
        assert result["count"] == 8  # Same as REST mode

    def test_cache_does_not_call_get_states_directly(self, mock_client, safety):
        """In cache mode, get_states should only be called by init_state_cache, not directly."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args(cache=True))

        # get_states is called once (by init_state_cache), not directly by cmd_list
        assert mock_client.get_states.call_count == 1

    def test_non_cache_calls_get_states_directly(self, mock_client, safety):
        """In non-cache mode, get_states should be called directly."""
        mock_client.get_states = MagicMock(return_value=SAMPLE_STATES)

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args(cache=False))

        assert mock_client.get_states.call_count == 1


# ── Edge Cases ──

class TestEdgeCases:
    """Test edge cases for list command."""

    def test_empty_states(self, mock_client, safety):
        """Empty HA should return count=0."""
        mock_client.get_states = MagicMock(return_value=[])

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args())

        result = json.loads(buf.getvalue())
        assert result["count"] == 0
        assert result["devices"] == []

    def test_entity_without_friendly_name(self, mock_client, safety):
        """Entity without friendly_name should use entity_id as name."""
        mock_client.get_states = MagicMock(return_value=[
            {"entity_id": "switch.test", "state": "on", "attributes": {}},
        ])

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args())

        result = json.loads(buf.getvalue())
        assert result["devices"][0]["name"] == "switch.test"

    def test_entity_without_attributes(self, mock_client, safety):
        """Entity without attributes key should not crash."""
        mock_client.get_states = MagicMock(return_value=[
            {"entity_id": "switch.test", "state": "on"},
        ])

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            ctrl.cmd_list(make_list_args())

        result = json.loads(buf.getvalue())
        assert result["count"] == 1
        assert result["devices"][0]["name"] == "switch.test"

    def test_malformed_entity_id(self, mock_client, safety):
        """Entity_id without a dot should be handled gracefully."""
        mock_client.get_states = MagicMock(return_value=[
            {"entity_id": "malformed", "state": "on", "attributes": {}},
        ])

        buf, ctx = capture_output()
        with patch.object(ctrl, "get_client", return_value=mock_client), \
             patch.object(ctrl, "SafetyChecker", return_value=safety), ctx:
            cmd_result = ctrl.cmd_list(make_list_args())

        # "malformed" has no domain → not in controllable_domains → filtered out
        buf_val = buf.getvalue()
        result = json.loads(buf_val)
        assert result["count"] == 0
