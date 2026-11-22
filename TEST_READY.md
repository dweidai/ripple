# E2E Test Suite Readiness Report (`TEST_READY.md`)

## 1. Test Execution Command

```bash
npx tsx --test tests/e2e.test.ts
```

*(Or equivalently: `node --import tsx --test tests/e2e.test.ts`)*

---

## 2. Test Suite Inventory & Coverage Summary

- **Test Suite File**: `/home/antigravity/dweidai/ripple/tests/e2e.test.ts`
- **Test Infrastructure & Matrix**: `/home/antigravity/dweidai/ripple/TEST_INFRA.md`
- **Total E2E Test Cases**: 33 tests across Tiers 1, 2, 3, and 4
- **Feature Inventory Coverage**: 17 / 17 features (100%) from `PROJECT.md § Feature Inventory`

### Tier Breakdown

| Tier | Scope | Test Cases | Surfaces Exercised |
|------|-------|------------|--------------------|
| **Tier 1 — Feature Coverage** | All 17 features in `PROJECT.md § Feature Inventory` (Happy Path) | `T1-F01` through `T1-F17` (17 tests) | HTTP REST (`/api/v1/*`, `/bootstrap`, `/w/:wsId/agent.md`, `/healthz`), Streamable HTTP MCP (`/mcp` — all 18 tools), CLI (`src/cli.ts`), Web UI (`GET /`) |
| **Tier 2 — Boundary & Corner Cases** | Auth (`401`), RBAC (`403`), Claim Mutex (`409 taken`), Epoch Fencing (`409 fenced`), CAS Pin Staling (`409 stale`, `409 already_answered`), Wait Cycle Deadlock (`409 cycle`), Dialogue `hopCount` Anti-Loop, Sub-Run Max Depth (`depth <= 3`), Missing Resources (`404`) & Invalid States (`400`) | `T2-01` through `T2-09` (9 tests) | HTTP REST, SSE (`/api/v1/events`), Streamable HTTP MCP (`/mcp`) |
| **Tier 3 — Cross-Feature Combinations** | Dialogue-to-Steer Checkpoint Delivery (`T3-C01`), Sub-Run Report -> Artifact Attachment + Backlog Auto-Completion + Thread Broadcast (`T3-C02`), Real-Time SSE Replay (`Last-Event-ID`/`?after=0`) across MCP & REST (`T3-C03`), `Idempotency-Key` Deduplication (`T3-C04`) | `T3-C01` through `T3-C04` (4 tests) | HTTP REST, Streamable HTTP MCP, SSE Stream |
| **Tier 4 — Real-World Application Scenarios** | **Scenario 1 (`T4-S01`)**: Complete Overnight Phone Journey (Self-presence, inviting `agy` & `muse`, doorway discovery, multi-agent dialogue, backlog decomposition, spawning `muse-sub-drive` & `agy-sub-pr` with Google Doc & GitHub PR artifacts, pin-bound phone approval)<br>**Scenario 2 (`T4-S02`)**: Multi-Agent Claim Contention, Resource Overlap (`touches[]`), Mid-Flight Steer & Stale Card Replacement Race<br>**Scenario 3 (`T4-S03`)**: Flow Stall Auto-Retry (`epoch: 2`), Zombie Fencing & Deduped Escalation Card | `T4-S01` through `T4-S03` (3 tests) | Full Multi-Actor End-to-End (Human Phone Client + `agy` + `muse` + Sub-Agents `agy-sub-pr` & `muse-sub-drive` across REST, MCP, and Doorway) |

---

## 3. Feature-to-Test Traceability Matrix

| # | Feature (`PROJECT.md § Feature Inventory`) | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
|---|-------------------------------------------|--------|--------|--------|--------|
| 1 | Public Non-Local HTTPS Workspace Endpoint | `T1-F01` | `T2-01` | `T3-C03` | `T4-S01` |
| 2 | Human Self-Presence & Live Participant Roster | `T1-F02` | `T2-01` | — | `T4-S01` |
| 3 | Self-Service Agent Invite & Token Minting (`agy`, `muse`, custom) | `T1-F03` | `T2-02` | — | `T4-S01` |
| 4 | Self-Describing Doorway & Agent Guide (`/bootstrap` & `/w/:wsId/agent.md`) | `T1-F04` | — | — | `T4-S01` |
| 5 | Workspace & Scoped Multi-Agent Dialogue (`threads`) | `T1-F05` | `T2-07` | `T3-C01`, `T3-C03` | `T4-S01`, `T4-S02` |
| 6 | Shared Context Snapshot & Multi-Agent Orchestrator Bridge | `T1-F06` | — | — | `T4-S01` |
| 7 | Sub-Agent Spawning & Hierarchical Child Runs (`spawn_subrun`) | `T1-F07` | `T2-08`, `T2-09` | `T3-C02` | `T4-S01` |
| 8 | Sub-Agent GitHub PR Integration (`gh` CLI) | `T1-F08` | — | `T3-C02` | `T4-S01` |
| 9 | Sub-Agent Google Drive & Docs Integration (`gdrive` & `gdocs` CLIs) | `T1-F09` | — | `T3-C02` | `T4-S01` |
| 10 | Collaborative Backlog & Subtask Management (Human + Agent CRUD) | `T1-F10` | `T2-09` | `T3-C02`, `T3-C04` | `T4-S01` |
| 11 | Atomic Claim & Single-Writer Run Mutex | `T1-F11` | `T2-03`, `T2-09` | `T3-C04` | `T4-S01`, `T4-S02` |
| 12 | Versioned Plan & Resource Overlap Detection (`touches[]`) | `T1-F12` | `T2-04` | — | `T4-S02` |
| 13 | Durable Mid-Flight Steers & Idempotent Acks | `T1-F13` | `T2-09` | `T3-C01` | `T4-S02` |
| 14 | Pin-Bound Decision Cards, Auto-Staling & Blocking `await` | `T1-F14` | `T2-02`, `T2-05`, `T2-06` | — | `T4-S01`, `T4-S02` |
| 15 | Epoch Fencing (`takeover`, `cancel`, `resume`) & Liveness Sweeper | `T1-F15` | `T2-04`, `T2-09` | — | `T4-S03` |
| 16 | Flow Templates & 14-Run Health Strip | `T1-F16` | `T2-09` | — | `T4-S03` |
| 17 | Phone-First Responsive & Desktop Web UI (`public/index.html`) | `T1-F17` | — | — | `T4-S01` |
