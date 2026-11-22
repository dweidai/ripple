---
name: ripple-worker
description: Collaborate with humans and other agents on a Ripple (Runs with Gates) control plane via REST or CLI. Use when claiming backlog items, reporting live plans, polling checkpoints for steers, running flows, or asking pin-bound approval cards.
---

# Ripple Worker Skill (OpenClaw)

Environment variables required:
- `RIPPLE_URL` — e.g. `https://ripple.yourdomain.com`
- `RIPPLE_TOKEN` — your OpenClaw sponsor-scoped token (`rpl_openclaw_...`)

## Standard Loop
1. **Check work:** `GET $RIPPLE_URL/api/v1/items` (or `ripple items`).
2. **Claim item:** `POST $RIPPLE_URL/api/v1/items/:id/claim` → save `run_id` and `epoch` (`1`).
3. **Post Plan v1 immediately** (before doing heavy work):
   `POST $RIPPLE_URL/api/v1/runs/:run_id/plan` with `{ "epoch": 1, "steps": [...], "touches": [...] }`.
4. **Heartbeat & Checkpoint on every OpenClaw tick:**
   - Call `POST $RIPPLE_URL/api/v1/runs/:run_id/checkpoint` with `{ "epoch": <e>, "afterStep": <n> }`.
   - If `steers[]` is non-empty:
     1. Acknowledge each steer via `POST $RIPPLE_URL/api/v1/steers/:steer_id/ack` (`{ "accepted": true, "note": "..." }`).
     2. Post the revised plan (`plan` bumps `planVersion`).
   - During long steps (>45s), send `POST $RIPPLE_URL/api/v1/runs/:run_id/heartbeat` and check `urgentSteers[]`.
5. **Gate decisions (never ask in free-form chat):**
   - Attach the commit/artifact first via `POST $RIPPLE_URL/api/v1/runs/:run_id/artifacts` so the pin is current.
   - Raise a Card via `POST $RIPPLE_URL/api/v1/runs/:run_id/cards`.
   - Wait for the typed answer via `GET $RIPPLE_URL/api/v1/cards/:card_id/await?timeout_ms=25000` (repeat on timeout; `await` counts as a heartbeat).
6. **Fencing rule:** If any call returns `HTTP 409` with `"error": "fenced"`, **stop immediately** — a human took over or the run was resumed under a higher epoch.
