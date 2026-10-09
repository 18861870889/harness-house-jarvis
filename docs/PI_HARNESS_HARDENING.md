# Pi harness hardening

## Status

This isolated experiment hardens the Pi Agent Core adaptation and applies the same business recovery contract to LangGraph JS. It does not migrate the active UI, Hermes integration, or production HA executor. All actuator calls use the simulated HCM household; optional semantic regression calls only the local D1 endpoint.

Pi is now a viable candidate for the next D1-only control-path prototype. Its lower measured overhead remains useful, but is only a few milliseconds, not evidence of better intent recognition. This report preserves the hardening baseline at commit `26872ef`. The later [intent/context v2 experiment](D1_INTENT_CONTEXT_V2.md) resolves the short-follow-up purpose contradiction in the isolated runtimes, but does not finish intent quality or migrate the product.

Pinned versions remain Pi core/AI/official SQLite backend `0.99.2`, LangGraph `1.4.21`, and LangGraph SQLite checkpointer `1.0.4`. No dependencies were added or upgraded in this hardening step.

## Recovery Contract

Framework persistence alone cannot atomically commit an external device effect and the application's result. The design follows the separation of authoritative business state and derived delivery/checkpoint state discussed in the [transactional outbox pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html). This is an outbox-inspired execution journal, not a message broker or a claim of exactly-once HA execution.

```text
Stable command ID + payload fingerprint + single writable household owner
  -> request admission
  -> authoritative bounded conversation -> one local D1 choice
  -> journal prepared decision -> framework prepared checkpoint
  -> latest HCM validation -> provider simulation
  -> durable effect_started marker
  -> simulated execution -> durable simulated world -> readback verification
  -> ONE business transaction: confirmed result + newest conversation revision
  -> framework checkpoint projection
```

The journal is SQLite WAL with `synchronous=FULL`. Pi's official database-factory hook sets `FULL` on every connection; LangGraph uses WAL/FULL and `durability: "sync"`. These are equal application recovery guarantees, not equal framework checkpoint counts or identical internal architectures. The adapters use the [official Pi Agent Core](https://github.com/earendil-works/pi/tree/main/packages/agent) and [LangGraph interrupt](https://docs.langchain.com/oss/javascript/langgraph/interrupts) APIs.

The business result and conversation are the source of truth. Framework checkpoints are repairable projections, not independent authorities:

| Failure window | Recovery behavior |
| --- | --- |
| Prepared, before any effect | The interrupted request is not automatically replayed; no device change occurred. |
| Effect started, completion not committed | Return `execution_unknown`; do not retry the actuator automatically. |
| Result and conversation committed, framework checkpoint failed | Return the confirmed outcome with `checkpointWarning`; recover the conversation from the journal. |
| Cancel arrives after business commit | Report what actually happened, not a false `cancelled` result. |
| Duplicate completed ID | Return the cached result without model inference or actuator calls. |
| Duplicate compacted ID | Return `completed_result_expired`, never treat it as a new command. |
| Same ID, different payload | Reject with `command_id_conflict`. |

A committed clarification question also survives a crash before the framework's native checkpoint. Its command ID, original input, and expiry are authoritative; a stale answer cannot target a newer question.

## Resource Bounds

- Pi's open SQLite session handles use an LRU cache, default maximum `8`; pressure tests use `4` and eviction tests use `2`.
- Persistent conversation IDs are capped at `256` by default. Capacity is checked before creating an additional framework session.
- Detailed completed results retain the newest `1,000` by default. Stable identity/fingerprint tombstones remain, so compaction cannot authorize replay.
- Request identities are capped at `50,000` by default. At capacity, new IDs are rejected rather than silently dropping deduplication history; existing IDs still receive their previous outcome.
- One process/runtime may own a directory. A live PID blocks a second owner; a dead PID allows recovery. This is single-host ownership, not a distributed lease. PID reuse can conservatively block availability.
- One operation is active per runtime, without a hidden queue. Concurrent runs, state reads, and close operations are rejected while busy.

These bounds do not make every database byte constant. Detailed data volume depends on payload size; identity tombstones grow up to the cap. LangGraph's native checkpoint history is not compacted in this experiment. Deployment still needs retention/archival operations and clear capacity/recovery UX.

## Verification

The new hardening suite contains **37 tests**, covering both runtimes unless a case is Pi-specific:

- Actual child-process `SIGKILL` after prepare, before effect, after effect, after atomic commit, and after framework projection.
- Restart recovery for confirmed results, conversation turns, clarification questions, and simulated world state, without inference/effect replay.
- Prepared-checkpoint failure (`ENOSPC` injection), completed-checkpoint failure, and actual SQLite-trigger transaction aborts.
- Result/context rollback together when the business commit fails; uncertain effects remain non-replayable.
- Cancellation before effect and after commit, and recovery on the next unrelated request.
- Dual-writer rejection, legacy schema/context migration, result compaction tombstones, and hard request/session caps.
- Pi session LRU eviction and reopening an older conversation without losing context.

