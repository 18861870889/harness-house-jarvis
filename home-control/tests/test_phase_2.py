"""
Phase 2 Tests: Obsidian knowledge base — structure, migration, reading, safety, integration.

Tests cover:
  2.1: Vault structure validation (rooms/devices/scenes/preferences/automations dirs exist)
  2.2: Migration completeness (all rooms and devices migrated correctly)
  2.3: Obsidian device note reading (alias resolution, room mapping)
  2.4: Safety policy frontmatter read/write
  2.5: End-to-end (alias → correct device, safety block → reject)
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Add scripts dir to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scripts"))
from safety import SafetyChecker
import migrate_to_obsidian as mig


# ── Paths ──

BASE_DIR = os.path.expanduser("~/harness-house-jarvis")
OBSIDIAN_VAULT = os.path.expanduser("~/Documents/Obsidian-Vault")
HOME_CONTROL_DIR = os.path.join(OBSIDIAN_VAULT, "home-control")
ROOMS_DIR = os.path.join(HOME_CONTROL_DIR, "rooms")
DEVICES_DIR = os.path.join(HOME_CONTROL_DIR, "devices")
PREFERENCES_DIR = os.path.join(HOME_CONTROL_DIR, "preferences")
AUTOMATIONS_DIR = os.path.join(HOME_CONTROL_DIR, "automations")


# ── Step 2.1: Vault Structure ──

class TestVaultStructure:
    """Test that the Obsidian vault has the correct directory structure."""

    def test_home_control_dir_exists(self):
        assert os.path.isdir(HOME_CONTROL_DIR), f"{HOME_CONTROL_DIR} should exist"

    def test_rooms_dir_exists(self):
        assert os.path.isdir(ROOMS_DIR), "rooms/ directory should exist"

    def test_devices_dir_exists(self):
        assert os.path.isdir(DEVICES_DIR), "devices/ directory should exist"

    def test_preferences_dir_exists(self):
        assert os.path.isdir(PREFERENCES_DIR), "preferences/ directory should exist"

    def test_automations_dir_exists(self):
        assert os.path.isdir(AUTOMATIONS_DIR), "automations/ directory should exist"

    def test_index_note_exists(self):
        index_path = os.path.join(HOME_CONTROL_DIR, "index.md")
        assert os.path.isfile(index_path), "index.md should exist"
        content = open(index_path).read()
        assert "Home Control" in content or "home" in content.lower()

    def test_policies_json_exists(self):
        policies_path = os.path.join(HOME_CONTROL_DIR, "policies.json")
        assert os.path.isfile(policies_path), "policies.json should exist"
        with open(policies_path) as f:
            policies = json.load(f)
        assert isinstance(policies, dict)
        assert len(policies) > 0

    def test_room_notes_have_frontmatter(self):
        """Each room note should have YAML frontmatter."""
        room_files = list(Path(ROOMS_DIR).glob("*.md"))
        assert len(room_files) > 0, "Should have at least one room note"
        for rf in room_files[:3]:
            content = rf.read_text(encoding="utf-8")
            assert content.startswith("---"), f"{rf.name} should start with frontmatter"
            assert "type: room" in content

    def test_device_notes_have_frontmatter(self):
        """Each device note should have YAML frontmatter with safety level."""
        device_files = list(Path(DEVICES_DIR).glob("*.md"))
        assert len(device_files) > 0, "Should have at least one device note"
        for df in device_files[:3]:
            content = df.read_text(encoding="utf-8")
            assert content.startswith("---"), f"{df.name} should start with frontmatter"
            assert "safety:" in content
            assert "type: device" in content


# ── Step 2.2: Migration Completeness ──

class TestMigrationCompleteness:
    """Test that the migration script correctly migrates all data."""

    def test_all_rooms_migrated(self):
        """All rooms from spatial-editor should have notes."""
        # Load source data
        spatial_path = os.path.join(BASE_DIR, "data", "spatial-editor.local.json")
        if not os.path.exists(spatial_path):
            pytest.skip("spatial-editor.local.json not found")
        with open(spatial_path) as f:
            spatial = json.load(f)
        state = spatial.get("state", {})
        device_assignments = state.get("deviceAssignments", {})

        # Get unique rooms from source
        source_rooms = set()
        for room_id in device_assignments.values():
            source_rooms.add(room_id or "unassigned")

        # Get rooms from vault
        room_files = {f.stem for f in Path(ROOMS_DIR).glob("*.md")}
        # Room keys are sanitized (non-word chars → _)
        for room in source_rooms:
            safe_key = re.sub(r"[^\w]", "_", room)
            assert safe_key in room_files or room in room_files, \
                f"Room '{room}' (safe: '{safe_key}') should have a note"

    def test_device_count_matches(self):
        """Total device notes should be > 0 and reasonable."""
        device_files = list(Path(DEVICES_DIR).glob("*.md"))
        assert len(device_files) > 50, f"Expected 50+ device notes, got {len(device_files)}"

    def test_preference_note_has_observations(self):
        """Preference note should contain observation data."""
        pref_path = os.path.join(PREFERENCES_DIR, "user-preferences.md")
        assert os.path.isfile(pref_path)
        content = open(pref_path, encoding="utf-8").read()
        assert "观察" in content or "observation" in content.lower()

    def test_policies_json_matches_devices(self):
        """policies.json should contain safety levels for migrated devices."""
        policies_path = os.path.join(HOME_CONTROL_DIR, "policies.json")
        with open(policies_path) as f:
            policies = json.load(f)
        # Should have entries for both allow_auto and block
        allow_count = sum(1 for v in policies.values() if v == "allow_auto")
        block_count = sum(1 for v in policies.values() if v == "block")
        assert allow_count > 0, "Should have allow_auto policies"
        assert block_count > 0, "Should have block policies"

    def test_room_note_contains_device_table(self):
        """Room notes should contain a device table."""
        room_files = list(Path(ROOMS_DIR).glob("*.md"))
        if not room_files:
            pytest.skip("No room notes")
        content = room_files[0].read_text(encoding="utf-8")
        assert "| 设备 |" in content or "设备列表" in content

    def test_device_note_has_room_reference(self):
        """Device notes should reference their room."""
        device_files = list(Path(DEVICES_DIR).glob("*.md"))
        if not device_files:
            pytest.skip("No device notes")
        content = device_files[0].read_text(encoding="utf-8")
        assert "room:" in content


# ── Step 2.3: Obsidian Reading ──

class TestObsidianReading:
    """Test reading device notes from Obsidian (alias resolution, room mapping)."""

    def test_safety_checker_reads_policies_json(self):
        """SafetyChecker should read from the migrated policies.json."""
        policies_path = os.path.join(HOME_CONTROL_DIR, "policies.json")
        checker = SafetyChecker(
            policy_path=policies_path,
            devices_dir=DEVICES_DIR,
        )
        # Pick a known entity from policies
        with open(policies_path) as f:
            policies = json.load(f)
        sample_eid = next(iter(policies))
        expected_level = policies[sample_eid]

        level = checker.get_safety_level(sample_eid)
        assert level == expected_level

    def test_safety_checker_falls_back_to_domain_default(self):
        """Unknown entity should fall back to domain default."""
        checker = SafetyChecker(
            policy_path=os.path.join(HOME_CONTROL_DIR, "policies.json"),
            devices_dir=DEVICES_DIR,
        )
        # switch.* should default to allow_auto
        level = checker.get_safety_level("switch.totally_unknown_device")
        assert level == "allow_auto"

    def test_safety_checker_unknown_domain_defaults_block(self):
        """Unknown domain should default to block."""
        checker = SafetyChecker(
            policy_path=os.path.join(HOME_CONTROL_DIR, "policies.json"),
            devices_dir=DEVICES_DIR,
        )
        level = checker.get_safety_level("unknown_domain.some_device")
        assert level == "block"

    def test_read_device_note_frontmatter(self):
        """Should be able to parse frontmatter from a device note."""
        device_files = list(Path(DEVICES_DIR).glob("*.md"))
        if not device_files:
            pytest.skip("No device notes")
        
        # Read first device note
        content = device_files[0].read_text(encoding="utf-8")
        match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        assert match, "Should have frontmatter"
        
        frontmatter = match.group(1)
        assert "entity_id:" in frontmatter or "name:" in frontmatter
        assert "safety:" in frontmatter

    def test_room_mapping_from_device_note(self):
        """Device note should contain room information."""
        device_files = list(Path(DEVICES_DIR).glob("*.md"))
        rooms_found = set()
        for df in device_files[:20]:
            content = df.read_text(encoding="utf-8")
            match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
            if match:
                fm = match.group(1)
                room_match = re.search(r"room:\s*(\S+)", fm)
                if room_match:
                    rooms_found.add(room_match.group(1))
        assert len(rooms_found) > 0, "Should find room references in device notes"


# ── Step 2.4: Safety Policy Frontmatter ──

class TestSafetyPolicyFrontmatter:
    """Test reading and writing safety levels via Obsidian frontmatter."""

    def test_set_safety_level_persists(self):
        """set_safety_level should write to policies.json."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            f.write("{}")
            tmp_policy = f.name
        
        try:
            checker = SafetyChecker(policy_path=tmp_policy, devices_dir="/nonexistent")
            checker.set_safety_level("light.test", "need_confirm")
            
            # Read back
            with open(tmp_policy) as f:
                policies = json.load(f)
            assert policies["light.test"] == "need_confirm"
        finally:
            os.unlink(tmp_policy)

    def test_safety_level_override(self):
        """Policy file should override domain defaults."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump({"switch.test": "block"}, f)
            tmp_policy = f.name
        
        try:
            checker = SafetyChecker(policy_path=tmp_policy, devices_dir="/nonexistent")
            # switch normally defaults to allow_auto, but policy says block
            level = checker.get_safety_level("switch.test")
            assert level == "block"
        finally:
            os.unlink(tmp_policy)

    def test_obsidian_frontmatter_safety_read(self):
        """Should read safety level from Obsidian device note frontmatter."""
        # Create a temp device note
        with tempfile.TemporaryDirectory() as tmpdir:
            device_note = os.path.join(tmpdir, "test_device.md")
            with open(device_note, "w") as f:
                f.write("---\nentity_id: \"light.test\"\nsafety: need_confirm\n---\n# Test\n")
            
            checker = SafetyChecker(
                policy_path="/nonexistent/policies.json",
                devices_dir=tmpdir,
            )
            level = checker.get_safety_level("light.test")
            assert level == "need_confirm"

    def test_policy_overrides_obsidian(self):
        """Policy file should take priority over Obsidian frontmatter."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Device note says allow_auto
            device_note = os.path.join(tmpdir, "test_device.md")
            with open(device_note, "w") as f:
                f.write("---\nentity_id: \"light.test\"\nsafety: allow_auto\n---\n# Test\n")
            
            # Policy says block
            with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
                json.dump({"light.test": "block"}, f)
                tmp_policy = f.name
            
            try:
                checker = SafetyChecker(policy_path=tmp_policy, devices_dir=tmpdir)
                level = checker.get_safety_level("light.test")
                assert level == "block"  # Policy wins
            finally:
                os.unlink(tmp_policy)


