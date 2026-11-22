# Project: Ripple ("Runs with Gates" — Hosted Multi-Agent Collaborative Workspace)

## Architecture
Ripple is a collaborative Human + Multi-Agent Control Plane built with Node 22, TypeScript, Hono (REST + SSE), Streamable HTTP MCP (`/mcp`), a CLI (`ripple`), an in-repo Autonomous Multi-Agent & Sub-Agent Bridge Daemon (`src/agents/`), file-backed + Postgres storage (`src/store/`), and a responsive phone-first + desktop Web UI (`public/index.html`), exposed at a live public HTTPS URL (`https://*.trycloudflare.com`) via Cloudflare Quick Tunnel (`cloudflared`).

### Module Boundaries & Data Flow
1. **Core Domain, Storage & Engine (`src/types.ts`, `src/errors.ts`, `src/auth.ts`, `src/store/*`, `db/migrations/001_init.sql`, `src/engine.ts`)**:
   - **Identity & Presence**: `Principal` (`actorId`, `actorName`, `kind: 'human' | 'agent'`, `roles`, `parentAgentId?`, `avatarColor?`, `bio?`, `capabilities?`, `lastSeenAt?`, `statusText?`, `online?`). Default human principal reflects the user (`actorId: 'you'`, `actorName: 'David (@dweidai)'` or customizable via `PATCH /api/v1/me`).
   - **Backlogs & Tasks (`Item`)**: `id, wsId, title, body, priority, version, status ('open' | 'active' | 'done' | 'dropped'), createdBy, assigneeId?, parentItemId?, tags: string[], linkedRunId?, resultUrl?, createdAt, updatedAt`. Supports full CRUD (`createItem`, `updateItem`).
   - **Hierarchical Runs & Sub-Agents (`Run`)**: `id, wsId, itemId, flowId, agentId, epoch, status, planVersion, touches, subjectPin, parentRunId?, parentStepIdx?, title?, goal?, reportSummary?, reportData?, depth: number, startedAt, heartbeatAt, endedAt`. Supports `spawnSubrun` (creating child runs under a parent run/agent up to depth 3, optionally minting/registering sub-agent principal `agy-sub-*` / `muse-sub-*`) and `reportRun` (recording sub-agent completion summary, attaching artifacts, updating linked item, and posting report message to parent run thread and workspace dialogue).
   - **Multi-Agent Dialogue & Shared Context (`ThreadMessage`, `WorkspaceContext`)**: `ThreadMessage` includes `actorId, author, body, mentions: string[], replyToId?, runId?, itemId?, hopCount: number, createdAt`. Supports `scopeKind: 'workspace' | 'run' | 'step' | 'card'`, automatic `@mention` extraction (`@agy`, `@muse`, `@you`, `@all`), anti-loop `hopCount` tracking (max consecutive agent-to-agent turns without human input or task state transition = 4), and `getContext()` returning complete workspace situational awareness (whoami, participants/presence, recent workspace dialogue, active parent & child runs, open/active backlog tasks, open cards, and recent artifacts).
   - **Persistence**: `MemoryStore` enhanced with optional file-backed JSON snapshot persistence (`RIPPLE_STATE_FILE` / `.ripple-data/state.json`) so all tokens, backlog items, runs, sub-runs, dialogue messages, and artifacts survive restarts, plus `PostgresStore` migration compatibility.

