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

async function main() {
  const store: Store = DATABASE_URL ? new PostgresStore(DATABASE_URL) : new MemoryStore();
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
      actorName: 'You',
      kind: 'human',
      roles: ['lead', 'reviewer'],
      rawToken: process.env.RIPPLE_HUMAN_TOKEN || 'rpl_human_dev_token',
    });
    const agy = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'agy',
      actorName: 'Antigravity (agy)',
      kind: 'agent',
      sponsorHuman: 'you',
      rawToken: process.env.RIPPLE_AGY_TOKEN || 'rpl_agy_dev_token',
    });
    const openclaw = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'openclaw',
      actorName: 'OpenClaw',
      kind: 'agent',
      sponsorHuman: 'you',
      rawToken: process.env.RIPPLE_OPENCLAW_TOKEN || 'rpl_openclaw_dev_token',
    });
    const grok = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'grok',
      actorName: 'Grok Bot',
      kind: 'agent',
      sponsorHuman: 'you',
      rawToken: process.env.RIPPLE_GROK_TOKEN || 'rpl_grok_dev_token',
    });
    const muse = await auth.mintToken({
      wsId: WORKSPACE_ID,
      actorId: 'muse',
      actorName: 'Muse',
      kind: 'agent',
      sponsorHuman: 'you',
      rawToken: process.env.RIPPLE_MUSE_TOKEN || 'rpl_muse_dev_token',
    });

    // Seed starter backlog + flows on fresh workspace
    await engine.createItem(human.principal, {
      title: 'Add full-text search index',
      body: 'Use Postgres tsvector GIN index for workspace search.',
      priority: 'P0',
    });
    await engine.createItem(human.principal, {
      title: 'Rate-limit inbound webhooks',
      body: 'Protect /api/v1/flows/:id/trigger with token-bucket rate limit.',
      priority: 'P1',
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
    console.log(`  Human UI : ${human.rawToken}`);
    console.log(`  agy      : ${agy.rawToken}`);
    console.log(`  OpenClaw : ${openclaw.rawToken}`);
    console.log(`  Grok bot : ${grok.rawToken}`);
    console.log(`  Muse     : ${muse.rawToken}\n`);
  }

  // Background liveness & card expiry sweeper (every 15s)
  const sweeper = setInterval(() => {
    engine.sweepLiveness(WORKSPACE_ID).catch((e) => console.error('[ripple] liveness sweep error:', e));
    engine.sweepExpiredCards(WORKSPACE_ID).catch((e) => console.error('[ripple] expiry sweep error:', e));
  }, 15_000);

  const server = createRippleHttpServer(engine, auth, PUBLIC_URL);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[ripple] Control plane listening on ${PUBLIC_URL}`);
    console.log(`[ripple] Storage : ${DATABASE_URL ? 'Postgres' : 'In-memory (set DATABASE_URL for Postgres)'}`);
    console.log(`[ripple] MCP     : ${PUBLIC_URL}/mcp`);
    console.log(`[ripple] Web UI  : ${PUBLIC_URL}/`);
  });

  const shutdown = async () => {
    clearInterval(sweeper);
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
