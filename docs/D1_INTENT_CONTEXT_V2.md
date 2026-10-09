# D1 intent and context v2

## Status

Simulation-only alpha, verified on 2026-10-09. The isolated Pi and LangGraph runtime factories now default to `decisionVersion: "v2"`; `"v1"` preserves the previous decision baseline. The main UI, `server.mjs` D1 demo, Hermes voice path, real HA executor, household layout and runtime credentials are unchanged. Starting `demo:d1` does not enable this version.

This iteration improves candidate coverage, bounded conversational grounding, lighting goals, and explicit feedback. It does not implement reinforcement learning, generalized planning, new-device onboarding, or production voice-origin detection.

## Architecture

D1 selects a finite choice rather than generating arbitrary tool calls, as described in the [official decision-model guide](https://docs.liquid.ai/guides/decision-model-guide). Candidate compilation is therefore part of the harness, not an optional local model fallback. Room/name/domain grounding reuses HCM and the control graph; the [HA intent model](https://developers.home-assistant.io/docs/intent_builtin/) is a reference for this separation.

```text
Current input + bounded conversation + fresh configured terminal origin
  -> HCM logical targets, capabilities and current device states
  -> bounded complete decisions: execute / answer / ask / no action
  -> ONE native local D1 choice, without an independent purpose question
  -> confidence gate + latest HCM validation + provider simulation
  -> memory-only execution + state readback
  -> atomic result, conversation and lighting-feedback state
```

The old independent plan/purpose questions could disagree even when D1 selected the correct device action. V2 puts purpose, target and operation in one candidate. This removes that particular contradiction, not the need for permission, capability, freshness or confidence checks.

### Grounding And Permissions

- Explicit room overrides everything. An explicit conversational referent such as "the light just opened" retains its target even after the speaker moves.
- For generic room commands, a configured terminal's fresh origin overrides an old discussion room. Without it, valid conversational room focus may fill the omission.
- Terminal origin must reference an existing mapped room, be no more than ten seconds old, and not be in the future. Selected UI rooms and occupancy sensors are not speaker-location evidence. Production terminal authentication is not implemented.
- Context is bounded to six turns and 30 minutes. Up to three relevant turns enter model input; unrelated device history is excluded when a target scope exists.
- Capability-method questions remain read-only. Goal candidate enrichment inherits the same compiler permission flag rather than bypassing it. A narrow polite-immediate-request exception allows expressions equivalent to "can you help me turn it on" to offer execution candidates. Negated devices cannot be written. Lexical retrieval and these guards still have language-coverage limits; this is not unrestricted language understanding.
- Candidates are compiled from actual HCM capabilities, including logical lights controlled by a switch in another room. Read-only sensors, unbound buttons and protected capabilities cannot become actuator choices.
- Numeric bounds/steps and model-response membership are checked. Too many options or missing scope lead to clarification rather than silent truncation.

### Lighting Goals And Feedback

"Still too dark" can offer another currently-off logical light or supported brightness adjustment in the grounded room. The prototype numeric change is 20 percentage points, constrained by known min/max/step. Color temperature is not substituted for brightness; unknown state is not treated as off. Both brighter and dimmer directions have explicit non-executable limit responses when no adjustment remains.

Automatic selection still requires score >= 0.65 and margin >= 0.20. A plausible executable choice with score >= 0.50 and margin >= 0.20 may instead become a specific proposal, such as "Shall I also turn on the study ceiling light?" It has **no executable actions in the current result**. Confirmation identifies the pending question, calls D1 again, and revalidates the latest household. Rejecting a proposal clears it without another effect.

Verified device change creates `awaiting_user_feedback`, not proof of comfortable illumination. Explicit improvement records `improved_by_user` while keeping the task open; explicit satisfaction records `satisfied_by_user`. Satisfaction before a proposed adjustment cancels that proposal and records `proposedOnly: true`, without claiming it executed. Feedback cannot be attributed to a different known room; tasks expire after 30 minutes.

There is no lux measurement, learned default light, permanent preference update, or claim that a completed actuator action fulfilled the user's comfort goal. Replies are short factual templates, not free-form D1 conversation generation.

## Verification

Node 24.13.1, macOS arm64. Full suite: **413 passed, 3 skipped**; harness/client/intent subset: **141 passed**; adapter contracts: **31 passed**. Production build passed. The new tests cover coherent single-call decisions, origin precedence/freshness, referents, read-only boundaries, negation, unsupported/unknown capabilities, constraints, proposals, rejection, restart, feedback, expiry and truthful dry runs. Existing crash/replay/resource tests also run against the default v2 runtime.

Native D1 evaluation uses Pi, fresh simulated households and temporary databases. Expected results never enter model input. No real HA or cloud model is called.

| Final native suite | v1 strict pass | v2 strict pass | v2 p50 / p95 |
| --- | ---: | ---: | ---: |
| [36-case regression](reports/d1-intent-regression.json) | 25/36 | 34/36 | 86.26 / 126.26 ms |
| [18-case additional-expression suite](reports/d1-intent-holdout.json) | 12/18 | 18/18 | 103.43 / 173.50 ms |

The two remaining strict regression failures are intentionally retained:

1. After opening the study spotlight, "still too dark" selects the correct extra light but scores about 0.637, below automatic execution permission. The system proposes that light instead. A separate explicit-confirmation case successfully executes it.
2. "That is much better" following that **unexecuted** proposal still clarifies rather than reliably recording improvement. "Much better" after confirmed execution passes, and does not prematurely complete the task.

During development, an unconstrained joint-choice prototype interpreted some capability questions as writes in simulation. The hard read-only boundary was restored rather than treating model confidence as permission. Full regression also caught an unavailable-goal null access after a rejected proposal; both unavailable directions and unknown states now have explicit tests.

These are finite development suites, not independently calibrated accuracy. The additional expressions were specified before the initial native probes, but rerun while implementing feedback semantics; they are not a blind external benchmark. Times cover the local D1/SDK/memory-device chain, including persistence, not STT/TTS, actual HA convergence or a two-second production SLA. Model scores are not calibrated execution-success probabilities.

## Reproduce

```sh
npm ci
npm run test:harness
npm run test:adapter
npm test
npm run build
# Optional LAN D1 calls; every device remains simulated.
npm run test:d1:intent:live -- --baseline --output=docs/reports/d1-intent-regression.json
npm run test:d1:intent:live -- --baseline --holdout --output=docs/reports/d1-intent-holdout.json
# Default framework comparisons use v2; --v1 restores the old baseline.
npm run compare:harness
```

`D1_ENDPOINT` overrides the LAN endpoint; no API key or HA credentials are loaded. The regression command currently exits **1** for the two strict failures, after saving the report. Do not lower thresholds or change expected automatic actions to hide them. Deterministic test clients verify mechanics only; native tests verify language selection.

## Next Gates

1. Add a switchable, simulation-only Pi/v2 API path and inspectable decision traces before migrating the main page. Preserve the existing household configuration.
2. Expand unseen user-language replay, candidate-recall and false-execution/clarification evaluation; calibrate scores separately from permission gates. Larger homes currently need narrower scopes rather than unbounded options.
3. Implement consented preference learning with evidence, expiry and reversal. Lighting feedback alone is not self-evolution.
4. Add authenticated voice terminals and real HA read-only snapshots for dry-run comparisons. Real actuator reconciliation and provider-specific freshness remain separate work.
5. Retain the [hardening report's operational and security gates](PI_HARNESS_HARDENING.md#remaining-gates): multi-day operation, storage/upgrade drills, native checkpoint retention and dependency remediation. Local journals cannot guarantee exactly-once effects on real HA.