2. **REST API, Streamable HTTP MCP Server & CLI (`src/server.ts`, `src/mcp.ts`, `src/cli.ts`, `connectors/*`)**:
   - **Dynamic Public URL & Phone Auto-Login**: Infers `publicUrl` from `PUBLIC_URL` or request `X-Forwarded-Proto` + `X-Forwarded-Host` / `Host` headers so `/bootstrap`, `/w/:wsId/agent.md`, and invite modals always output the live `https://*.trycloudflare.com` URL. Supports `?token=` query parameter login and `/api/v1/demo-tokens` (or bootstrap starter info) for seamless 1-tap phone onboarding.
   - **Self-Service Agent Invitation (`POST /api/v1/invites`, `POST /api/v1/tokens`, `DELETE /api/v1/tokens/:actorId`, `GET /w/:wsId/agent.md`)**: Allows the human to invite/re-invite **Antigravity (`agy`)**, **Muse (`muse`)**, sub-agents, or custom agents, returning `{ rawToken, principal, onboarding: { mcpJson, cliCommand, doorwayPrompt, bootstrapCurl } }`.
   - **REST Endpoints**:
     - `GET /api/v1/whoami`, `PATCH /api/v1/me` (update human/actor display name, statusText, bio, avatarColor)
     - `GET /api/v1/snapshot` (includes `whoami`, `agents` with live presence, `items`, `runs`, `steps`, `cards`, `flows` with 14-run history, `artifacts`, `steers`, and `messages` for workspace dialogue)
     - `GET /api/v1/context` (structured multi-agent context bundle)
     - `POST /api/v1/invites`, `POST /api/v1/tokens`, `DELETE /api/v1/tokens/:actorId`
     - `GET /api/v1/items`, `POST /api/v1/items`, `PATCH /api/v1/items/:id`, `POST /api/v1/items/:id/claim`
     - `GET /api/v1/runs`, `GET /api/v1/runs/:id`, `POST /api/v1/runs/:id/subruns`, `POST /api/v1/runs/:id/report`, plus existing `/plan`, `/step`, `/artifacts`, `/checkpoint`, `/heartbeat`, `/steers`, `/takeover`, `/cancel`, `/resume`, `/cards`
     - `GET /api/v1/threads/:scopeKind/:scopeId`, `POST /api/v1/threads/:scopeKind/:scopeId`
     - `POST /api/v1/integrations/github/pr`, `POST /api/v1/integrations/drive` (direct & sub-agent tool endpoints for real `gh`, `gdrive`, `gdocs` operations)
   - **18 MCP Tools (`src/mcp.ts`)**:
     - Existing 10: `ripple_list_items`, `ripple_claim`, `ripple_plan`, `ripple_step`, `ripple_artifact`, `ripple_checkpoint`, `ripple_heartbeat`, `ripple_ack`, `ripple_ask`, `ripple_await`
     - New 8: `ripple_get_context`, `ripple_create_item`, `ripple_update_item`, `ripple_post_message`, `ripple_read_messages`, `ripple_spawn_subrun`, `ripple_report_run`, `ripple_answer_card`
   - **CLI Commands (`src/cli.ts`)**: Full parity including `whoami`, `me`, `invite`, `context`, `items`, `new-item`, `update-item`, `claim`, `plan`, `step`, `spawn-subrun`, `report`, `checkpoint`, `heartbeat`, `ack`, `ask`, `answer`, `await`, `artifact`, `chat`, `messages`, `flows`, `trigger`.

3. **Autonomous Multi-Agent Bridge & Sub-Agent Execution Engine (`src/agents/bridge.ts`, `src/agents/tools.ts`, `src/index.ts`)**:
   - Active event-driven runtime powering invited **Antigravity (`agy`)** and **Muse (`muse`)** agents (and their dynamically spawned sub-agents `agy-sub-*`, `muse-sub-*`) in real time:
     - **Context-Aware Multi-Agent Dialogue**: When the user (or peer agent) posts in the workspace dialogue or run thread (or invites/activates `agy` and `muse`), `agy` (Engineering & Architecture Lead) and `muse` (Product, Research & Strategy Lead) read the full workspace context (`engine.getContext`), converse cleanly with the user and with each other (`@muse`, `@agy`), reference real repo state, Drive docs, runs, and tasks, and obey the `hopCount` anti-loop protocol.
     - **Collaborative Backlog & Task Sync**: `agy` and `muse` autonomously create, decompose (`parentItemId`), assign (`assigneeId`), claim, and update backlog items and tasks so the human and agents can track everything across UI/API/MCP/CLI.
     - **Sub-Agent Spawning with Real `gh`, `gdrive`, and `gdocs` Execution**:
       - `agy` and `muse` spawn child runs (`spawnSubrun`) for specialized sub-agents (`agy-sub-pr`, `agy-sub-code`, `muse-sub-drive`, `muse-sub-docs`).
       - **GitHub PR Sub-Agent (`gh`)**: Uses `/opt/antigravity/bin/gh` and isolated git branch/worktree or GitHub API on `https://github.com/dweidai/ripple` to create/inspect real branches, commits, and Pull Requests (`gh pr create` / `gh pr list` / `gh pr view`), attaches the real PR URL and commit SHA as pin-bound Ripple `Artifact`s (`kind: 'pr'`, `kind: 'commit'`), raises a pin-bound Review/Approve `Card` for the user, and reports back (`reportRun`).
       - **Google Drive & Docs Sub-Agent (`gdrive`, `gdocs`)**: Uses `/opt/antigravity/bin/gdrive` and `/opt/antigravity/bin/gdocs` to list/search/read Google Drive files and create/append real Google Docs (`gdocs mutate create`, `gdocs mutate append`, `gdrive readonly search/ls`), attaches the real `https://docs.google.com/document/d/...` / Drive URLs as Ripple `Artifact`s (`kind: 'gdoc' | 'drive' | 'url'`), and reports structured findings back to the parent run and workspace dialogue.

