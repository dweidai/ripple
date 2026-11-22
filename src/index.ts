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

  // Bootstrap human workspace owner if no tokens exist yet
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
      rawToken: process.env.RIPPLE_HUMAN_TOKEN,
    });

    try {
      const fs = await import('node:fs');
      const tokenPath = path.resolve(path.dirname(STATE_FILE), 'human_token.txt');
      fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
      fs.writeFileSync(tokenPath, human.rawToken + '\n', { mode: 0o600 });
    } catch {
      // ignore if read-only
    }

    console.log('\n[ripple] Bootstrapped fresh workspace (human owner only; no agents invited yet).');
    console.log(`  Human token saved to .ripple-data/human_token.txt\n`);

    if (process.env.RIPPLE_SEED_DEMO === '1') {
      await auth.mintToken({
        wsId: WORKSPACE_ID,
        actorId: 'agy',
        actorName: 'Antigravity (@agy)',
        kind: 'agent',
        sponsorHuman: 'you',
        roles: ['engineer'],
        avatarColor: '#58a6ff',
        bio: 'Lead Engineering & Architecture Agent',
        capabilities: ['github', 'subagents', 'code', 'mcp'],
        statusText: 'Online · Listening via Bridge',
        rawToken: process.env.RIPPLE_AGY_TOKEN,
      });
      await auth.mintToken({
        wsId: WORKSPACE_ID,
        actorId: 'muse',
        actorName: 'Muse (@muse)',
        kind: 'agent',
        sponsorHuman: 'you',
        roles: ['strategist'],
        avatarColor: '#bc8cff',
        bio: 'Product, Research & Strategy Lead',
        capabilities: ['gdrive', 'gdocs', 'subagents', 'strategy', 'mcp'],
        statusText: 'Online · Listening via Bridge',
        rawToken: process.env.RIPPLE_MUSE_TOKEN,
      });
    }
  }

  // Only start the autonomous bridge if explicitly enabled
  const bridge =
    process.env.RIPPLE_ENABLE_BRIDGE === '1'
      ? new MultiAgentBridge(engine, auth, {
          wsId: WORKSPACE_ID,
          enabled: true,
          executeRealTools: process.env.RIPPLE_MOCK_TOOLS !== '1',
        })
      : undefined;
  bridge?.start();

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
    bridge?.stop();
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

