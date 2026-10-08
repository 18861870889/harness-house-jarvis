# D1 harness comparison

## Current Status

The measurements and recommendation below are the **initial comparison baseline**. Subsequent [Pi hardening](PI_HARNESS_HARDENING.md) adds atomic result/conversation persistence, projection repair, actual process-kill tests, bounded Pi sessions, and comparable durability benchmarks. Pi is now a viable next-prototype candidate; the initial LangGraph preference is not the current final decision. Neither runtime has been migrated into the active UI, and the shared intent-gate failure remains unresolved.

## Initial Decision

This is an isolated SDK evaluation, not a production migration. Prefer **LangGraph JS** for the next D1 control-path prototype: it accepts the native decision API directly and supplies checkpointed clarification interrupts. Pi Agent Core also works, but its chat/tool-event interface needs a custom D1 bridge, and clarification state remains application glue in this experiment.

Do not replace the active demo or Hermes integration yet. Neither framework fixes intent understanding simply by being installed. Keep HCM, policy validation, simulation, effect admission, and device-state verification outside the model runtime.

Official references consulted before implementation:

- [Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent): agent loop, lifecycle events, tools, cancellation.
- [LangGraph JS persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): checkpoints and thread identity.
- [LangGraph fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance): restart and replay semantics.
- [Liquid decision models](https://docs.liquid.ai/guides/decision-model-guide): D1 selects finite choices; it does not generate a chat tool-call transcript.

Pinned SDKs: Pi core/AI/official SQLite backend `0.99.2`, LangGraph `1.4.21`, SQLite checkpointer `1.0.4`. Pi core's registry latest and its SQLite backend did not share a release; matched versions were chosen instead of mixing them. This does not claim parity with the latest Pi AgentHarness API. No code from either framework was copied into the product.

## Initial Architecture

```text
Request identity + abort signal
  -> shared durable admission ledger
  -> Pi agent loop OR LangGraph state graph
  -> bounded conversation + configured voice-terminal origin
  -> existing HCM candidate compiler -> native local D1 choice
  -> existing confidence/purpose gates
  -> latest household snapshot + strict HCM validation
  -> provider simulation -> memory-only execution -> state readback
  -> framework conversation persistence + completed-request cache
```

The two adapters use the same business kernel and simulated household. The physical entrance switch controls dining lights; the study's multi-gang switch exposes separate logical lights. Unused buttons remain protected. No HA URL/token is accepted by the adapters. The only optional network call is to local D1; no DeepSeek, OpenAI, LangSmith tracing, or chat-completions fallback is configured.

Pi persists application conversation state through its official SQLite session-value API. Its tools terminate the turn, and `finishTurn` explicitly ends it even after tool failure. LangGraph uses its official SQLite checkpointer, with `interrupt` in a separate side-effect-free node and `Command({resume})` for a clarification answer. Execution is never inside the interrupt node.

## Reproduce

Use Node `24.13.1` or a compatible Node 24 runtime; these experiments use built-in `node:sqlite`, currently marked experimental. LangGraph's checkpointer also requires `better-sqlite3`'s native binding, installed by a normal `npm ci`. Do not install with scripts disabled unless that binding is rebuilt separately.

```sh
npm ci
npm run test:harness
npm run compare:harness -- --output=docs/reports/pi-hardening-fixture.json
npm run compare:harness -- --live --output=docs/reports/pi-hardening-local-d1.json
```

The live command defaults to the configured LAN D1 endpoint; `D1_ENDPOINT` can override it. It does not use `.env` HA credentials. All device writes are in memory. Temporary framework databases are removed at exit.

## Verification

Shared scenarios cover one inference per command, HCM execution/readback, duplicate suppression, payload conflicts, contextual follow-ups, truthful dry-run history, clarification across restart, wrong/expired question IDs, unrelated replacement requests, session isolation, explicit room overrides, trusted/fresh microphone origin, low-confidence and malformed choices, sensor/protected/offline boundaries, household changes during inference, cancellation before/between effects, concurrency rejection, and unconfirmed-effect recovery.

Separate Node-process probes verify durable context, simulated world state, and completed-command deduplication. Crash-window tests inject failure after an in-memory effect but before completion; an unconfirmed request is not automatically replayed. These are SDK/business-mechanics tests with deterministic choice fixtures, **not proof of language understanding**.

Initial verification on Node `24.13.1`: **321 tests passed, 3 skipped**, across 41 passing test files and one skipped file. The original harness/client subset contains 49 passing tests. `npm run build` passed. The live report evaluates seven shared cases without injecting expected choices into model input. Both frameworks passed six; the same contextual follow-up failed in both. Current verification and additional hardening cases are recorded in [the hardening report](PI_HARNESS_HARDENING.md#verification).

### Important semantic finding

After `打开书房射灯`, D1 selected the correct close action for `关一下` with a plan score of approximately `0.961`. There was no scope block: the focused target was successfully retrieved. However, the independent purpose question scored immediate control at approximately `0.578`, versus no-write at `0.391` (margin `0.187`). The existing gate requires `0.65` and margin `0.20`; it therefore asked for clarification.

This isolates a conflict between the **candidate decision and independent purpose gate**, not loss of framework context. No threshold was lowered. The next semantic experiment should clarify current-turn intent and safe cancellation in a shared decision contract, then test short follow-ups, negative instructions, queries, multi-room ambiguity, and stale context as a regression matrix. A score is not calibrated execution-success probability.

State-query success in this report means correct read-only routing with no actions, not quality of a natural-language response. D1 is not a general conversational answer generator.

## Initial Performance

The initial fixture benchmark alternates runtime order, excludes three warm-ups, and measures 30 calls per framework. It includes validation, memory execution/readback, and SQLite persistence, but no model latency. See the preserved [initial fixture samples](reports/harness-fixture.json) and [initial native D1 results](reports/harness-local-d1.json). The current benchmark uses 100 samples and the shared atomic recovery contract; see [the hardening report](PI_HARNESS_HARDENING.md).

| Measurement | Pi Agent Core | LangGraph JS |
| --- | ---: | ---: |
| Fixture p50, 30 samples | 2.05 ms | 4.91 ms |
| Fixture p95, 30 samples | 2.91 ms | 11.07 ms |
| Native D1 median, 7 cases | 59.10 ms | 64.05 ms |
| Native semantics | 6/7 | 6/7 |
| D1 requests per case | 1 | 1 |

The first native request includes model cold-start overhead and the seven-case sample is too small for an SLA. Typical warm calls were tens of milliseconds on this LAN, well below the original two-second goal in this narrow simulation. Do not interpret that as a guarantee for voice input/output or actual HA device convergence.

The Pi adapter is 76 lines versus LangGraph's 35 lines; the shared safety/business kernel is counted separately. LOC is an integration-complexity signal, not a framework-wide quality metric. LangGraph's checkpoint overhead is a few milliseconds, not a reason to weaken persistence or safety.

## Initial Boundaries

These describe the baseline, not all current limitations. Single-host ownership, atomic result/context commits, checkpoint repair, and bounded Pi sessions/results are now implemented; see [current remaining gates](PI_HARNESS_HARDENING.md#remaining-gates). External-effect uncertainty, product integration, long-term operation, and intent quality remain open.

- No production UI/API integration, real-device testing, general conversation generation, long-term preference learning, or autonomous device onboarding was added.
- Voice origin is a simulated/configured terminal mapping, not detection from occupancy sensors. Production must authenticate terminals; caller-supplied room IDs and UI selection are not location evidence.
- One runtime owns its household. Concurrency is rejected rather than queued. Cross-process household ownership/leases and concurrent different-command execution are not solved here.
- Ledger and framework checkpoints are separate transactions. A crash after an effect or before checkpoint/result completion can leave an unknown request or missing latest conversation turn. The safe default is no automatic replay, not an exactly-once claim for real HA calls.
- Completed IDs and per-session databases are not garbage-collected in this spike. They need bounded retention and recovery UX before deployment.
- A state change after the final snapshot check remains possible in a real provider. The production path needs provider-specific freshness, idempotency, and reconciliation contracts.
- `npm audit` reported 11 existing findings (including a critical `proxy-addr` advisory). All affected package versions match the branch's original lockfile; no baseline package version was upgraded. Dependency remediation remains a separate release gate; passing functional tests is not a security clearance.
