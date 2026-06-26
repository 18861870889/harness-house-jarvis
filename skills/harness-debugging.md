# Harness Debugging Skill

Use this when debugging Harness House bugs, failed tests, unexpected device behavior, or HA integration issues.

## Rule

No fixes before root cause.

## Process

1. Reproduce the issue.
2. Capture command input, command trace, HCM snapshot, selected capability, selected adapter action, and result.
3. Identify the failing layer:
   - UI
   - command pipeline
   - LLM planner
   - plan validator
   - safety gate
   - executor
   - adapter
   - provider
4. Compare with a working example in the same layer.
5. Write a failing unit test, contract test, or dry-run replay.
6. Fix the root cause with the smallest change.
7. Run targeted tests, then full tests.

## Hard Safety Rule

Do not use real HA device control for automated debugging. Use dry-run, read-only HA discovery, or simulator.

## Stop Condition

If three fixes fail or each fix exposes a new architectural problem, stop and reassess the design before continuing.
