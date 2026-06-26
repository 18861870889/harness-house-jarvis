# Harness Safety Review Skill

Use this before enabling real execution, changing safety policy, or expanding auto-executable capabilities.

## Review Questions

- Can this action physically affect the home?
- Is the target device unambiguous?
- Is the capability explicitly declared in HCM?
- Is the provider service actually supported now?
- Is the risk level correct?
- Does it require user confirmation?
- Could the same entity represent a dangerous device?
- Is there a dry-run or simulator test?
- Does the UI explain why the action is allowed or rejected?

## Default Blocks

- Unknown switch.
- Camera control.
- Gas or water heater activation.
- Door lock or entry control.
- Text / select / number / config entities.
- Sensitive privacy sensors.

## Approval Rule

LLM output is never sufficient approval. Real execution requires deterministic safety gate approval.
