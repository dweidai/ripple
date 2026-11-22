# Ripple — Runs with Gates

**Every piece of agent work is a live, steerable Run; every human decision is a one-click Card pinned to the exact state it approves.**

Ripple is a lightweight control plane (REST + SSE + Remote Streamable HTTP MCP + Web UI) built on **state parity, not surface parity**: humans get a live timeline, one-click pin-bound Cards, and a Flow lane; agents (`agy`, OpenClaw, Grok, Muse, or any custom harness) get typed tools with epoch fencing, checkpoint steering, and blocking `await()`.

## Quickstart (Local, zero-config)
```bash
npm install
npm run build
npm start
# Open http://localhost:8787 (default dev token: rpl_human_dev_token)
```

## Hosting (Production)

### Option A — Fly.io (Recommended, ~$5–10/mo)
```bash
fly launch --copy-config --no-deploy
fly postgres create --name ripple-db
fly postgres attach ripple-db
fly secrets set \
  PUBLIC_URL=https://<your-app>.fly.dev \
  RIPPLE_HUMAN_TOKEN=$(openssl rand -hex 24) \
  RIPPLE_AGY_TOKEN=$(openssl rand -hex 24) \
  RIPPLE_OPENCLAW_TOKEN=$(openssl rand -hex 24) \
  RIPPLE_GROK_TOKEN=$(openssl rand -hex 24) \
  RIPPLE_MUSE_TOKEN=$(openssl rand -hex 24)
fly deploy
```

### Option B — Self-hosted VPS (Docker Compose + Caddy/Tailscale)
```bash
cp .env.example .env   # edit tokens & PUBLIC_URL
docker compose up -d
```

## Connecting Your Agents
* **Antigravity (`agy`) & Muse:** Add the Remote MCP endpoint from [`connectors/antigravity-mcp.json`](./connectors/antigravity-mcp.json) (`https://ripple.yourdomain.com/mcp` + Bearer token).
* **OpenClaw:** Copy [`connectors/openclaw/SKILL.md`](./connectors/openclaw/SKILL.md) into your OpenClaw skills directory and set `RIPPLE_URL` + `RIPPLE_TOKEN`.
* **Grok bot:** Load [`connectors/grok/tools.json`](./connectors/grok/tools.json) into your xAI function-calling `tools` array and dispatch with [`connectors/grok/example.ts`](./connectors/grok/example.ts).
* **CLI (`ripple`):** `RIPPLE_URL=... RIPPLE_TOKEN=... node dist/cli.js whoami`

## Core Safety Guarantees
1. **Epoch fencing (`409 fenced`):** Takeover, cancel, or resume bumps `run.epoch`; stale-epoch writes from zombie agents are rejected.
2. **Pin CAS (`409 stale`):** Answering a Card requires matching the current subject fingerprint; pushing a new commit/artifact invalidates the old Card and auto re-asks on the new pin.
3. **Durable steers + idempotent acks:** Human steers queue safely and deliver at `checkpoint()` (or `heartbeat()` when `urgency: "now"`).
4. **Deadlock-free blocking (`409 cycle`):** Wait-for cycles between blocking agent Cards are rejected server-side.
5. **Fast liveness (≤3 min):** Heartbeat sweeper detects stalls, auto-retries Flows under `epoch + 1`, and escalates once via dedupe key.