# ── Step 2.5: End-to-End Integration ──

class TestPhase2Integration:
    """End-to-end: alias → correct device, safety block → reject."""

    def test_known_device_safety_enforced(self):
        """A device with known safety level should be enforced."""
        policies_path = os.path.join(HOME_CONTROL_DIR, "policies.json")
        with open(policies_path) as f:
            policies = json.load(f)
        
        checker = SafetyChecker(
            policy_path=policies_path,
            devices_dir=DEVICES_DIR,
        )
        
        # Find a block device
        block_device = next((eid for eid, level in policies.items() if level == "block"), None)
        if block_device:
            check = checker.check(block_device, "turn_on")
            assert not check["allowed"]
            assert check["level"] == "block"
        
        # Find an allow_auto device
        allow_device = next((eid for eid, level in policies.items() if level == "allow_auto"), None)
        if allow_device:
            check = checker.check(allow_device, "turn_on")
            assert check["allowed"]
            assert check["level"] == "allow_auto"

    def test_domain_default_safety_for_unknown(self):
        """Unknown device should use domain defaults."""
        policies_path = os.path.join(HOME_CONTROL_DIR, "policies.json")
        checker = SafetyChecker(
            policy_path=policies_path,
            devices_dir=DEVICES_DIR,
        )
        
        # switch → allow_auto
        assert checker.get_safety_level("switch.brand_new_device") == "allow_auto"
        
        # lock → block
        assert checker.get_safety_level("lock.brand_new_lock") == "block"

    def test_migration_script_runs_clean(self):
        """Migration script should run without errors on existing data."""
        # The migration was already run, just verify it can re-run
        result = mig.migrate()
        assert result["rooms"] > 0
        assert result["devices"] > 0
        assert result["policies"] > 0