4. **Phone-First Responsive & Desktop Web UI (`public/index.html`)**:
   - **"See Myself" Identity Header & Presence Roster**: Prominent user identity badge (`David (@dweidai)` / customizable display name & status via inline Profile Modal), online indicator, Actor/View Switcher (`You`, `Antigravity`, `Muse`), QR/Shareable Phone Link generator (with `?token=` auto-login), and `+ Invite Agent` CTA.
   - **Self-Service Invite Modal**: 1-tap presets to invite **Antigravity (`agy`)**, **Muse (`muse`)**, **Sub-Agent**, or custom collaborator; generates & copies live Remote MCP JSON (`https://*.trycloudflare.com/mcp`), Doorway Prompt (`https://*.trycloudflare.com/w/ws_default/agent.md?token=...`), and CLI commands; shows live agent online/working status.
   - **Multi-Agent Workspace Dialogue & Scoped Threads**: Dedicated Workspace Dialogue room (`scopeKind: 'workspace', scopeId: 'main'`) + Run-scoped thread toggle, quick `@agy`, `@muse`, `@all` mention pills, "Send as steer" option, and non-destructive DOM updates (preserving input focus, typing state, and scroll position on SSE events).
   - **Hierarchical Run & Sub-Agent Tree**: Visualizes parent Runs and indented child Sub-Runs (`parentRunId`), step progress, inline Steer modal (zero browser `prompt()`/`confirm()`), epoch fencing controls, sub-agent report cards, and clickable external badges for GitHub PRs (`kind: 'pr'`), Google Docs (`kind: 'gdoc'`), and Google Drive files (`kind: 'drive'`).
   - **Backlog & Tasks Board**: Filter tabs (`All`, `My Tasks`, `Agent Tasks`, `Done`), subtask hierarchy (`parentItemId`), assignee badges (`you`, `agy`, `muse`, sub-agents), priority badges (`P0`–`P2`), tags (`github`, `drive`, `spec`, `code`), inline task creation/editing modal, and 1-tap "Dispatch to Agy / Muse" action.
   - **Mobile Bottom Navigation Bar (`<= 768px`)**: Touch-ergonomic bottom tabs (`Dialogue`, `Runs & Sub-agents`, `Backlog`, `Decisions [badge]`, `Agents & Invite`) plus 3-column command center on desktop.

