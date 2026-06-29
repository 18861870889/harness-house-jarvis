#!/usr/bin/env python3
"""
Automation Manager — HA automation CRUD via REST API.

Provides:
  - create: Create a new HA automation from a spec dict
  - list: List all automations
  - get: Get a single automation's config
  - update: Modify an existing automation
  - delete: Delete an automation
  - trigger: Manually trigger an automation
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Optional

import requests

# Add scripts dir to path
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from audit import AuditLogger

HA_BASE_URL = os.environ.get("HA_BASE_URL", "http://homeassistant.local:8123")
HA_TOKEN = os.environ.get("HA_TOKEN", "")


class AutomationManager:
    """Manage HA automations via REST API."""

    def __init__(self, base_url: str = HA_BASE_URL, token: str = HA_TOKEN):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }
        self.audit = AuditLogger()

    def list(self) -> list[dict]:
        """List all automations."""
        resp = requests.get(
            f"{self.base_url}/api/states",
            headers=self.headers,
            timeout=10,
        )
        resp.raise_for_status()
        all_states = resp.json()
        return [s for s in all_states if s["entity_id"].startswith("automation.")]

    def get(self, entity_id: str) -> dict | None:
        """Get a single automation's state."""
        resp = requests.get(
            f"{self.base_url}/api/states/{entity_id}",
            headers=self.headers,
            timeout=10,
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    def create(self, spec: dict) -> dict:
        """Create a new automation from a spec dict.

        Spec format:
        {
            "alias": "每晚23点关灯",
            "description": "每天23:00关闭所有灯",
            "trigger": [{"platform": "time", "at": "23:00:00"}],
            "condition": [],
            "action": [{"service": "light.turn_off", "target": {"entity_id": "all"}}],
            "mode": "single",
        }
        """
        # HA uses the config/automation/register endpoint
        resp = requests.post(
            f"{self.base_url}/api/config/automation/config",
            headers=self.headers,
            json=spec,
            timeout=10,
        )
        resp.raise_for_status()
        result = resp.json() if resp.text else {}
        
        self.audit.log(
            entity_id=f"automation.{spec.get('alias', 'unknown')}",
            action="create_automation",
            result="executed",
            value=json.dumps(spec, ensure_ascii=False)[:200],
        )
        return result

    def update(self, automation_id: str, spec: dict) -> dict:
        """Update an existing automation."""
        resp = requests.post(
            f"{self.base_url}/api/config/automation/config/{automation_id}",
            headers=self.headers,
            json=spec,
            timeout=10,
        )
        resp.raise_for_status()
        result = resp.json() if resp.text else {}
        
        self.audit.log(
            entity_id=f"automation.{automation_id}",
            action="update_automation",
            result="executed",
        )
        return result

    def delete(self, automation_id: str) -> bool:
        """Delete an automation."""
        resp = requests.delete(
            f"{self.base_url}/api/config/automation/config/{automation_id}",
            headers=self.headers,
            timeout=10,
        )
        success = resp.status_code in (200, 204)
        
        self.audit.log(
            entity_id=f"automation.{automation_id}",
            action="delete_automation",
            result="executed" if success else "error",
            reason=resp.text if not success else "",
        )
        return success

    def trigger(self, entity_id: str) -> dict:
        """Manually trigger an automation."""
        resp = requests.post(
            f"{self.base_url}/api/services/automation/trigger",
            headers=self.headers,
            json={"entity_id": entity_id},
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json() if resp.text else {}
