# Harness House: Codex Proposal

## Proposal Documents

- [Framework Strategy ZH](./framework-strategy-zh.md): open-source AI smart home framework direction based on the current device ecosystem and product goals.
- [Hermes-Inspired Architecture ZH](./hermes-inspired-architecture-zh.md): architecture diagram and feature tradeoff for a Hermes-like but safety-first smart home framework.
- [2s Latency-First Architecture ZH](./latency-first-architecture-zh.md): simplified command execution architecture optimized for about 2 seconds from instruction to result.
- [AI Product PRD ZH](./ai-product-prd-zh.md): AI-specific product requirements document covering model boundaries, schemas, safety, latency, evaluation, and MVP scope.
- [Market Evaluation ZH](./market-evaluation-zh.md): market landscape, competitor analysis, product positioning, risks, and go-to-market recommendation.

## 1. Project Positioning

Harness House should not be a simple "voice assistant for smart home". The better target is an AI home operating layer:

- It understands human intent.
- It maps intent to safe, reversible, inspectable device actions.
- It learns household preferences without silently taking risky actions.
- It can coordinate devices across brands, protocols, rooms, people, and routines.

In plain terms: the system should become a reliable home control brain, not just a chat box connected to switches.

## 2. Core Product Idea

The product can be built around three interaction modes.

### 2.1 Command Mode

The user gives a direct command:

- "Turn off the living room lights."
- "Set the bedroom AC to 24 degrees."
- "Open the curtains at 7:30 tomorrow morning."

The system should execute quickly, then return a short confirmation.

### 2.2 Scenario Mode

The user describes a desired state instead of specific devices:

- "I am going to sleep."
- "Make the room comfortable for reading."
- "Prepare the house before I get home."

The system converts the scenario into a plan involving multiple devices, for example lights, curtains, climate, speaker volume, locks, and sensors.

### 2.3 Steward Mode

The system proactively observes and suggests:

- "The balcony window is open and rain is expected in 20 minutes. Close it?"
- "No one is home, but the study light has been on for 3 hours. Turn it off?"
- "Power usage is unusually high today. Show details?"

In early versions, proactive actions should be suggestions, not automatic execution, unless the user explicitly configures a rule.

## 3. Design Principles

1. Safety before cleverness.
   The AI may misunderstand natural language. Every risky action needs guardrails.

2. Inspectability.
   Users should be able to see why an action happened, what devices changed, and which rule or conversation triggered it.

3. Reversibility.
   Most actions should have an undo path or a previous-state snapshot.

4. Local-first where practical.
   Basic control should still work if cloud AI is unavailable. The home should not become unusable because an API is down.

5. Human confirmation for high-risk operations.
   Door locks, gas valves, ovens, water valves, security systems, and payments require stricter policies.

6. Device abstraction over vendor coupling.
   The product should model capabilities such as `light.on`, `climate.set_temperature`, and `lock.unlock`, instead of hardcoding each vendor's interface everywhere.

## 4. Suggested Architecture

```text
User Interfaces
  - Web app
  - Mobile app later
  - Voice/chat entry later

AI Orchestration Layer
  - Intent understanding
  - Plan generation
  - Risk classification
  - Confirmation policy
  - Explanation generation

Home Domain Layer
  - Rooms
  - Devices
  - Capabilities
  - Scenes
  - Automations
  - Household members
  - Permissions

Execution Layer
  - Device adapters
  - State sync
  - Command queue
  - Retry and rollback
  - Event log

Integration Layer
  - Home Assistant first
  - Matter later
  - MQTT later
  - Vendor APIs only where needed

Storage
  - Device registry
  - State history
  - Rules and scenes
  - User preferences
  - Audit log
```

## 5. Key Modules

### 5.1 Device Registry

Stores normalized information about every device:

- Device id
- Display name
- Room
- Device type
- Supported capabilities
- Vendor/source
- Current state
- Risk level

Example capability model:

```json
{
  "device_id": "living_room_main_light",
  "name": "Living Room Main Light",
  "room": "living_room",
  "type": "light",
  "capabilities": ["turn_on", "turn_off", "set_brightness", "set_color_temperature"],
  "risk_level": "low"
}
```

### 5.2 Intent Parser

Converts natural language into structured intent.

Example:

```json
{
  "intent": "set_device_state",
  "targets": [
    {
      "room": "living_room",
      "device_type": "light"
    }
  ],
  "actions": [
    {
      "capability": "turn_off"
    }
  ],
  "confidence": 0.94
}
```

### 5.3 Planner

Turns intent into concrete device commands. The planner should:

- Resolve ambiguous devices.
- Group commands into a transaction-like plan.
- Estimate risk.
- Ask for confirmation when needed.
- Generate an execution preview for the UI.

### 5.4 Policy Engine

This is the most important safety module.

Policy examples:

- Low risk: lights, curtains, speaker volume. Execute directly.
- Medium risk: AC/heating, humidifier, robot vacuum. Execute if context is clear.
- High risk: locks, security alarm, gas, oven, water valve. Always confirm.
- Critical risk: actions that may endanger people or property. Require explicit confirmation and maybe local presence.

### 5.5 Execution Engine

Executes commands through adapters. It should support:

- Dry run
- Command queue
- Timeout
- Retry
- Partial failure handling
- Previous-state snapshot
- Event logging