## Feature Inventory
Every Survey feature assigned a milestone (none unassigned).
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Public Non-Local HTTPS Workspace Endpoint | Serve Ripple on an externally reachable HTTPS URL (`cloudflared` tunnel `https://*.trycloudflare.com`) with dynamic `publicUrl` detection, `?token=` phone auto-login, and file-backed state persistence. | M1 | survey |
| 2 | Human Self-Presence & Live Participant Roster | Display logged-in human ("You" / `David (@dweidai)`) with editable profile (`PATCH /api/v1/me`), role badges, and real-time `lastSeenAt` / `online` / `statusText` presence for humans, agents (`agy`, `muse`), and sub-agents. | M1 | survey |
| 3 | Self-Service Agent Invite & Token Minting (`agy`, `muse`, custom) | Invite Antigravity (`agy`), Muse (`muse`), or custom agents from UI/CLI/REST (`POST /api/v1/invites`, `POST /api/v1/tokens`, `DELETE /api/v1/tokens/:actorId`), generating MCP JSON, CLI commands, and doorway prompts with the live public URL. | M1 | survey |
| 4 | Self-Describing Doorway & Agent Guide (`/bootstrap` & `/w/:wsId/agent.md`) | Machine- and LLM-readable bootstrap JSON and Markdown doorway guide returning caller identity, workspace URL, active roster, MCP/REST/CLI schemas, and collaboration protocol. | M1 | survey |
| 5 | Workspace & Scoped Multi-Agent Dialogue (`threads`) | Real-time workspace dialogue (`scopeKind: 'workspace', scopeId: 'main'`) and run/step/card threads with `@mention` routing (`@agy`, `@muse`, `@you`, `@all`), `hopCount` anti-loop guard, REST, MCP (`ripple_post_message`, `ripple_read_messages`), and CLI (`chat`, `messages`). | M1 | survey |
| 6 | Shared Context Snapshot & Multi-Agent Orchestrator Bridge | Unified context endpoint (`GET /api/v1/context`, MCP `ripple_get_context`, CLI `context`) and live agent coordinator enabling `agy` and `muse` to converse with each other and the user cleanly with full context awareness and zero infinite loops. | M1 | survey |
| 7 | Sub-Agent Spawning & Hierarchical Child Runs (`spawn_subrun`) | Parent agents (`agy`, `muse`) spawn sub-agents and child runs (`parentRunId`, `parentAgentId`, `depth`, `title`, `goal`) via `POST /api/v1/runs/:id/subruns`, MCP `ripple_spawn_subrun`, and CLI `spawn-subrun`, and report back via `POST /api/v1/runs/:id/report`, MCP `ripple_report_run`, and CLI `report`. | M1 | survey |
| 8 | Sub-Agent GitHub PR Integration (`gh` CLI) | Sub-agents execute real GitHub operations via `/opt/antigravity/bin/gh` (inspect repo, create branch/commit/PR on `https://github.com/dweidai/ripple`), attach clickable `kind: 'pr'` and `kind: 'commit'` Ripple `Artifact`s, raise pin-bound review `Card`s, and report back to parent run & dialogue. | M1 | survey |
| 9 | Sub-Agent Google Drive & Docs Integration (`gdrive` & `gdocs` CLIs) | Sub-agents execute real Google Drive & Docs operations via `/opt/antigravity/bin/gdrive` and `/opt/antigravity/bin/gdocs` (search/list/read Drive files, create & populate Google Docs), attach clickable `kind: 'gdoc'` and `kind: 'drive'` Ripple `Artifact`s, and report back to parent run & dialogue. | M1 | survey |
| 10 | Collaborative Backlog & Subtask Management (Human + Agent CRUD) | Humans, `agy`, `muse`, and sub-agents create, assign (`assigneeId`), decompose (`parentItemId`), tag (`tags`), claim, and update backlog items & tasks across REST (`POST /api/v1/items`, `PATCH /api/v1/items/:id`), MCP (`ripple_create_item`, `ripple_update_item`, `ripple_list_items`), CLI (`new-item`, `update-item`, `items`), and Web UI. | M1 | survey |
| 11 | Atomic Claim & Single-Writer Run Mutex | Claiming an open item opens a Run at `epoch = 1`, updates item `status = 'active'` and `linkedRunId`, and enforces single-writer mutex (`409 taken`). | M1 | survey |
| 12 | Versioned Plan & Resource Overlap Detection (`touches[]`) | Posting/updating steps and `touches[]` bumps `planVersion` and computes advisory overlap warnings across active runs and sub-runs. | M1 | survey |
| 13 | Durable Mid-Flight Steers & Idempotent Acks | Human or parent agent queues step edits/inserts/freeform steers pinned to `planVersion` (`urgency: 'normal' | 'now'`), delivered at `checkpoint`/`heartbeat` and acknowledged idempotently. | M1 | survey |
| 14 | Pin-Bound Decision Cards, Auto-Staling & Blocking `await` | Typed decision cards (`approve`, `choose`, `provide`, `review`) with CAS `onPin` verification, automatic staling on new artifact commit, agent-to-agent card answering (`ripple_answer_card`), wait-cycle detection (`409 cycle`), and blocking `await`. | M1 | survey |
| 15 | Epoch Fencing (`takeover`, `cancel`, `resume`) & Liveness Sweeper | Human takeover/cancel/resume increments `run.epoch`, fences zombie writes (`409 fenced`), withdraws open cards, and sweeps stalled runs. | M1 | survey |
| 16 | Flow Templates & 14-Run Health Strip | Recurring/manual flow templates instantiate runs in the Flow Lane and expose 14-run status history rendered as a health strip in the UI. | M1 | survey |
| 17 | Phone-First Responsive & Desktop Web UI (`public/index.html`) | Polished mobile + desktop Web UI with bottom navigation tabs on mobile, "See Myself" identity header & profile editor, Invite Agent modal (Antigravity & Muse), Workspace Dialogue room, Hierarchical Run/Sub-Agent tree, Backlog & Tasks board, Decisions Tray, and zero native `prompt()`/`confirm()` dialogs. | M1 | survey |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Full Ripple Workspace, Multi-Agent Dialogue, Sub-Agents (`gh`/`gdrive`/`gdocs`), Backlog Sync, Mobile UI & Live Tunnel Hosting | Complete full-stack implementation across `src/*`, `public/index.html`, `connectors/*`, `tests/*`, plus live `cloudflared` HTTPS hosting and live multi-agent/sub-agent PR & Drive proof | none | IN_PROGRESS |
| 2 | Final Milestone: E2E Test Suite Verification (Tiers 1-4) & Adversarial Coverage Hardening (Tier 5) + GitHub Push | Pass 100% of E2E tests (Tiers 1-4), execute Tier 5 adversarial coverage hardening, verify live hosted URL & git push to `https://github.com/dweidai/ripple` | M1 | PLANNED |

