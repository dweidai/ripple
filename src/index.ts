import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MultiAgentBridge } from './agents/bridge.js';
import { AuthService } from './auth.js';
import { RippleEngine } from './engine.js';
import { createRippleHttpServer } from './server.js';
import type { Store } from './store/interface.js';
import { MemoryStore } from './store/memory.js';
import { PostgresStore } from './store/postgres.js';

const PORT = Number(process.env.PORT ?? 8787);
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const WORKSPACE_ID = process.env.RIPPLE_WS_ID ?? 'ws_default';

const dir = path.dirname(fileURLToPath(import.meta.url));
const defaultStateFile = path.resolve(dir, '../.ripple-data/state.json');
const STATE_FILE = process.env.RIPPLE_STATE_FILE ?? defaultStateFile;

async function main() {
  const store: Store = DATABASE_URL
    ? new PostgresStore(DATABASE_URL)
    : new MemoryStore(STATE_FILE);
  await store.init();
  await store.ensureWorkspace(WORKSPACE_ID, 'Ripple Workspace');

  const auth = new AuthService(store);
  const engine = new RippleEngine(store);

  // Bootstrap starter tokens if none exist yet (or using env-provided fixed tokens)
  const existingTokens = await store.listTokens(WORKSPACE_ID);
  if (existingTokens.length === 0) {
    const human = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'you',
      actorName: 'David (@dweidai)',
      kind: 'human',
      roles: ['lead', 'reviewer'],
      avatarColor: '#3fb950',
      bio: 'Workspace Lead & Reviewer (@dweidai)',
      statusText: 'Online · Lead & Reviewer',
      rawToken: process.env.RIPPLE_HUMAN_TOKEN || 'rpl_human_dev_token',
    });
    const agy = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'agy',
      actorName: 'Antigravity (@agy)',
      kind: 'agent',
      sponsorHuman: 'you',
      roles: ['engineer'],
      avatarColor: '#58a6ff',
      bio: 'Lead Engineering & Architecture Agent · Spawns GitHub PR sub-agents',
      capabilities: ['github', 'subagents', 'code', 'mcp'],
      statusText: 'Online · Listening via Bridge',
      rawToken: process.env.RIPPLE_AGY_TOKEN || 'rpl_agy_dev_token',
    });
    const muse = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'muse',
      actorName: 'Muse (@muse)',
      kind: 'agent',
      sponsorHuman: 'you',
      roles: ['strategist'],
      avatarColor: '#bc8cff',
      bio: 'Product, Research & Strategy Lead · Spawns Google Drive & Docs sub-agents',
      capabilities: ['gdrive', 'gdocs', 'subagents', 'strategy', 'mcp'],
      statusText: 'Online · Listening via Bridge',
      rawToken: process.env.RIPPLE_MUSE_TOKEN || 'rpl_muse_dev_token',
    });
    const openclaw = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'openclaw',
      actorName: 'OpenClaw',
      kind: 'agent',
      sponsorHuman: 'you',
      avatarColor: '#d29922',
      capabilities: ['flows', 'triage'],
      statusText: 'Idle · Flow Worker',
      rawToken: process.env.RIPPLE_OPENCLAW_TOKEN || 'rpl_openclaw_dev_token',
    });
    const grok = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'grok',
      actorName: 'Grok Bot',
      kind: 'agent',
      sponsorHuman: 'you',
      avatarColor: '#f778ba',
      capabilities: ['webhooks', 'review'],
      statusText: 'Idle · Webhook Guard',
      rawToken: process.env.RIPPLE_GROK_TOKEN || 'rpl_grok_dev_token',
    });

    // Seed starter backlog + flows on fresh workspace
    await engine.createItem(human.principal, {
      title: 'Add full-text search index',
      body: 'Use Postgres tsvector GIN index for workspace search.',
      priority: 'P0',
      assigneeId: 'agy',
      tags: ['database', 'search'],
    });
    await engine.createItem(human.principal, {
      title: 'Rate-limit inbound webhooks',
      body: 'Protect /api/v1/flows/:id/trigger with token-bucket rate limit.',
      priority: 'P1',
      assigneeId: 'you',
      tags: ['security', 'api'],
    });
    await engine.createFlow(human.principal, {
      name: 'Nightly triage',
      triggerKind: 'cron',
      triggerSpec: '0 2 * * *',
      agentId: 'openclaw',
      steps: [
        { title: 'Scan new issues & PRs' },
        { title: 'Label & prioritize' },
        { title: 'Gate: Escalate P0 regressions', kind: 'gate' },
      ],
      retryMax: 2,
    });
    await engine.createFlow(human.principal, {
      name: 'PR size guard',
      triggerKind: 'webhook',
      triggerSpec: 'github.pull_request.opened',
      agentId: 'grok',
      steps: [{ title: 'Check diff size & test coverage' }],
      retryMax: 1,
    });

    console.log('\n[ripple] Bootstrapped workspace tokens:');
    console.log(`  Human UI (David @dweidai) : ${human.rawToken}`);
    console.log(`  Antigravity (@agy)        : ${agy.rawToken}`);
    console.log(`  Muse (@muse)              : ${muse.rawToken}`);
    console.log(`  OpenClaw                  : ${openclaw.rawToken}`);
    console.log(`  Grok bot                  : ${grok.rawToken}\n`);
  }

  // Start the live autonomous Multi-Agent & Sub-Agent Bridge for Antigravity (@agy) and Muse (@muse)
  const bridge = new MultiAgentBridge(engine, auth, {
    wsId: WORKSPACE_ID,
    enabled: process.env.RIPPLE_BRIDGE_DISABLED !== '1',
    executeRealTools: process.env.RIPPLE_MOCK_TOOLS !== '1',
  });
  bridge.start();

  // Background liveness & card expiry sweeper (every 15s)
  const sweeper = setInterval(() => {
    engine.sweepLiveness(WORKSPACE_ID).catch((e) => console.error('[ripple] liveness sweep error:', e));
    engine.sweepExpiredCards(WORKSPACE_ID).catch((e) => console.error('[ripple] expiry sweep error:', e));
  }, 15_000);

  const server = createRippleHttpServer(engine, auth, PUBLIC_URL, bridge);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[ripple] Control plane listening on ${PUBLIC_URL} (port ${PORT})`);
    console.log(`[ripple] Storage : ${DATABASE_URL ? 'Postgres' : `File-backed MemoryStore (${STATE_FILE})`}`);
    console.log(`[ripple] Bridge  : Antigravity (@agy) & Muse (@muse) active with gh/gdrive/gdocs sub-agents`);
    console.log(`[ripple] MCP     : ${PUBLIC_URL}/mcp`);
    console.log(`[ripple] Web UI  : ${PUBLIC_URL}/`);
  });

  const shutdown = async () => {
    clearInterval(sweeper);
    bridge.stop();
    server.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

