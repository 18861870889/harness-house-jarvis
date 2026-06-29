#!/usr/bin/env python3
"""
HA Proxy Server — lightweight HTTP proxy that hides the HA token from browsers.

Provides:
  1. REST proxy: /api/ha/* → forwards to HA REST API (injects token)
  2. SSE bridge: /api/sse → HA WebSocket state_changed events → SSE push
  3. Safety check: /api/control → safety-enforced device control
  4. Static files: serves web UI from ../web/

The browser never sees the HA token — all requests go through this proxy.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from typing import Optional

import aiohttp
from aiohttp import web, ClientSession, WSMsgType

# ── Config ──

HA_BASE_URL = os.environ.get("HA_BASE_URL", "http://homeassistant.local:8123")
# Resolve mDNS hostname to IP at startup to avoid thread pool DNS issues
import socket as _socket
try:
    _ha_host = HA_BASE_URL.split("//")[1].split(":")[0].split("/")[0]
    _ha_ip = _socket.gethostbyname(_ha_host)
    HA_BASE_URL = HA_BASE_URL.replace(_ha_host, _ha_ip)
except Exception:
    pass  # Fall back to original URL if resolution fails
HA_TOKEN = os.environ.get("HA_TOKEN", "")
PROXY_PORT = int(os.environ.get("PROXY_PORT", "8080"))
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")

# Import safety checker
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from safety import SafetyChecker
from audit import AuditLogger


# ── Globals ──

app = web.Application()
safety = SafetyChecker()
audit = AuditLogger()
sse_clients: list[web.WebSocketResponse] = []
ws_connected = False


# ── REST Proxy ──

async def ha_rest_proxy(request: web.Request) -> web.Response:
    """Proxy REST API requests to HA, injecting the auth token."""
    # Extract the path after /api/ha/
    ha_path = request.match_info.get("path", "")
    url = f"{HA_BASE_URL}/api/{ha_path}"
    
    headers = {
        "Authorization": f"Bearer {HA_TOKEN}",
        "Content-Type": "application/json",
    }
    
    async with ClientSession() as session:
        method = request.method
        if method == "GET":
            async with session.get(url, headers=headers, timeout=10) as resp:
                body = await resp.text()
                return web.Response(text=body, status=resp.status, content_type="application/json")
        elif method == "POST":
            data = await request.json()
            async with session.post(url, headers=headers, json=data, timeout=10) as resp:
                body = await resp.text()
                return web.Response(text=body, status=resp.status, content_type="application/json")
        else:
            return web.Response(status=405, text="Method not allowed")


# ── Safety-Enforced Control ──

async def ha_control(request: web.Request) -> web.Response:
    """Safety-enforced device control endpoint."""
    data = await request.json()
    entity_id = data.get("entity_id", "")
    action = data.get("action", "")
    value = data.get("value", "")
    confirmed = data.get("confirmed", False)
    
    start = time.time()
    
    # Safety check
    check = safety.check(entity_id, action)
    if not check["allowed"]:
        if check.get("needs_confirmation") and confirmed:
            pass  # Proceed
        else:
            audit.log(
                entity_id=entity_id, action=action, result="blocked",
                risk_level=check["level"], reason=check["reason"], value=str(value),
            )
            return web.json_response({
                "status": "blocked",
                "level": check["level"],
                "reason": check["reason"],
                "needs_confirmation": check.get("needs_confirmation", False),
            })
    
    # Determine domain and service
    domain = entity_id.split(".")[0] if "." in entity_id else ""
    service = action
    
    # Build service data
    service_data = {"entity_id": entity_id}
    if value and action.startswith("set_"):
        if action == "set_temperature":
            service_data["temperature"] = float(value)
        elif action == "set_position":
            service_data["position"] = int(value)
        else:
            service_data[action.replace("set_", "")] = value
    
    # Call HA — use requests in a thread to avoid event loop contention
    # with the SSE WebSocket bridge running in the same loop
    url = f"{HA_BASE_URL}/api/services/{domain}/{service}"
    headers = {"Authorization": f"Bearer {HA_TOKEN}", "Content-Type": "application/json"}
    
    import requests as _requests
    
    def _do_ha_post():
        return _requests.post(url, headers=headers, json=service_data, timeout=10)
    
    try:
        resp = await asyncio.to_thread(_do_ha_post)
        latency = int((time.time() - start) * 1000)
        result_label = "confirmed" if (check.get("needs_confirmation") and confirmed) else "executed"
        
        if resp.status_code == 200:
            audit.log(
                entity_id=entity_id, action=action, result=result_label,
                latency_ms=latency, risk_level=check["level"], value=str(value),
            )
            return web.json_response({
                "status": result_label,
                "service": f"{domain}.{service}",
                "latency_ms": latency,
            })
        else:
            body = resp.text
            audit.log(
                entity_id=entity_id, action=action, result="error",
                latency_ms=latency, risk_level=check["level"],
                reason=body, value=str(value),
            )
            return web.json_response(
                {"status": "error", "error": body},
                status=resp.status_code,
            )
    except Exception as e:
        latency = int((time.time() - start) * 1000)
        audit.log(
            entity_id=entity_id, action=action, result="error",
            latency_ms=latency, risk_level=check["level"],
            reason=str(e), value=str(value),
        )
        return web.json_response({"status": "error", "error": str(e)}, status=500)


# ── SSE Bridge ──

async def ha_ws_to_sse():
    """Connect to HA WebSocket and broadcast state_changed events to SSE clients."""
    global ws_connected
    ws_url = HA_BASE_URL.replace("http://", "ws://").replace("https://", "wss://") + "/api/websocket"
    
    while True:
        try:
            async with ClientSession() as session:
                async with session.ws_connect(ws_url) as ws:
                    # Auth
                    msg = await asyncio.wait_for(ws.receive(), timeout=10)
                    data = json.loads(msg.data)
                    if data.get("type") != "auth_required":
                        raise RuntimeError("Expected auth_required")
                    
                    await ws.send_json({"type": "auth", "access_token": HA_TOKEN})
                    msg = await asyncio.wait_for(ws.receive(), timeout=10)
                    data = json.loads(msg.data)
                    if data.get("type") != "auth_ok":
                        raise RuntimeError(f"Auth failed: {data}")
                    
                    ws_connected = True
                    print(f"[SSE Bridge] Connected to HA WebSocket")
                    
                    # Subscribe to state_changed
                    await ws.send_json({
                        "type": "subscribe_events",
                        "event_type": "state_changed",
                        "id": 1,
                    })
                    
                    # Listen and broadcast
                    async for msg in ws:
                        if msg.type == WSMsgType.TEXT:
                            data = json.loads(msg.data)
                            if (data.get("type") == "event" and
                                data.get("event", {}).get("event_type") == "state_changed"):
                                event_data = data["event"]["data"]
                                # Broadcast to all SSE clients
                                sse_payload = json.dumps({
                                    "entity_id": event_data.get("entity_id"),
                                    "new_state": event_data.get("new_state"),
                                    "old_state": event_data.get("old_state"),
                                }, ensure_ascii=False)
                                
                                # Send to all connected SSE clients
                                disconnected = []
                                for i, client_ws in enumerate(sse_clients):
                                    try:
                                        await client_ws.send_str(f"data: {sse_payload}\n\n")
                                    except Exception:
                                        disconnected.append(i)
                                
                                # Clean up disconnected clients
                                for i in reversed(disconnected):
                                    sse_clients.pop(i)
                        
                        elif msg.type in (WSMsgType.CLOSED, WSMsgType.ERROR):
                            break
            
            ws_connected = False
        except Exception as e:
            ws_connected = False
            print(f"[SSE Bridge] Error: {e}, reconnecting in 5s...")
            await asyncio.sleep(5)


async def sse_endpoint(request: web.Request) -> web.WebSocketResponse:
    """SSE endpoint for frontend to subscribe to state changes."""
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    sse_clients.append(ws)
    
    # Send initial connection message
    await ws.send_str(f"data: {json.dumps({'type': 'connected', 'ws_connected': ws_connected})}\n\n")
    
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                if msg.data == "close":
                    break
            elif msg.type in (WSMsgType.CLOSED, WSMsgType.ERROR):
                break
    finally:
        if ws in sse_clients:
            sse_clients.remove(ws)
    
    return ws


# ── Static Files ──

async def index_handler(request: web.Request) -> web.Response:
    """Serve the main index.html."""
    index_path = os.path.join(WEB_DIR, "index.html")
    if os.path.exists(index_path):
        with open(index_path) as f:
            return web.Response(text=f.read(), content_type="text/html")
    return web.Response(text="Web UI not found", status=404)


# ── Health Check ──

async def health(request: web.Request) -> web.Response:
    """Health check endpoint."""
    return web.json_response({
        "status": "ok",
        "ws_connected": ws_connected,
        "sse_clients": len(sse_clients),
        "ha_base_url": HA_BASE_URL,
    })


# ── Routes ──

app.router.add_get("/api/health", health)
app.router.add_get("/api/sse", sse_endpoint)
app.router.add_post("/api/control", ha_control)
app.router.add_route("*", "/api/ha/{path:.*}", ha_rest_proxy)
app.router.add_get("/", index_handler)

# Static files
if os.path.isdir(WEB_DIR):
    app.router.add_static("/", WEB_DIR)


# ── Main ──

async def start_background_tasks(app: web.Application):
    """Start background tasks on app startup."""
    app["sse_bridge"] = asyncio.create_task(ha_ws_to_sse())


async def cleanup_background_tasks(app: web.Application):
    """Clean up background tasks on app shutdown."""
    app["sse_bridge"].cancel()
    await asyncio.sleep(0.5)


app.on_startup.append(start_background_tasks)
app.on_cleanup.append(cleanup_background_tasks)


def main():
    if not HA_TOKEN:
        print("WARNING: HA_TOKEN not set — proxy will not be able to authenticate with HA")
    print(f"Starting HA Proxy on port {PROXY_PORT}")
    print(f"  HA URL: {HA_BASE_URL}")
    print(f"  Web UI: {WEB_DIR}")
    web.run_app(app, port=PROXY_PORT)


if __name__ == "__main__":
    main()