### 5.6 Memory and Preference Layer

The AI should remember preferences, but only with user-visible control.

Good examples:

- Preferred sleep temperature
- Reading scene brightness
- Usual wake-up time
- Rooms that should never be controlled automatically

Bad examples:

- Secretly inferring private habits
- Making security decisions without approval
- Hiding what has been learned

## 6. MVP Scope

The first usable version should be intentionally narrow:

1. Connect to Home Assistant.
2. Import rooms, entities, and basic states.
3. Provide a web chat/control UI.
4. Support lights, switches, curtains, and climate devices.
5. Convert user text to a structured plan.
6. Show a confirmation preview before execution.
7. Execute low-risk commands.
8. Log every command and result.

Avoid these in MVP:

- Full autonomous control
- Complex multi-user permission system
- Native mobile app
- Direct integration with many vendors
- Overly broad device categories

## 7. Proposed User Experience

The first screen should be the home control workspace, not a marketing page.

Main layout:

- Left: rooms and device groups
- Center: current home state and scene cards
- Right: AI conversation and execution preview
- Bottom or side panel: recent actions and failures

The AI should not only answer in text. It should produce executable plans:

```text
User: Make the living room suitable for watching a movie.

Plan:
1. Dim living room main light to 20%.
2. Close living room curtains.
3. Set TV ambient light to warm.
4. Set AC to 24 C if current temperature is above 26 C.

Action:
Confirm / Edit / Cancel
```

## 8. Data Model Draft

Core entities:

- `Home`
- `Room`
- `Device`
- `Capability`
- `DeviceState`
- `Scene`
- `Automation`
- `Intent`
- `Plan`
- `Command`
- `ExecutionResult`
- `PolicyRule`
- `AuditEvent`
- `UserPreference`

The most important relationship:

```text
User message -> Intent -> Plan -> Commands -> Execution results -> Audit events
```

This chain should be preserved because it makes the system debuggable.

## 9. AI Strategy

The AI should be used for language and planning, not blind execution.

Recommended flow:

1. Retrieve current home context.
2. Ask the model to produce strict JSON intent.
3. Validate JSON against schema.
4. Resolve devices using deterministic code.
5. Generate an execution plan.
6. Run policy checks.
7. Ask for confirmation if needed.
8. Execute through adapters.
9. Summarize result.

Never let the model directly call arbitrary device APIs without validation.

## 10. Risk and Permission Model

Suggested risk levels:

- `low`: reversible comfort changes, such as lights.
- `medium`: comfort or energy changes, such as AC temperature.
- `high`: security, access, appliances, water, gas.
- `critical`: actions that can create direct danger.

Suggested confirmation matrix:

| Risk | Example | Default Behavior |
| --- | --- | --- |
| Low | Turn off light | Execute directly |
| Medium | Set AC to 18 C | Preview or execute based on user setting |
| High | Unlock front door | Require confirmation |
| Critical | Turn on gas valve | Block or require special local confirmation |

## 11. Roadmap

### Phase 1: Foundation

- Home Assistant connector
- Device registry
- Basic web UI
- AI intent parsing
- Execution preview
- Audit log

### Phase 2: Reliable Control

- Scenes
- Scheduling
- Policy engine
- State history
- Failure recovery
- Manual plan editing

### Phase 3: Personalization

- Preference memory
- Household profiles
- Context-aware suggestions
- Energy optimization
- Routine discovery

### Phase 4: Semi-Autonomous Home

- User-approved automations
- Proactive safety suggestions
- Multi-modal input
- Matter/MQTT support
- Local model fallback for common commands

## 12. Technical Stack Suggestion

The exact stack can follow the existing repo later, but my preferred direction is:

- Backend: Python FastAPI
- AI orchestration: typed service layer with strict schemas
- Device integration: Home Assistant REST/WebSocket first
- Queue/events: lightweight async queue first, Redis later if needed
- Storage: SQLite for MVP, PostgreSQL when multi-user/history grows
- Frontend: React or Vue, depending on existing code direction
- Validation: Pydantic schemas for intents, plans, commands, policies

## 13. First Engineering Milestones

1. Define schemas for device, capability, intent, plan, command, and result.
2. Build a fake device adapter for local testing.
3. Build a Home Assistant adapter.
4. Build text-to-intent parsing with strict JSON validation.
5. Build planner and policy check.
6. Build web UI execution preview.
7. Add audit log.
8. Add test cases for ambiguous and risky commands.

## 14. Open Questions for Discussion

1. Should the project be Home Assistant-first or independent hub-first?
2. Should the first UI be web-only, or should voice be considered from day one?
3. What devices do you actually have available for testing?
4. Which language should the assistant primarily support first: Chinese, English, or both?
5. Do we want local model support as a core requirement or a later enhancement?
6. How strict should confirmation be for medium-risk devices like AC and heaters?
7. Should the project optimize for a personal home first or become a reusable open-source framework?

## 15. My Recommended Direction

Build the first version as a Home Assistant AI control layer.

Reason:

- Home Assistant already solves many device integration problems.
- We can focus on AI intent, safety, planning, and UX.
- It gives a real test path quickly.
- Later, Harness House can become more independent by adding Matter, MQTT, and direct vendor adapters.

The core differentiator should be:

```text
Natural language -> safe structured plan -> transparent execution -> learnable household preferences
```

That is the part worth making excellent.
