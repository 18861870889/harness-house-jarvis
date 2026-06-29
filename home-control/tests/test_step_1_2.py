"""
Step 1.2 Tests: HA WebSocket client — connection, auth, reconnection, state cache updates.

All tests are unit-testable (no live HA needed). Mock the WebSocket protocol layer.
"""
from __future__ import annotations

import json
import sys
import os
import time
import threading
from unittest.mock import MagicMock, patch, AsyncMock

import pytest

# Add scripts dir to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from ha_client import HAClient, AuthError


# ── Helpers ──

def make_state_changed_msg(entity_id: str, new_state: str, extra_attrs: dict | None = None) -> dict:
    """Build a HA WebSocket state_changed event message."""
    state = {
        "entity_id": entity_id,
        "state": new_state,
        "attributes": extra_attrs or {},
    }
    return {
        "type": "event",
        "event": {
            "event_type": "state_changed",
            "data": {
                "entity_id": entity_id,
                "new_state": state,
                "old_state": None,
            },
        },
    }


def make_non_state_msg() -> dict:
    """A non-state_changed event (e.g., call_service event)."""
    return {
        "type": "event",
        "event": {
            "event_type": "call_service",
            "data": {"domain": "light", "service": "turn_on"},
        },
    }


# ── State Cache Update Tests ──

class TestStateCacheUpdate:
    """Test that WebSocket messages correctly update the in-memory cache."""

    def test_single_state_update(self):
        """A state_changed event updates the cache for that entity."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        msg = make_state_changed_msg("light.living_room", "on", {"brightness": 200})
        client._process_ws_message(msg)

        cached = client.get_cached_state("light.living_room")
        assert cached is not None
        assert cached["state"] == "on"
        assert cached["attributes"]["brightness"] == 200

    def test_multiple_state_updates(self):
        """Multiple state_changed events update different entities."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._process_ws_message(make_state_changed_msg("light.living_room", "on"))
        client._process_ws_message(make_state_changed_msg("switch.kitchen", "on"))
        client._process_ws_message(make_state_changed_msg("climate.bedroom", "cool", {"temperature": 24}))

        assert client.get_cached_state("light.living_room")["state"] == "on"
        assert client.get_cached_state("switch.kitchen")["state"] == "on"
        assert client.get_cached_state("climate.bedroom")["state"] == "cool"
        assert len(client.get_all_cached_states()) == 3

    def test_overwrite_existing_state(self):
        """A new state_changed event overwrites the old cached state."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._process_ws_message(make_state_changed_msg("light.living_room", "on"))
        assert client.get_cached_state("light.living_room")["state"] == "on"

        client._process_ws_message(make_state_changed_msg("light.living_room", "off"))
        assert client.get_cached_state("light.living_room")["state"] == "off"

    def test_non_state_changed_ignored(self):
        """Non-state_changed events do not modify the cache."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._process_ws_message(make_non_state_msg())
        assert len(client.get_all_cached_states()) == 0

    def test_null_new_state_ignored(self):
        """If new_state is null (entity removed), don't cache it."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        msg = {
            "type": "event",
            "event": {
                "event_type": "state_changed",
                "data": {
                    "entity_id": "light.removed",
                    "new_state": None,
                    "old_state": {"state": "on"},
                },
            },
        }
        client._process_ws_message(msg)
        assert client.get_cached_state("light.removed") is None

    def test_missing_entity_id_ignored(self):
        """Message without entity_id is safely ignored."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        msg = {
            "type": "event",
            "event": {
                "event_type": "state_changed",
                "data": {"entity_id": None, "new_state": {"state": "on"}},
            },
        }
        client._process_ws_message(msg)
        assert len(client.get_all_cached_states()) == 0

    def test_init_state_cache_from_rest(self):
        """init_state_cache populates from REST get_states."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client.get_states = MagicMock(return_value=[
            {"entity_id": "light.a", "state": "on"},
            {"entity_id": "switch.b", "state": "off"},
        ])
        client.init_state_cache()
        assert client.get_cached_state("light.a")["state"] == "on"
        assert client.get_cached_state("switch.b")["state"] == "off"
        assert len(client.get_all_cached_states()) == 2

    def test_ws_update_overwrites_rest_cache(self):
        """After REST init, a WS event should update the specific entity."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        # REST says light.a is on
        client.get_states = MagicMock(return_value=[
            {"entity_id": "light.a", "state": "on"},
        ])
        client.init_state_cache()
        assert client.get_cached_state("light.a")["state"] == "on"

        # WS event says light.a is now off
        client._process_ws_message(make_state_changed_msg("light.a", "off"))
        assert client.get_cached_state("light.a")["state"] == "off"