At the hardening baseline, the full suite passed **358 tests, with 3 skipped**, across 42 passing test files and one skipped file. The harness/client subset had **86 passing tests**. Adapter contract tests separately passed **31 tests**. The production build passed. Current counts and native semantics are in [the v2 report](D1_INTENT_CONTEXT_V2.md#verification). Deterministic fixtures test execution and recovery mechanics, not language accuracy.

The sustained Pi probe sends 2,000 measured simulated requests over one minute, across 20 conversation IDs, plus 100 warm-up requests. Each measured request is immediately resubmitted with the same ID. Ten percent are dry runs. It checks inference/effect counts, session-handle and result-retention bounds, and samples heap/RSS after forced GC. The final run passed in 59.99 seconds: 2,100 inference calls and 1,900 simulated effect calls including warm-ups, no additional calls for duplicate IDs, at most 4 open sessions and 64 retained detailed results. Post-GC heap growth was 1,443,832 bytes (about 1.4 MiB); latency p50/p95 was 7.19/8.69 ms. Temporary SQLite/WAL storage occupied about 16.5 MB. See [raw soak data](reports/pi-hardening-soak.json). This multi-session retention workload is different from the single-session latency benchmark below.

The fixture comparison alternates runtimes, excludes 10 warm-ups, and measures 100 requests per runtime, including persistence but excluding model/network latency. See [raw comparable fixture data](reports/pi-hardening-fixture.json). The [local D1 regression](reports/pi-hardening-local-d1.json) uses seven shared cases and one native inference per case; it is not an SLA or a comprehensive semantic benchmark.

| Final measurement, Node 24.13.1 / macOS arm64 | Pi Agent Core | LangGraph JS |
| --- | ---: | ---: |
| Fixture p50, 100 measured requests | 1.75 ms | 4.25 ms |
| Fixture p95, 100 measured requests | 2.25 ms | 9.65 ms |
| Framework checkpoint writes, including 10 warm-ups | 220 | 440 |
| Native D1 median, 7 cases | 58.72 ms | 67.52 ms |
| Native semantic cases passed | 6/7 | 6/7 |
| Native inference calls per case | 1 | 1 |

These numbers describe the pinned adapters on this machine, not every possible configuration of either SDK. The native sample includes first-call effects and is too small to establish a latency distribution. Pi's bridge is 123 lines, LangGraph's adapter 60; the shared business kernel (171) and execution journal (72) are counted separately. The D1 bridge is still custom integration work even after these tests pass.

## Reproduce

Use Node `24.13.1` or a compatible Node 24 runtime. Built-in `node:sqlite` is currently experimental; the LangGraph backend also needs its normally installed native SQLite binding.

```sh
npm ci
npm run test:harness
npm run compare:harness -- --v1 --samples=100 --output=/tmp/pi-hardening-fixture.json
npm run soak:pi -- --iterations=2000 --duration-ms=60000 --output=/tmp/pi-current-soak.json
npm run compare:harness -- --v1 --live --output=/tmp/pi-hardening-local-d1.json
npm run test:adapter
npm test
npm run build
```

Only the final `--live` comparison uses the LAN D1 endpoint, configurable with `D1_ENDPOINT`. It does not load `.env` HA credentials. All device adapters remain simulated, and temporary runtime databases are deleted when the scripts finish. Comparisons default to v2; `--v1` preserves the historical decision contract. The soak uses the current default runtime, so its new output must not be treated as the historical measurements above.

## Remaining Gates

1. **Intent quality:** the later v2 contract passes `关一下` and expands contextual, query, negation and goal tests without lowering thresholds. Native strict regression remains 34/36; calibrated scores and wider unseen-language evaluation are still needed. See [current results](D1_INTENT_CONTEXT_V2.md#verification).
2. **Product integration:** add a switchable, simulation-only D1/Pi API path, recovery/capacity indicators, and conversation replay UX before changing the main default. Existing UI/server behavior is unchanged here.
3. **Operational validation:** run multi-day service tests, actual filesystem-full testing, upgrade/restart drills, and native checkpoint archival. This report covers a one-minute soak and injected storage failures, not electrical power loss or multi-day leak freedom.
4. **Real providers:** define provider-specific freshness, idempotency, and uncertain-effect reconciliation. A real HA effect cannot share the local SQLite transaction; no external exactly-once guarantee is made.
5. **Release security:** the initial comparison recorded 11 existing dependency audit findings, including a critical advisory. Versions are unchanged here; remediation remains a separate release gate. Passing these tests is not production/security clearance.