## Interface Contracts
### Core Engine (`src/engine.ts`) ↔ REST/MCP/CLI (`src/server.ts`, `src/mcp.ts`, `src/cli.ts`) ↔ Agent Bridge (`src/agents/*`) ↔ Web UI (`public/index.html`)
- `engine.updateProfile(p, patch: { actorName?: string; statusText?: string; bio?: string; avatarColor?: string }) => Promise<Principal>`
- `engine.createItem(p, input: { title: string; body?: string; priority?: number; assigneeId?: string; parentItemId?: string; tags?: string[] }) => Promise<Item>`
- `engine.updateItem(p, itemId: string, patch: { title?: string; body?: string; priority?: number; status?: ItemStatus; assigneeId?: string; parentItemId?: string; tags?: string[]; resultUrl?: string }) => Promise<Item>`
- `engine.spawnSubrun(p, parentRunId: string, input: { title: string; goal?: string; subagentId?: string; subagentName?: string; itemId?: string; parentStepIdx?: number; steps?: Array<{ title: string; kind?: StepKind }>; touches?: string[] }) => Promise<{ run: Run; steps: Step[]; subagent: Principal }>`
- `engine.reportRun(p, runId: string, input: { epoch?: number; summary: string; status?: 'done' | 'failed'; artifacts?: Array<{ kind: ArtifactKind; ref: string; title?: string; url?: string; meta?: Record<string, unknown> }> }) => Promise<{ run: Run; parentMessage?: ThreadMessage }>`
- `engine.postThreadMessage(p, input: { scopeKind: 'workspace' | 'run' | 'step' | 'card'; scopeId: string; body: string; replyToId?: string; runId?: string; itemId?: string; sendToAgent?: boolean; urgency?: SteerUrgency }) => Promise<{ message: ThreadMessage; steer?: Steer }>`
- `engine.getContext(p, opts?: { runId?: string; limit?: number }) => Promise<WorkspaceContext>`

## Code Layout
- `src/types.ts` — Core TypeScript interfaces (`Principal`, `Item`, `Run`, `Step`, `Steer`, `Pin`, `Card`, `Artifact`, `FlowTemplate`, `ThreadMessage`, `WorkspaceContext`, `RippleEvent`)
- `src/errors.ts` — Error codes and HTTP status mappings (`400`, `401`, `403`, `404`, `409`)
- `src/auth.ts` — Token minting, hashing, profile updates, revocation, and authentication
- `src/store/interface.ts`, `src/store/memory.ts`, `src/store/postgres.ts`, `db/migrations/001_init.sql` — Storage interfaces, in-memory store with file-backed JSON persistence, and Postgres store
- `src/engine.ts` — Core Ripple state machine and business logic
- `src/agents/tools.ts` & `src/agents/bridge.ts` — Real `gh`, `gdrive`, and `gdocs` CLI tool integrations and Autonomous Multi-Agent & Sub-Agent Bridge for Antigravity (`agy`) and Muse (`muse`)
- `src/server.ts` — Hono REST API, SSE `/api/v1/events`, `/bootstrap`, `/w/:wsId/agent.md`, and `/mcp` mount
- `src/mcp.ts` — Streamable HTTP MCP server exposing all 18 Ripple tools
- `src/cli.ts` — Command-line client for Ripple
- `src/index.ts` — Server entrypoint, seed data, sweeper, and integrated agent bridge startup
- `public/index.html` — Responsive mobile + desktop Web UI
- `connectors/` — Ready-to-use MCP and agent connector configs (`antigravity-mcp.json`, `muse-mcp.json`, `grok/`, `openclaw/`)
- `tests/` — Unit, integration, and E2E test suites