# ── Connection State Tracking ──

class TestConnectionState:
    """Test that ws_state property reflects connection lifecycle."""

    def test_initial_state_disconnected(self):
        """New client starts in disconnected state."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        assert client.ws_state == HAClient.WS_DISCONNECTED

    def test_state_constants_exist(self):
        """All connection state constants are defined."""
        assert HAClient.WS_DISCONNECTED == "disconnected"
        assert HAClient.WS_CONNECTING == "connecting"
        assert HAClient.WS_CONNECTED == "connected"
        assert HAClient.WS_AUTH_FAILED == "auth_failed"
        assert HAClient.WS_RECONNECTING == "reconnecting"


# ── Auth Error Handling ──

class TestAuthError:
    """Test that auth failures raise AuthError (non-retryable)."""

    def test_auth_invalid_raises_auth_error(self):
        """An auth_invalid response should raise AuthError, not RuntimeError."""
        client = HAClient(base_url="http://localhost:8123", token="bad_token")

        # Build a fake async context manager chain for aiohttp
        mock_ws = AsyncMock()
        mock_msg_required = MagicMock()
        mock_msg_required.data = json.dumps({"type": "auth_required"})
        mock_msg_invalid = MagicMock()
        mock_msg_invalid.data = json.dumps({
            "type": "auth_invalid",
            "message": "Invalid session token",
        })
        mock_ws.receive = AsyncMock(side_effect=[mock_msg_required, mock_msg_invalid])

        class FakeWSContext:
            async def __aenter__(self):
                return mock_ws
            async def __aexit__(self, *args):
                return False

        class FakeSessionContext:
            async def __aenter__(self):
                mock_inner = MagicMock()
                mock_inner.ws_connect = MagicMock(return_value=FakeWSContext())
                return mock_inner
            async def __aexit__(self, *args):
                return False

        with patch("aiohttp.ClientSession", return_value=FakeSessionContext()):
            with pytest.raises(AuthError, match="Invalid session token"):
                import asyncio
                asyncio.run(client._ws_connect())

    def test_auth_error_is_runtime_error_subclass(self):
        """AuthError should be a RuntimeError subclass (for backward compat)."""
        assert issubclass(AuthError, RuntimeError)

    def test_auth_error_not_retryable(self):
        """AuthError in _ws_loop should stop the loop, not retry."""
        client = HAClient(base_url="http://localhost:8123", token="bad_token")
        client._ws_running = True

        call_count = [0]
        original_connect = client._ws_connect

        async def fail_with_auth_error():
            call_count[0] += 1
            raise AuthError("bad token")

        client._ws_connect = fail_with_auth_error

        # Mock time.sleep to avoid actual delays
        with patch("time.sleep"):
            client._ws_loop()

        # Should have been called exactly once (no retry)
        assert call_count[0] == 1
        assert client.ws_state == HAClient.WS_AUTH_FAILED
        assert client._ws_running is False  # Loop stopped


# ── Reconnection Logic ──

class TestReconnection:
    """Test reconnection with exponential backoff."""

    def test_reconnect_on_connection_error(self):
        """A generic connection error should trigger retry, not stop."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._ws_running = True

        call_count = [0]

        async def fail_then_succeed():
            call_count[0] += 1
            if call_count[0] == 1:
                raise ConnectionError("Network unreachable")
            # Second call: stop the loop
            client._ws_running = False

        client._ws_connect = fail_then_succeed

        sleep_calls = []
        with patch("time.sleep", side_effect=lambda s: sleep_calls.append(s)):
            client._ws_loop()

        assert call_count[0] == 2  # First failed, second succeeded
        assert len(sleep_calls) == 1  # One sleep between attempts
        assert client._reconnect_count == 1

    def test_exponential_backoff(self):
        """Reconnect delay should increase exponentially (5s → 10s → 20s...)."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._ws_running = True

        async def always_fail():
            raise ConnectionError("fail")

        client._ws_connect = always_fail

        sleep_calls = []

        def mock_sleep(s):
            sleep_calls.append(s)
            # Stop after 6 retries to verify the pattern + cap
            if len(sleep_calls) >= 6:
                client._ws_running = False

        with patch("time.sleep", side_effect=mock_sleep):
            client._ws_loop()

        # Exponential backoff: 5, 10, 20, 40, 60(capped), 60(capped)
        assert len(sleep_calls) == 6
        assert sleep_calls[0] == 5   # 5 * 2^0
        assert sleep_calls[1] == 10  # 5 * 2^1
        assert sleep_calls[2] == 20  # 5 * 2^2
        assert sleep_calls[3] == 40  # 5 * 2^3
        assert sleep_calls[4] == 60  # 5 * 2^4 = 80, capped at 60
        assert sleep_calls[5] == 60  # still capped

    def test_reconnect_count_resets_on_success(self):
        """_reconnect_count should reset to 0 after a successful connection."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._ws_running = True

        call_count = [0]

        async def fail_then_succeed():
            call_count[0] += 1
            if call_count[0] == 1:
                raise ConnectionError("fail")
            # Second call: simulate successful connect then stop
            client._ws_state = client.WS_CONNECTED
            client._reconnect_count = 0
            client._ws_running = False

        client._ws_connect = fail_then_succeed

        with patch("time.sleep"):
            client._ws_loop()

        assert client._reconnect_count == 0

    def test_reconnect_max_delay_60s(self):
        """Reconnect delay should be capped at 60 seconds."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._ws_running = True

        async def always_fail():
            raise ConnectionError("fail")

        client._ws_connect = always_fail

        # Stop after 10 retries
        original_sleep = time.sleep
        sleep_calls = []

        def mock_sleep(s):
            sleep_calls.append(s)
            if len(sleep_calls) >= 10:
                client._ws_running = False

        with patch("time.sleep", side_effect=mock_sleep):
            client._ws_loop()

        # All delays after the 5th should be capped at 60
        for delay in sleep_calls[4:]:
            assert delay <= 60


# ── Thread Safety ──

class TestThreadSafety:
    """Test that state cache is thread-safe (concurrent reads + writes)."""

    def test_concurrent_read_write(self):
        """Multiple threads writing and reading the cache should not corrupt it."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client.init_state_cache = MagicMock()  # Don't call real REST
        errors = []

        def writer():
            try:
                for i in range(100):
                    client._process_ws_message(
                        make_state_changed_msg(f"light.entity_{i}", "on")
                    )
            except Exception as e:
                errors.append(e)

        def reader():
            try:
                for i in range(100):
                    client.get_all_cached_states()
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer) for _ in range(3)]
        threads += [threading.Thread(target=reader) for _ in range(3)]

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0
        # 3 writers × 100 entities each, but all writing to the same entity_ids
        # entity_0 through entity_99 (overwriting). So 100 entities total.
        assert len(client.get_all_cached_states()) == 100

    def test_get_cached_state_returns_copy(self):
        """get_all_cached_states should return a copy, not the internal dict."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._process_ws_message(make_state_changed_msg("light.a", "on"))

        states1 = client.get_all_cached_states()
        states1["light.a"]["state"] = "HACKED"

        # Internal cache should not be affected
        states2 = client.get_all_cached_states()
        assert states2["light.a"]["state"] == "on"


# ── Edge Cases ──

class TestEdgeCases:
    """Test edge cases and malformed messages."""

    def test_malformed_json_ignored(self):
        """A message without the expected structure should not crash."""
        client = HAClient(base_url="http://localhost:8123", token="fake")

        # Missing 'event' key
        client._process_ws_message({"type": "event"})
        # Missing 'data' key
        client._process_ws_message({"type": "event", "event": {"event_type": "state_changed"}})
        # Empty message
        client._process_ws_message({})

        assert len(client.get_all_cached_states()) == 0

    def test_auth_required_message_validation(self):
        """If first message isn't auth_required, should raise RuntimeError."""
        client = HAClient(base_url="http://localhost:8123", token="fake")

        mock_ws = AsyncMock()
        mock_msg = MagicMock()
        mock_msg.data = json.dumps({"type": "some_other_type"})
        mock_ws.receive = AsyncMock(return_value=mock_msg)

        class FakeWSContext:
            async def __aenter__(self):
                return mock_ws
            async def __aexit__(self, *args):
                return False

        class FakeSessionContext:
            async def __aenter__(self):
                mock_inner = MagicMock()
                mock_inner.ws_connect = MagicMock(return_value=FakeWSContext())
                return mock_inner
            async def __aexit__(self, *args):
                return False

        with patch("aiohttp.ClientSession", return_value=FakeSessionContext()):
            with pytest.raises(RuntimeError, match="Expected auth_required"):
                import asyncio
                asyncio.run(client._ws_connect())

    def test_stop_ws_listener_sets_running_false(self):
        """stop_ws_listener should set _ws_running to False."""
        client = HAClient(base_url="http://localhost:8123", token="fake")
        client._ws_running = True
        client._ws_thread = MagicMock()
        client.stop_ws_listener()
        assert client._ws_running is False
        client._ws_thread.join.assert_called_once_with(timeout=5)
