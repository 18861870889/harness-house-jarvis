from __future__ import annotations

"""
HA WebSocket + REST API client.
Maintains a WebSocket connection to Home Assistant for real-time state updates,
and provides REST API calls for service execution.
"""

import asyncio
import json
import os
import threading
import time
from typing import Any, Optional

import requests

# Load config from environment
HA_BASE_URL = os.environ.get("HA_BASE_URL", "http://homeassistant.local:8123")
HA_TOKEN = os.environ.get("HA_TOKEN", "")
HA_WS_URL = HA_BASE_URL.replace("http://", "ws://").replace("https://", "wss://") + "/api/websocket"


class HAClient:
    """Home Assistant client with WebSocket state cache and REST execution."""

    # Connection states for observability
    WS_DISCONNECTED = "disconnected"
    WS_CONNECTING = "connecting"
    WS_CONNECTED = "connected"
    WS_AUTH_FAILED = "auth_failed"
    WS_RECONNECTING = "reconnecting"

    def __init__(self, base_url: str = HA_BASE_URL, token: str = HA_TOKEN):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.ws_url = base_url.replace("http://", "ws://").replace("https://", "wss://") + "/api/websocket"
        self._state_cache: dict[str, dict] = {}
        self._ws_thread: threading.Thread | None = None
        self._ws_running = False
        self._ws_state = self.WS_DISCONNECTED
        self._reconnect_count = 0
        self._lock = threading.Lock()

    @property
    def ws_state(self) -> str:
        """Current WebSocket connection state."""
        return self._ws_state

    # ── REST API ──

    def get_states(self) -> list[dict]:
        """Fetch all entity states from HA REST API."""
        resp = requests.get(
            f"{self.base_url}/api/states",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()

    def get_state(self, entity_id: str) -> dict | None:
        """Fetch a single entity state from HA REST API."""
        resp = requests.get(
            f"{self.base_url}/api/states/{entity_id}",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            timeout=10,
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    def call_service(self, domain: str, service: str, data: dict) -> dict:
        """Call a HA service (e.g., switch.turn_on)."""
        resp = requests.post(
            f"{self.base_url}/api/services/{domain}/{service}",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            json=data,
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json() if resp.text else {}

    def get_entity_registry(self) -> list[dict]:
        """Fetch entity registry (device metadata, areas, names)."""
        resp = requests.get(
            f"{self.base_url}/api/config/entity_registry",
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            timeout=10,
        )
        if resp.status_code == 404:
            return []
        resp.raise_for_status()
        return resp.json()

    # ── WebSocket State Cache ──

    def init_state_cache(self) -> None:
        """Initialize the state cache with a full REST fetch."""
        states = self.get_states()
        with self._lock:
            self._state_cache = {s["entity_id"]: s for s in states}

    def get_cached_state(self, entity_id: str) -> dict | None:
        """Get a device state from the in-memory cache (instant)."""
        with self._lock:
            return self._state_cache.get(entity_id)

    def get_all_cached_states(self) -> dict[str, dict]:
        """Get all cached states (shallow copy of outer dict, inner dicts are copies)."""
        with self._lock:
            return {k: dict(v) if isinstance(v, dict) else v for k, v in self._state_cache.items()}

    def _update_cache(self, entity_id: str, state: dict) -> None:
        """Update a single entity in the cache (called from WebSocket listener)."""
        with self._lock:
            self._state_cache[entity_id] = state

    def start_ws_listener(self) -> None:
        """Start the WebSocket listener in a background thread."""
        self._ws_running = True
        self._ws_thread = threading.Thread(target=self._ws_loop, daemon=True)
        self._ws_thread.start()

    def stop_ws_listener(self) -> None:
        """Stop the WebSocket listener."""
        self._ws_running = False
        if self._ws_thread:
            self._ws_thread.join(timeout=5)

    def _ws_loop(self) -> None:
        """WebSocket event loop (runs in background thread) with reconnection."""
        while self._ws_running:
            try:
                self._ws_state = self.WS_CONNECTING
                asyncio.run(self._ws_connect())
                # Normal exit — loop ended (stop_ws_listener called)
                self._ws_state = self.WS_DISCONNECTED
            except AuthError:
                self._ws_state = self.WS_AUTH_FAILED
                print("[HA WS] Auth failed — check HA_TOKEN. Not retrying.")
                self._ws_running = False
                break
            except Exception as e:
                self._ws_state = self.WS_RECONNECTING
                self._reconnect_count += 1
                delay = min(5 * (2 ** (self._reconnect_count - 1)), 60)
                print(f"[HA WS] Connection error: {e}, reconnecting in {delay}s... (attempt {self._reconnect_count})")
                time.sleep(delay)

    async def _ws_connect(self) -> None:
        """Connect to HA WebSocket, authenticate, and subscribe to state_changed events."""
        import aiohttp  # Lazy import — only needed for WebSocket

        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(self.ws_url) as ws:
                # Wait for auth required message
                msg = await ws.receive(timeout=10)
                data = json.loads(msg.data)
                if data.get("type") != "auth_required":
                    raise RuntimeError(f"Expected auth_required, got {data.get('type')}")

                # Send auth
                await ws.send_json({"type": "auth", "access_token": self.token})

                # Wait for auth ok
                msg = await ws.receive(timeout=10)
                data = json.loads(msg.data)
                if data.get("type") == "auth_invalid":
                    raise AuthError(f"HA rejected token: {data.get('message', 'unknown')}")
                if data.get("type") != "auth_ok":
                    raise RuntimeError(f"Unexpected auth response: {data.get('type')}")

                self._ws_state = self.WS_CONNECTED
                self._reconnect_count = 0  # Reset on successful connect
                print("[HA WS] Connected and authenticated")

                # Subscribe to state_changed events
                await ws.send_json({
                    "type": "subscribe_events",
                    "event_type": "state_changed",
                    "id": 1,
                })

                # Listen for messages
                while self._ws_running:
                    msg = await ws.receive(timeout=30)
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        data = json.loads(msg.data)
                        self._process_ws_message(data)
                    elif msg.type == aiohttp.WSMsgType.CLOSED:
                        break
                    elif msg.type == aiohttp.WSMsgType.ERROR:
                        break

    def _process_ws_message(self, data: dict) -> None:
        """Process a single WebSocket message — update cache if it's a state_changed event.

        Extracted as a separate method for unit testing (no live WebSocket needed).
        Safely handles malformed messages (missing keys, None values).
        """
        if not isinstance(data, dict):
            return
        if data.get("type") != "event":
            return
        event = data.get("event", {})
        if not isinstance(event, dict) or event.get("event_type") != "state_changed":
            return
        event_data = event.get("data", {})
        if not isinstance(event_data, dict):
            return
        entity_id = event_data.get("entity_id")
        new_state = event_data.get("new_state")
        if entity_id and new_state:
            self._update_cache(entity_id, new_state)


class AuthError(RuntimeError):
    """Raised when HA WebSocket auth fails — should not retry."""
    pass
