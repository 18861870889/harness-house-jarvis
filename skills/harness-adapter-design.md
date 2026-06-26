# Harness Adapter Design Skill

Use this when adding or changing a provider adapter such as Home Assistant, Matter, Mi Home, Tuya, Apple Home, or a vendor cloud.

## Goal

Map provider-specific devices into Harness Capability Model without leaking provider assumptions upward.

## Required Outputs

- Normalized spaces.
- Normalized things.
- Capabilities with risk and confirmation policy.
- State snapshot.
- Evidence for each capability.
- Stable provider binding ids.
- Snapshot hash and diff behavior.

## Design Rules

- Provider domain is not enough to define capability.
- Unknown switches are blocked by default.
- Sensors are read-only unless explicitly modeled as actions.
- Configuration entities are never auto-executable.
- Camera, gas, lock, and privacy-sensitive capabilities are blocked or confirmation-required.
- Executor chooses final service based on current provider support.

## Required Tests

- Raw graph to HCM snapshot.
- Capability inference.
- Risk defaults.
- Provider unavailable behavior.
- Unsupported service dry-run.
- Provider rename / deletion / new device diff.
