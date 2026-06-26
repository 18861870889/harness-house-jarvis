# Release Readiness

> Scope: local/internal alpha release gate for Harness House. This is not a public production certification.

## v0.24 Definition

The project is considered ready for local/internal alpha when:

- The app runs locally with HA and LLM configured.
- HCM commands enter the full planner -> grounding -> safety -> policy -> simulation -> decision review chain.
- Real provider execution is disabled by default.
- Command audit is enabled.
- Runtime status is visible in both API and UI.
- Automated tests and production build pass.

## Execution Modes

Default mode:

```bash
HARNESS_EXECUTION_MODE=dry_run
```

In dry-run mode, Harness House can still:

- call the configured LLM;
- resolve intent and targets;
- simulate provider service calls;
- run safety, policy, and decision review;
- write command audit;
- show digital-twin preview state.

It must not execute real provider actions.

Real mode:

```bash
HARNESS_EXECUTION_MODE=real
```

Use real mode only for private, intentional, low-risk device tests. The command still needs to pass HCM grounding, Safety Gate, Policy Gate, provider simulation, Decision Review, runtime authorization, and state readback.

## Runtime Status API

`GET /api/runtime/status` returns:

- current execution mode;
- release target and status;
- blockers and warnings;
- runtime checks;
- next gaps.

Expected statuses:

- `ready`: configured and dry-run safe.
- `ready_with_warnings`: usable, but one or more non-critical risks exist, such as real mode or missing provider baseline.
- `blocked`: missing a critical requirement such as LLM, HA, or command audit.

## Current Known Gaps

- `v0.10 Real Home Pilot` remains incomplete until low-risk real-device tests are observed over time.
- Provider baseline should be recorded after HA device inventory is stable.
- State confidence still needs broader coverage across all major device categories.
- Intent benchmark cases should be expanded with the user's real phrasing and failure examples.
- Public release needs setup docs for key rotation, least-privilege HA tokens, and rollback.

## Verification Commands

```bash
npm test
npm run build
```

Optional local check:

```bash
curl http://localhost:5173/api/runtime/status
```
