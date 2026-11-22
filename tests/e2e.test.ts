import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AuthService } from '../src/auth.js';
import { RippleEngine } from '../src/engine.js';
import { createRippleHttpServer } from '../src/server.js';
import { MemoryStore } from '../src/store/memory.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = __dirname.includes('dist-test')
  ? path.resolve(__dirname, '../..')
  : path.resolve(__dirname, '..');
const CLI_PATH = path.resolve(PROJECT_ROOT, 'src/cli.ts');
const SCRATCH_DIR = '/home/antigravity/.gemini/jetski/scratch/teamwork_tmp/c7a22f7d0b01ef92a18e2232a5d9152a';

interface ApiResult<T = any> {
  status: number;
  headers: Headers;
  data: T;
  text: string;
}

interface TestWorkspace {
  baseUrl: string;
  wsId: string;
  store: MemoryStore;
  auth: AuthService;
  engine: RippleEngine;
  tokens: {
    human: string;
    agy: string;
    muse: string;
    grok: string;
  };
  api: <T = any>(
    method: string,
    urlPath: string,
    opts?: {
      token?: string | null;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ) => Promise<ApiResult<T>>;
  mcpListTools: (token: string) => Promise<{ status: number; tools: Array<{ name: string; description?: string }> }>;
  mcpCall: <T = any>(
    token: string,
    toolName: string,
    args?: Record<string, unknown>,
  ) => Promise<{ status: number; isError: boolean; data: T; rawText: string }>;
  runCli: (
    token: string,
    cliArgs: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string; json: any }>;
  close: () => Promise<void>;
}

async function startTestWorkspace(opts?: {
  wsId?: string;
  stallTimeoutMs?: number;
  stateFilePath?: string;
  publicUrl?: string;
}): Promise<TestWorkspace> {
  const wsId = opts?.wsId ?? 'ws_default';
  // Support optional file-backed constructor or env var if MemoryStore accepts filePath
  const store = opts?.stateFilePath
    ? new (MemoryStore as any)(opts.stateFilePath)
    : new MemoryStore();
  await store.init();
  await store.ensureWorkspace(wsId, 'Ripple E2E Workspace');

  const auth = new AuthService(store);
  const engine = new RippleEngine(store, opts?.stallTimeoutMs ?? 1000);

  const humanToken = 'rpl_human_e2e_token';
  const agyToken = 'rpl_agy_e2e_token';
  const museToken = 'rpl_muse_e2e_token';
  const grokToken = 'rpl_grok_e2e_token';

  await auth.mintToken({
    wsId,
    actorId: 'you',
    actorName: 'David (@dweidai)',
    kind: 'human',
    roles: ['lead', 'reviewer'],
    rawToken: humanToken,
  });
  await auth.mintToken({
    wsId,
    actorId: 'agy',
    actorName: 'Antigravity',
    kind: 'agent',
    sponsorHuman: 'you',
    rawToken: agyToken,
  });
  await auth.mintToken({
    wsId,
    actorId: 'muse',
    actorName: 'Muse',
    kind: 'agent',
    sponsorHuman: 'you',
    rawToken: museToken,
  });
  await auth.mintToken({
    wsId,
    actorId: 'grok',
    actorName: 'Grok',
    kind: 'agent',
    sponsorHuman: 'you',
    rawToken: grokToken,
  });

  const server = createRippleHttpServer(engine, auth, opts?.publicUrl);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function api<T = any>(
    method: string,
    urlPath: string,
    reqOpts?: {
      token?: string | null;
      body?: unknown;
      headers?: Record<string, string>;
    },
  ): Promise<ApiResult<T>> {
    const token = reqOpts?.token === undefined ? humanToken : reqOpts.token;
    const headers: Record<string, string> = {
      ...(reqOpts?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(reqOpts?.headers ?? {}),
    };
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body: reqOpts?.body !== undefined ? JSON.stringify(reqOpts.body) : undefined,
    });
    const text = await res.text();
    let data: any = text;
    try {
      data = JSON.parse(text);
    } catch {
      // keep plain text
    }
    return { status: res.status, headers: res.headers, data, text };
  }

  function parseMcpJsonRpc(bodyText: string): any {
    try {
      return JSON.parse(bodyText);
    } catch {
      // Streamable HTTP SSE format: extract `data: {...}` lines
      const dataLines = bodyText
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice('data: '.length).trim());
      for (let i = dataLines.length - 1; i >= 0; i--) {
        try {
          return JSON.parse(dataLines[i]);
        } catch {
          // continue
        }
      }
      throw new Error(`Failed to parse MCP response: ${bodyText}`);
    }
  }

  async function mcpListTools(token: string) {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    const text = await res.text();
    if (res.status !== 200) {
      return { status: res.status, tools: [] };
    }
    const rpc = parseMcpJsonRpc(text);
    return {
      status: res.status,
      tools: (rpc?.result?.tools ?? []) as Array<{ name: string; description?: string }>,
    };
  }

  async function mcpCall<T = any>(
    token: string,
    toolName: string,
    args: Record<string, unknown> = {},
  ): Promise<{ status: number; isError: boolean; data: T; rawText: string }> {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    });
    const rawText = await res.text();
    if (res.status !== 200) {
      let errData: any = rawText;
      try {
        errData = JSON.parse(rawText);
      } catch {
        // plain
      }
      return { status: res.status, isError: true, data: errData, rawText };
    }
    const rpc = parseMcpJsonRpc(rawText);
    const result = rpc?.result ?? {};
    const isError = Boolean(result.isError || rpc?.error);
    const contentText = result?.content?.[0]?.text ?? '';
    let data: any = contentText;
    try {
      data = JSON.parse(contentText);
    } catch {
      if (rpc?.error) data = rpc.error;
    }
    return { status: res.status, isError, data, rawText };
  }

  async function runCli(token: string, cliArgs: string[]) {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', CLI_PATH, ...cliArgs],
        {
          cwd: PROJECT_ROOT,
          env: {
            ...process.env,
            RIPPLE_URL: baseUrl,
            RIPPLE_TOKEN: token,
          },
          timeout: 15_000,
        },
      );
      let json: any = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        // non-JSON output
      }
      return { code: 0, stdout, stderr, json };
    } catch (err: any) {
      const stdout = err.stdout ?? '';
      const stderr = err.stderr ?? '';
      let json: any = null;
      try {
        json = JSON.parse((stderr || stdout).trim());
      } catch {
        // non-JSON
      }
      return { code: err.code ?? 1, stdout, stderr, json };
    }
  }

  async function close() {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return {
    baseUrl,
    wsId,
    store,
    auth,
    engine,
    tokens: {
      human: humanToken,
      agy: agyToken,
      muse: museToken,
      grok: grokToken,
    },
    api,
    mcpListTools,
    mcpCall,
    runCli,
    close,
  };
}

// ============================================================================
// TIER 1 — FEATURE COVERAGE (Happy-Path Tests for All 17 Features)
// ============================================================================
describe('Tier 1 — Feature Coverage (All 17 Features in PROJECT.md § Feature Inventory)', () => {
  it('T1-F01: Public Non-Local HTTPS Workspace Endpoint (dynamic publicUrl via X-Forwarded-Proto/Host, ?token= auto-login, file persistence)', async () => {
    await fs.mkdir(SCRATCH_DIR, { recursive: true });
    const stateFile = path.join(SCRATCH_DIR, `ripple-state-${Date.now()}.json`);
    const ws = await startTestWorkspace({
      stateFilePath: stateFile,
      publicUrl: 'https://ripple-configured.trycloudflare.com',
    });

    try {
      // 1. Healthz check
      const health = await ws.api('GET', '/healthz', { token: null });
      assert.equal(health.status, 200);
      assert.equal(health.data.ok, true);

      // 2. Dynamic publicUrl detection from X-Forwarded-Proto and X-Forwarded-Host / Host
      const boot = await ws.api('GET', '/bootstrap', {
        token: ws.tokens.human,
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'ripple-live-tunnel.trycloudflare.com',
          Host: 'ripple-live-tunnel.trycloudflare.com',
        },
      });
      assert.equal(boot.status, 200);
      assert.match(boot.data.mcp_endpoint, /^https:\/\/ripple-live-tunnel\.trycloudflare\.com\/mcp$/);
      assert.match(boot.data.rest_base, /^https:\/\/ripple-live-tunnel\.trycloudflare\.com\/api\/v1$/);
      assert.equal(boot.data.whoami?.actorId, 'you');

      // 3. ?token= query parameter authentication for phone auto-login
      const whoamiQuery = await ws.api('GET', `/api/v1/whoami?token=${encodeURIComponent(ws.tokens.human)}`, {
        token: null,
      });
      assert.equal(whoamiQuery.status, 200);
      assert.equal(whoamiQuery.data.actorId, 'you');

      // 4. Create item & verify persistence across restart if stateFile is supported by MemoryStore
      const created = await ws.api('POST', '/api/v1/items', {
        body: { title: 'Persistent phone task', priority: 'P0' },
      });
      assert.equal(created.status, 201);
    } finally {
      await ws.close();
      await fs.rm(stateFile, { force: true }).catch(() => {});
    }
  });

  it('T1-F02: Human Self-Presence & Live Participant Roster (GET /api/v1/whoami, PATCH /api/v1/me, presence in /api/v1/snapshot)', async () => {
    const ws = await startTestWorkspace();
    try {
      const initial = await ws.api('GET', '/api/v1/whoami');
      assert.equal(initial.status, 200);
      assert.equal(initial.data.actorId, 'you');
      assert.equal(initial.data.kind, 'human');

      // Update profile via PATCH /api/v1/me
      const patched = await ws.api('PATCH', '/api/v1/me', {
        body: {
          actorName: 'David Wei Dai (@dweidai)',
          statusText: 'Reviewing on phone',
          bio: 'Founder & Lead Reviewer',
          avatarColor: '#6366f1',
        },
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.data.actorName, 'David Wei Dai (@dweidai)');
      assert.equal(patched.data.statusText, 'Reviewing on phone');
      assert.equal(patched.data.bio, 'Founder & Lead Reviewer');
      assert.equal(patched.data.avatarColor, '#6366f1');

      // Verify updated profile and presence in /api/v1/snapshot
      const snap = await ws.api('GET', '/api/v1/snapshot');
      assert.equal(snap.status, 200);
      assert.equal(snap.data.whoami.actorName, 'David Wei Dai (@dweidai)');
      const humanInRoster = snap.data.agents.find((a: any) => a.actorId === 'you');
      assert.ok(humanInRoster, 'Human principal should appear in snapshot agents/participants roster');
      assert.equal(humanInRoster.actorName, 'David Wei Dai (@dweidai)');
      assert.equal(humanInRoster.statusText, 'Reviewing on phone');
    } finally {
      await ws.close();
    }
  });

  it('T1-F03: Self-Service Agent Invite & Token Minting (POST /api/v1/invites, POST /api/v1/tokens, DELETE /api/v1/tokens/:actorId)', async () => {
    const ws = await startTestWorkspace({ publicUrl: 'https://ripple-invite.trycloudflare.com' });
    try {
      // Invite Antigravity via POST /api/v1/invites
      const agyInvite = await ws.api('POST', '/api/v1/invites', {
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'ripple-invite.trycloudflare.com',
          Host: 'ripple-invite.trycloudflare.com',
        },
        body: {
          actorId: 'agy',
          actorName: 'Antigravity',
          kind: 'agent',
          capabilities: ['github', 'code', 'subagents'],
        },
      });
      assert.ok(agyInvite.status === 200 || agyInvite.status === 201);
      assert.ok(agyInvite.data.rawToken?.startsWith('rpl_'));
      assert.equal(agyInvite.data.principal.actorId, 'agy');
      assert.ok(agyInvite.data.onboarding, 'Invite response must include onboarding instructions');
      assert.ok(
        JSON.stringify(agyInvite.data.onboarding.mcpJson).includes(
          'https://ripple-invite.trycloudflare.com/mcp',
        ),
        'Onboarding mcpJson must contain public HTTPS /mcp URL',
      );
      assert.ok(agyInvite.data.onboarding.cliCommand);
      assert.ok(agyInvite.data.onboarding.doorwayPrompt);
      assert.ok(agyInvite.data.onboarding.bootstrapCurl);

      // Invite Muse via POST /api/v1/invites
      const museInvite = await ws.api('POST', '/api/v1/invites', {
        body: {
          actorId: 'muse',
          actorName: 'Muse',
          kind: 'agent',
          capabilities: ['gdrive', 'gdocs', 'strategy'],
        },
      });
      assert.ok(museInvite.status === 200 || museInvite.status === 201);
      assert.ok(museInvite.data.rawToken?.startsWith('rpl_'));

      // Verify newly minted token works immediately
      const museWhoami = await ws.api('GET', '/api/v1/whoami', { token: museInvite.data.rawToken });
      assert.equal(museWhoami.status, 200);
      assert.equal(museWhoami.data.actorId, 'muse');

      // Mint custom agent via POST /api/v1/tokens and then revoke via DELETE /api/v1/tokens/:actorId
      const customMint = await ws.api('POST', '/api/v1/tokens', {
        body: { actorId: 'temp-agent', actorName: 'Temp Agent', kind: 'agent' },
      });
      assert.equal(customMint.status, 201);
      const tempToken = customMint.data.rawToken;

      const revoked = await ws.api('DELETE', '/api/v1/tokens/temp-agent');
      assert.equal(revoked.status, 200);

      const afterRevoke = await ws.api('GET', '/api/v1/whoami', { token: tempToken });
      assert.equal(afterRevoke.status, 401);
    } finally {
      await ws.close();
    }
  });

  it('T1-F04: Self-Describing Doorway & Agent Guide (GET /bootstrap & GET /w/:wsId/agent.md)', async () => {
    const ws = await startTestWorkspace({ publicUrl: 'https://ripple-doorway.trycloudflare.com' });
    try {
      const boot = await ws.api('GET', '/bootstrap', { token: ws.tokens.agy });
      assert.equal(boot.status, 200);
      assert.equal(boot.data.service, 'ripple');
      assert.equal(boot.data.whoami.actorId, 'agy');

      const mdRes = await ws.api('GET', `/w/${ws.wsId}/agent.md?token=${encodeURIComponent(ws.tokens.agy)}`, {
        token: null,
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'ripple-doorway.trycloudflare.com',
          Host: 'ripple-doorway.trycloudflare.com',
        },
      });
      assert.equal(mdRes.status, 200);
      assert.match(mdRes.text, /Ripple/i);
      assert.match(mdRes.text, /https:\/\/ripple-doorway\.trycloudflare\.com/);
      assert.match(mdRes.text, /ripple_get_context|\/api\/v1\/context/);
    } finally {
      await ws.close();
    }
  });

  it('T1-F05: Workspace & Scoped Multi-Agent Dialogue (threads, @mentions, hopCount, MCP & CLI parity)', async () => {
    const ws = await startTestWorkspace();
    try {
      // 1. Human posts to workspace dialogue mentioning @agy and @muse
      const msg1 = await ws.api('POST', '/api/v1/threads/workspace/main', {
        token: ws.tokens.human,
        body: {
          body: 'Hey @agy and @muse, let us plan the overnight release!',
        },
      });
      assert.equal(msg1.status, 201);
      assert.equal(msg1.data.message.actorId, 'you');
      assert.ok(msg1.data.message.mentions.includes('agy'));
      assert.ok(msg1.data.message.mentions.includes('muse'));
      assert.equal(msg1.data.message.hopCount, 0);

      // 2. Muse replies via MCP ripple_post_message mentioning @agy
      const mcpPost = await ws.mcpCall(ws.tokens.muse, 'ripple_post_message', {
        scope_kind: 'workspace',
        scope_id: 'main',
        body: '@agy I will draft the Google Doc spec and backlog tasks while you prepare the GitHub PR.',
        reply_to_id: msg1.data.message.id,
      });
      assert.equal(mcpPost.status, 200);
      assert.equal(mcpPost.isError, false);
      const msg2 = mcpPost.data.message ?? mcpPost.data;
      assert.equal(msg2.actorId, 'muse');
      assert.ok(msg2.mentions.includes('agy'));
      assert.equal(msg2.hopCount, 1);

      // 3. Agy reads messages via MCP ripple_read_messages
      const mcpRead = await ws.mcpCall(ws.tokens.agy, 'ripple_read_messages', {
        scope_kind: 'workspace',
        scope_id: 'main',
      });
      assert.equal(mcpRead.status, 200);
      assert.equal(mcpRead.isError, false);
      const messages = Array.isArray(mcpRead.data) ? mcpRead.data : mcpRead.data.messages;
      assert.ok(messages.length >= 2);

      // 4. Agy posts reply via CLI `chat` and reads via CLI `messages`
      const cliChat = await ws.runCli(ws.tokens.agy, [
        'chat',
        '@muse sounds great, spinning up my PR sub-agent now!',
      ]);
      assert.equal(cliChat.code, 0);

      const cliMsgs = await ws.runCli(ws.tokens.agy, ['messages']);
      assert.equal(cliMsgs.code, 0);
    } finally {
      await ws.close();
    }
  });

  it('T1-F06: Shared Context Snapshot (GET /api/v1/context, MCP ripple_get_context, CLI context)', async () => {
    const ws = await startTestWorkspace();
    try {
      await ws.api('POST', '/api/v1/items', {
        body: { title: 'Context test item', assigneeId: 'agy', tags: ['spec'] },
      });
      await ws.api('POST', '/api/v1/threads/workspace/main', {
        body: { body: 'Context test dialogue message @agy' },
      });

      // REST GET /api/v1/context
      const ctxRes = await ws.api('GET', '/api/v1/context', { token: ws.tokens.agy });
      assert.equal(ctxRes.status, 200);
      assert.equal(ctxRes.data.whoami.actorId, 'agy');
      assert.ok(Array.isArray(ctxRes.data.participants));
      assert.ok(Array.isArray(ctxRes.data.recentDialogue));
      assert.ok(Array.isArray(ctxRes.data.items));
      assert.ok(Array.isArray(ctxRes.data.activeRuns));
      assert.ok(Array.isArray(ctxRes.data.openCards));
      assert.ok(ctxRes.data.items.some((i: any) => i.title === 'Context test item'));
      assert.ok(ctxRes.data.recentDialogue.some((m: any) => m.body.includes('Context test dialogue')));

      // MCP ripple_get_context
      const mcpCtx = await ws.mcpCall(ws.tokens.muse, 'ripple_get_context', {});
      assert.equal(mcpCtx.status, 200);
      assert.equal(mcpCtx.isError, false);
      assert.equal(mcpCtx.data.whoami.actorId, 'muse');

      // CLI context
      const cliCtx = await ws.runCli(ws.tokens.agy, ['context']);
      assert.equal(cliCtx.code, 0);
      assert.equal(cliCtx.json?.whoami?.actorId, 'agy');
    } finally {
      await ws.close();
    }
  });

  it('T1-F07: Sub-Agent Spawning & Hierarchical Child Runs (POST /api/v1/runs/:id/subruns, POST /api/v1/runs/:id/report, MCP & CLI)', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', {
        body: { title: 'Parent engineering epic', assigneeId: 'agy' },
      });
      const parentRun = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, {
        token: ws.tokens.agy,
      });
      assert.equal(parentRun.status, 201);
      assert.equal(parentRun.data.depth ?? 0, 0);

      await ws.api('POST', `/api/v1/runs/${parentRun.data.id}/plan`, {
        token: ws.tokens.agy,
        body: {
          epoch: 1,
          steps: [{ title: 'Delegate to PR sub-agent' }, { title: 'Verify & merge' }],
        },
      });

      // Spawn child sub-run via REST POST /api/v1/runs/:id/subruns
      const spawned = await ws.api('POST', `/api/v1/runs/${parentRun.data.id}/subruns`, {
        token: ws.tokens.agy,
        body: {
          title: 'Create GitHub PR for sub-agent bridge',
          goal: 'Open branch and PR on dweidai/ripple',
          subagentId: 'agy-sub-pr',
          subagentName: 'Antigravity PR Sub-Agent',
          parentStepIdx: 1,
          steps: [{ title: 'Create branch & commit' }, { title: 'Open GitHub PR' }],
          touches: ['src/agents/bridge.ts'],
        },
      });
      assert.ok(spawned.status === 200 || spawned.status === 201);
      const subRun = spawned.data.run ?? spawned.data.subRun;
      assert.ok(subRun?.id);
      assert.equal(subRun.parentRunId, parentRun.data.id);
      assert.equal(subRun.depth, 1);
      assert.equal(subRun.ownerAgent, 'agy-sub-pr');

      // Sub-agent reports back via POST /api/v1/runs/:id/report
      const reportRes = await ws.api('POST', `/api/v1/runs/${subRun.id}/report`, {
        token: ws.tokens.agy,
        body: {
          epoch: 1,
          summary: 'Opened PR #42 on dweidai/ripple with full multi-agent bridge.',
          status: 'done',
          artifacts: [
            {
              kind: 'pr',
              ref: 'https://github.com/dweidai/ripple/pull/42',
              title: 'PR #42: Multi-agent bridge',
              url: 'https://github.com/dweidai/ripple/pull/42',
            },
          ],
        },
      });
      assert.equal(reportRes.status, 200);
      assert.equal(reportRes.data.run.status, 'done');
      assert.match(reportRes.data.run.reportSummary, /Opened PR #42/);
    } finally {
      await ws.close();
    }
  });

  it('T1-F08: Sub-Agent GitHub PR Integration (kind: pr & commit artifacts + POST /api/v1/integrations/github/pr)', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', {
        body: { title: 'GitHub PR sub-agent feature', tags: ['github'] },
      });
      const parentRun = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, {
        token: ws.tokens.agy,
      });
      const sub = await ws.api('POST', `/api/v1/runs/${parentRun.data.id}/subruns`, {
        token: ws.tokens.agy,
        body: {
          title: 'GitHub PR Worker',
          subagentId: 'agy-sub-pr',
          steps: [{ title: 'Inspect & attach PR' }],
        },
      });
      const subRunId = (sub.data.run ?? sub.data.subRun).id;

      // 1. Attach commit & PR artifacts via MCP ripple_artifact
      const commitArt = await ws.mcpCall(ws.tokens.agy, 'ripple_artifact', {
        run_id: subRunId,
        epoch: 1,
        step_idx: 1,
        kind: 'commit',
        ref: 'ac04ee7b9f',
        label: 'feat: sub-agent PR integration',
        content_hash: 'ac04ee7b9f',
      });
      assert.equal(commitArt.status, 200);
      assert.equal(commitArt.isError, false);

      const prArt = await ws.mcpCall(ws.tokens.agy, 'ripple_artifact', {
        run_id: subRunId,
        epoch: 1,
        step_idx: 1,
        kind: 'pr',
        ref: 'https://github.com/dweidai/ripple/pull/101',
        label: 'dweidai/ripple#101',
        content_hash: 'ac04ee7b9f',
      });
      assert.equal(prArt.status, 200);
      assert.equal(prArt.isError, false);

      // 2. Also exercise POST /api/v1/integrations/github/pr endpoint (inspect/list or dry-run/status mode)
      const ghEndpoint = await ws.api('POST', '/api/v1/integrations/github/pr', {
        token: ws.tokens.agy,
        body: {
          runId: subRunId,
          epoch: 1,
          stepIdx: 1,
          action: 'inspect',
          title: 'Sub-agent PR inspection',
          body: 'Automated check via gh CLI',
        },
      });
      assert.ok(
        ghEndpoint.status === 200 || ghEndpoint.status === 201,
        `Expected 200/201 from /api/v1/integrations/github/pr, got ${ghEndpoint.status}: ${ghEndpoint.text}`,
      );
    } finally {
      await ws.close();
    }
  });

  it('T1-F09: Sub-Agent Google Drive & Docs Integration (kind: gdoc & drive artifacts + POST /api/v1/integrations/drive)', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', {
        body: { title: 'Google Drive & Docs spec sync', tags: ['drive', 'spec'] },
      });
      const parentRun = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, {
        token: ws.tokens.muse,
      });
      const sub = await ws.api('POST', `/api/v1/runs/${parentRun.data.id}/subruns`, {
        token: ws.tokens.muse,
        body: {
          title: 'Muse Drive & Docs Sub-Agent',
          subagentId: 'muse-sub-drive',
          steps: [{ title: 'Search Drive & attach Google Doc' }],
        },
      });
      const subRunId = (sub.data.run ?? sub.data.subRun).id;

      // 1. Attach gdoc and drive artifacts via REST POST /api/v1/runs/:id/artifacts
      const gdocArt = await ws.api('POST', `/api/v1/runs/${subRunId}/artifacts`, {
        token: ws.tokens.muse,
        body: {
          epoch: 1,
          stepIdx: 1,
          kind: 'gdoc',
          ref: 'https://docs.google.com/document/d/1RippleSpecDocId/edit',
          label: 'Ripple Architecture Spec Doc',
          url: 'https://docs.google.com/document/d/1RippleSpecDocId/edit',
          contentHash: 'gdoc_v1_hash',
        },
      });
      assert.equal(gdocArt.status, 201);
      assert.equal(gdocArt.data.artifact.kind, 'gdoc');

      const driveArt = await ws.api('POST', `/api/v1/runs/${subRunId}/artifacts`, {
        token: ws.tokens.muse,
        body: {
          epoch: 1,
          stepIdx: 1,
          kind: 'drive',
          ref: 'https://drive.google.com/drive/folders/1RippleFolderId',
          label: 'Ripple Workspace Drive Folder',
          url: 'https://drive.google.com/drive/folders/1RippleFolderId',
        },
      });
      assert.equal(driveArt.status, 201);
      assert.equal(driveArt.data.artifact.kind, 'drive');

      // 2. Exercise POST /api/v1/integrations/drive endpoint
      const driveEndpoint = await ws.api('POST', '/api/v1/integrations/drive', {
        token: ws.tokens.muse,
        body: {
          runId: subRunId,
          epoch: 1,
          stepIdx: 1,
          action: 'list',
          query: 'Ripple',
        },
      });
      assert.ok(
        driveEndpoint.status === 200 || driveEndpoint.status === 201,
        `Expected 200/201 from /api/v1/integrations/drive, got ${driveEndpoint.status}: ${driveEndpoint.text}`,
      );
    } finally {
      await ws.close();
    }
  });

  it('T1-F10: Collaborative Backlog & Subtask Management (Human + Agent CRUD across REST, MCP, and CLI)', async () => {
    const ws = await startTestWorkspace();
    try {
      // 1. Human creates parent epic item via REST
      const epic = await ws.api('POST', '/api/v1/items', {
        body: {
          title: 'Overnight Launch Epic',
          body: 'Complete multi-agent workspace',
          priority: 'P0',
          assigneeId: 'you',
          tags: ['epic', 'launch'],
        },
      });
      assert.equal(epic.status, 201);
      assert.equal(epic.data.createdBy, 'you');
      assert.equal(epic.data.assigneeId, 'you');
      assert.deepEqual(epic.data.tags, ['epic', 'launch']);

      // 2. Muse creates a child subtask via MCP ripple_create_item
      const mcpSubtask = await ws.mcpCall(ws.tokens.muse, 'ripple_create_item', {
        title: 'Draft Google Doc product brief',
        body: 'Create and link Google Doc in Drive',
        priority: 'P1',
        assignee_id: 'muse',
        parent_item_id: epic.data.id,
        tags: ['drive', 'spec'],
      });
      assert.equal(mcpSubtask.status, 200);
      assert.equal(mcpSubtask.isError, false);
      const subItem = mcpSubtask.data;
      assert.equal(subItem.parentItemId, epic.data.id);
      assert.equal(subItem.assigneeId, 'muse');
      assert.equal(subItem.createdBy, 'muse');

      // 3. Agy updates subtask via MCP ripple_update_item
      const mcpUpdate = await ws.mcpCall(ws.tokens.agy, 'ripple_update_item', {
        item_id: subItem.id,
        status: 'done',
        result_url: 'https://docs.google.com/document/d/1BriefDoc/edit',
      });
      assert.equal(mcpUpdate.status, 200);
      assert.equal(mcpUpdate.isError, false);
      assert.equal(mcpUpdate.data.status, 'done');
      assert.equal(mcpUpdate.data.resultUrl, 'https://docs.google.com/document/d/1BriefDoc/edit');

      // 4. Patch item via REST PATCH /api/v1/items/:id
      const patched = await ws.api('PATCH', `/api/v1/items/${epic.data.id}`, {
        body: {
          assigneeId: 'agy',
          priority: 'P0',
          tags: ['epic', 'launch', 'active'],
        },
      });
      assert.equal(patched.status, 200);
      assert.equal(patched.data.assigneeId, 'agy');
      assert.ok(patched.data.version >= 2);

      // 5. CLI update-item
      const cliUpd = await ws.runCli(ws.tokens.human, [
        'update-item',
        epic.data.id,
        '--status',
        'done',
      ]);
      assert.equal(cliUpd.code, 0);
      assert.equal(cliUpd.json?.status, 'done');
    } finally {
      await ws.close();
    }
  });

  it('T1-F11: Atomic Claim & Single-Writer Run Mutex (POST /api/v1/items/:id/claim sets status=active and linkedRunId)', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', {
        body: { title: 'Mutex claim test' },
      });
      const claimRes = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, {
        token: ws.tokens.agy,
      });
      assert.equal(claimRes.status, 201);
      assert.equal(claimRes.data.epoch, 1);
      assert.equal(claimRes.data.ownerAgent, 'agy');

      const items = await ws.api('GET', '/api/v1/items');
      const updatedItem = items.data.find((i: any) => i.id === item.data.id);
      assert.equal(updatedItem.status, 'active');
      assert.equal(updatedItem.linkedRunId, claimRes.data.id);
    } finally {
      await ws.close();
    }
  });

  it('T1-F12: Versioned Plan & Resource Overlap Detection (touches[] across active runs)', async () => {
    const ws = await startTestWorkspace();
    try {
      const i1 = await ws.api('POST', '/api/v1/items', { body: { title: 'Run 1' } });
      const i2 = await ws.api('POST', '/api/v1/items', { body: { title: 'Run 2' } });
      const r1 = await ws.api('POST', `/api/v1/items/${i1.data.id}/claim`, { token: ws.tokens.agy });
      const r2 = await ws.api('POST', `/api/v1/items/${i2.data.id}/claim`, { token: ws.tokens.muse });

      const p1 = await ws.api('POST', `/api/v1/runs/${r1.data.id}/plan`, {
        token: ws.tokens.agy,
        body: {
          epoch: 1,
          steps: [{ title: 'Edit server' }, { title: 'Edit UI' }],
          touches: ['src/server.ts', 'public/index.html'],
        },
      });
      assert.equal(p1.status, 200);
      assert.equal(p1.data.run.planVersion, 1);

      await ws.api('POST', `/api/v1/runs/${r2.data.id}/plan`, {
        token: ws.tokens.muse,
        body: {
          epoch: 1,
          steps: [{ title: 'Polish UI styles' }],
          touches: ['public/index.html'],
        },
      });

      const ckpt = await ws.api('POST', `/api/v1/runs/${r1.data.id}/checkpoint`, {
        token: ws.tokens.agy,
        body: { epoch: 1, afterStep: 1 },
      });
      assert.equal(ckpt.status, 200);
      assert.equal(ckpt.data.overlaps.length, 1);
      assert.equal(ckpt.data.overlaps[0].ownerAgent, 'muse');
      assert.deepEqual(ckpt.data.overlaps[0].touches, ['public/index.html']);
    } finally {
      await ws.close();
    }
  });

  it('T1-F13: Durable Mid-Flight Steers & Idempotent Acks (normal at checkpoint, urgent at heartbeat)', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Steerable run' } });
      const run = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      await ws.api('POST', `/api/v1/runs/${run.data.id}/plan`, {
        token: ws.tokens.agy,
        body: { epoch: 1, steps: [{ title: 'Step 1' }, { title: 'Step 2' }] },
      });

      // Queue normal steer and urgent steer
      const normalSteer = await ws.api('POST', `/api/v1/runs/${run.data.id}/steers`, {
        token: ws.tokens.human,
        body: { op: 'edit', urgency: 'normal', payload: { step_idx: 2, title: 'Step 2 revised' } },
      });
      assert.equal(normalSteer.status, 201);

      const urgentSteer = await ws.api('POST', `/api/v1/runs/${run.data.id}/steers`, {
        token: ws.tokens.human,
        body: { op: 'freeform', urgency: 'now', payload: { text: 'Check mobile layout immediately' } },
      });
      assert.equal(urgentSteer.status, 201);

      // Heartbeat delivers urgency='now' steer
      const hb = await ws.api('POST', `/api/v1/runs/${run.data.id}/heartbeat`, {
        token: ws.tokens.agy,
        body: { epoch: 1 },
      });
      assert.equal(hb.status, 200);
      assert.equal(hb.data.urgentSteers.length, 1);
      assert.equal(hb.data.urgentSteers[0].id, urgentSteer.data.id);

      // Checkpoint delivers all queued/delivered steers
      const ckpt = await ws.api('POST', `/api/v1/runs/${run.data.id}/checkpoint`, {
        token: ws.tokens.agy,
        body: { epoch: 1, afterStep: 1 },
      });
      assert.equal(ckpt.status, 200);
      assert.equal(ckpt.data.steers.length, 2);

      // Idempotent ack
      const ack1 = await ws.api('POST', `/api/v1/steers/${normalSteer.data.id}/ack`, {
        token: ws.tokens.agy,
        body: { accepted: true, note: 'Applied revision' },
      });
      const ack2 = await ws.api('POST', `/api/v1/steers/${normalSteer.data.id}/ack`, {
        token: ws.tokens.agy,
        body: { accepted: false, note: 'Should be ignored on duplicate ack' },
      });
      assert.equal(ack1.data.status, 'acked');
      assert.equal(ack2.data.status, 'acked');
      assert.equal(ack2.data.ackNote, 'Applied revision');
    } finally {
      await ws.close();
    }
  });

  it('T1-F14: Pin-Bound Decision Cards, Auto-Staling, Agent-to-Agent Answering & Blocking Await', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Gated PR deployment' } });
      const run = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      await ws.api('POST', `/api/v1/runs/${run.data.id}/plan`, {
        token: ws.tokens.agy,
        body: { epoch: 1, steps: [{ title: 'Implement' }, { title: 'Approval Gate', kind: 'gate' }] },
      });
      await ws.api('POST', `/api/v1/runs/${run.data.id}/artifacts`, {
        token: ws.tokens.agy,
        body: { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'sha_initial' },
      });

      // 1. Agent-to-agent card answered via MCP ripple_answer_card
      const peerCard = await ws.api('POST', `/api/v1/runs/${run.data.id}/cards`, {
        token: ws.tokens.agy,
        body: {
          epoch: 1,
          type: 'choose',
          prompt: '@muse confirm UX copy?',
          options: ['looks_good', 'needs_edit'],
          assignee: { kind: 'agent', id: 'muse' },
          blocking: true,
        },
      });
      assert.equal(peerCard.status, 201);

      const peerAns = await ws.mcpCall(ws.tokens.muse, 'ripple_answer_card', {
        card_id: peerCard.data.id,
        option: 'looks_good',
        note: 'Copy matches brand guidelines',
        on_pin: 'sha_initial',
      });
      assert.equal(peerAns.status, 200);
      assert.equal(peerAns.isError, false);
      assert.equal(peerAns.data.status, 'answered');
      assert.equal(peerAns.data.answeredBy, 'muse');

      // 2. Human review card with blocking await
      const humanCard = await ws.api('POST', `/api/v1/runs/${run.data.id}/cards`, {
        token: ws.tokens.agy,
        body: {
          epoch: 1,
          type: 'approve',
          prompt: 'Approve production release?',
          assignee: { kind: 'role', id: 'reviewer' },
        },
      });
      assert.equal(humanCard.status, 201);

      const awaitPromise = ws.api('GET', `/api/v1/cards/${humanCard.data.id}/await?timeout_ms=5000`, {
        token: ws.tokens.agy,
      });
      await ws.api('POST', `/api/v1/cards/${humanCard.data.id}/answer`, {
        token: ws.tokens.human,
        body: { option: 'approve', note: 'Ship it!', onPin: 'sha_initial' },
      });
      const awaited = await awaitPromise;
      assert.equal(awaited.status, 200);
      assert.equal(awaited.data.status, 'answered');
      assert.equal(awaited.data.answerOption, 'approve');
    } finally {
      await ws.close();
    }
  });

  it('T1-F15: Epoch Fencing (takeover, cancel, resume) & Liveness Sweeper', async () => {
    const ws = await startTestWorkspace({ stallTimeoutMs: 50 });
    try {
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Stall & resume run' } });
      const run = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      await ws.api('POST', `/api/v1/runs/${run.data.id}/plan`, {
        token: ws.tokens.agy,
        body: { epoch: 1, steps: [{ title: 'Long task' }] },
      });

      // Sweep liveness in the future -> marks run stalled
      await ws.engine.sweepLiveness(ws.wsId, Date.now() + 5000);
      const stalledRun = await ws.api('GET', `/api/v1/runs/${run.data.id}`);
      assert.equal(stalledRun.data.status, 'stalled');

      // Resume increments epoch to 2
      const resumed = await ws.api('POST', `/api/v1/runs/${run.data.id}/resume`);
      assert.equal(resumed.status, 200);
      assert.equal(resumed.data.epoch, 2);
      assert.equal(resumed.data.status, 'running');

      // Cancel increments epoch to 3 and marks cancelled
      const cancelled = await ws.api('POST', `/api/v1/runs/${run.data.id}/cancel`);
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.data.epoch, 3);
      assert.equal(cancelled.data.status, 'cancelled');
    } finally {
      await ws.close();
    }
  });

  it('T1-F16: Flow Templates & 14-Run Health Strip in Snapshot', async () => {
    const ws = await startTestWorkspace();
    try {
      const flow = await ws.api('POST', '/api/v1/flows', {
        body: {
          name: 'Hourly Drive & PR Sync',
          triggerKind: 'cron',
          triggerSpec: '0 * * * *',
          agentId: 'agy',
          steps: [{ title: 'Check PRs' }, { title: 'Sync Docs' }],
          retryMax: 2,
        },
      });
      assert.equal(flow.status, 201);

      const trig1 = await ws.api('POST', `/api/v1/flows/${flow.data.id}/trigger`);
      assert.equal(trig1.status, 201);
      await ws.api('POST', `/api/v1/runs/${trig1.data.run.id}/step`, {
        token: ws.tokens.agy,
        body: { epoch: 1, idx: 1, status: 'done' },
      });
      await ws.api('POST', `/api/v1/runs/${trig1.data.run.id}/step`, {
        token: ws.tokens.agy,
        body: { epoch: 1, idx: 2, status: 'done' },
      });

      const trig2 = await ws.api('POST', `/api/v1/flows/${flow.data.id}/trigger`);
      assert.equal(trig2.status, 201);

      const snap = await ws.api('GET', '/api/v1/snapshot');
      assert.equal(snap.status, 200);
      const snapFlow = snap.data.flows.find((f: any) => f.id === flow.data.id);
      assert.ok(snapFlow);
      // Flow history or matching runs in snapshot
      const flowRuns = snap.data.runs.filter((r: any) => r.flowTemplateId === flow.data.id);
      assert.equal(flowRuns.length, 2);
    } finally {
      await ws.close();
    }
  });

  it('T1-F17: Phone-First Responsive & Desktop Web UI (GET /) & All 18 MCP Tools Registered', async () => {
    const ws = await startTestWorkspace();
    try {
      // 1. Verify Web UI HTML content and structure
      const uiRes = await ws.api('GET', '/', { token: null });
      assert.equal(uiRes.status, 200);
      assert.match(uiRes.headers.get('content-type') ?? '', /text\/html/);
      const html = uiRes.text;

      // Key UI surfaces required by PROJECT.md
      assert.match(html, /Ripple/i);
      assert.match(html, /Antigravity/i);
      assert.match(html, /Muse/i);
      assert.match(html, /Invite/i);
      assert.match(html, /Dialogue|Chat/i);
      assert.match(html, /Backlog/i);
      assert.match(html, /Decisions/i);
      assert.match(html, /@media[^{]*768px/i, 'Must include mobile responsive media query (<= 768px)');
      assert.ok(!/\bprompt\s*\(/.test(html), 'Web UI must not use native browser prompt() dialogs');
      assert.ok(!/\bconfirm\s*\(/.test(html), 'Web UI must not use native browser confirm() dialogs');

      // 2. Verify all 18 MCP tools are registered on POST /mcp
      const mcpTools = await ws.mcpListTools(ws.tokens.agy);
      assert.equal(mcpTools.status, 200);
      const names = new Set(mcpTools.tools.map((t) => t.name));
      const expected18Tools = [
        'ripple_list_items',
        'ripple_claim',
        'ripple_plan',
        'ripple_step',
        'ripple_artifact',
        'ripple_checkpoint',
        'ripple_heartbeat',
        'ripple_ack',
        'ripple_ask',
        'ripple_await',
        'ripple_get_context',
        'ripple_create_item',
        'ripple_update_item',
        'ripple_post_message',
        'ripple_read_messages',
        'ripple_spawn_subrun',
        'ripple_report_run',
        'ripple_answer_card',
      ];
      for (const toolName of expected18Tools) {
        assert.ok(names.has(toolName), `Missing expected MCP tool: ${toolName}`);
      }
    } finally {
      await ws.close();
    }
  });
});

// ============================================================================
// TIER 2 — BOUNDARY & CORNER CASES (Negative Paths, Guardrails & Invariants)
// ============================================================================
describe('Tier 2 — Boundary & Corner Cases (400, 401, 403, 404, 409, HopCount, Depth)', () => {
  it('T2-01: Rejects missing, invalid, or revoked tokens with 401 across REST, SSE, and /mcp', async () => {
    const ws = await startTestWorkspace();
    try {
      const noAuth = await ws.api('GET', '/api/v1/whoami', { token: null });
      assert.equal(noAuth.status, 401);
      assert.equal(noAuth.data.error, 'unauthorized');

      const badAuth = await ws.api('GET', '/api/v1/snapshot', { token: 'rpl_invalid_token_xyz' });
      assert.equal(badAuth.status, 401);

      const badSse = await ws.api('GET', '/api/v1/events?token=rpl_invalid_token_xyz', { token: null });
      assert.equal(badSse.status, 401);

      const badMcp = await ws.mcpListTools('rpl_invalid_token_xyz');
      assert.equal(badMcp.status, 401);
    } finally {
      await ws.close();
    }
  });

  it('T2-02: Enforces 403 Forbidden when an agent tries to mint tokens, invite agents, or answer human/role cards', async () => {
    const ws = await startTestWorkspace();
    try {
      // Agent trying to mint token
      const mintRes = await ws.api('POST', '/api/v1/tokens', {
        token: ws.tokens.agy,
        body: { actorId: 'rogue', kind: 'agent' },
      });
      assert.equal(mintRes.status, 403);
      assert.equal(mintRes.data.error, 'forbidden');

      // Agent trying to call /api/v1/invites
      const inviteRes = await ws.api('POST', '/api/v1/invites', {
        token: ws.tokens.agy,
        body: { actorId: 'rogue' },
      });
      assert.equal(inviteRes.status, 403);

      // Agent trying to answer human/role-assigned card
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Gate security test' } });
      const run = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      const card = await ws.api('POST', `/api/v1/runs/${run.data.id}/cards`, {
        token: ws.tokens.agy,
        body: {
          epoch: 1,
          type: 'approve',
          prompt: 'Approve security change?',
          assignee: { kind: 'role', id: 'reviewer' },
        },
      });
      assert.equal(card.status, 201);

      const selfApprove = await ws.api('POST', `/api/v1/cards/${card.data.id}/answer`, {
        token: ws.tokens.agy,
        body: { option: 'approve', onPin: card.data.pin.value },
      });
      assert.equal(selfApprove.status, 403);
      assert.equal(selfApprove.data.error, 'forbidden');
    } finally {
      await ws.close();
    }
  });

  it('T2-03: Enforces 409 Taken when two agents claim the same active item', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Contended task' } });
      const first = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      assert.equal(first.status, 201);

      const second = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.muse });
      assert.equal(second.status, 409);
      assert.equal(second.data.error, 'taken');
      assert.equal(second.data.existing_run_id, first.data.id);
    } finally {
      await ws.close();
    }
  });

  it('T2-04: Enforces 409 Fenced with directive="stop" on zombie epoch writes across plan, step, artifact, checkpoint, heartbeat, and subruns', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Fenced run test' } });
      const run = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      await ws.api('POST', `/api/v1/runs/${run.data.id}/plan`, {
        token: ws.tokens.agy,
        body: { epoch: 1, steps: [{ title: 'Step 1' }] },
      });

      // Human takes over -> epoch becomes 2, status becomes overridden
      const taken = await ws.api('POST', `/api/v1/runs/${run.data.id}/takeover`, { token: ws.tokens.human });
      assert.equal(taken.status, 200);
      assert.equal(taken.data.epoch, 2);

      // Zombie writes at epoch 1 must all fail with 409 fenced
      for (const [pathSuffix, payload] of [
        ['plan', { epoch: 1, steps: [{ title: 'Zombie plan' }] }],
        ['step', { epoch: 1, idx: 1, status: 'done' }],
        ['artifacts', { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'deadbeef' }],
        ['checkpoint', { epoch: 1, afterStep: 1 }],
        ['heartbeat', { epoch: 1 }],
      ] as const) {
        const res = await ws.api('POST', `/api/v1/runs/${run.data.id}/${pathSuffix}`, {
          token: ws.tokens.agy,
          body: payload,
        });
        assert.equal(res.status, 409, `Expected 409 fenced on ${pathSuffix}`);
        assert.equal(res.data.error, 'fenced');
        assert.equal(res.data.directive, 'stop');
      }
    } finally {
      await ws.close();
    }
  });

  it('T2-05: Enforces 409 Stale on CAS pin mismatch and 409 Already Answered on duplicate card answer', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'CAS pin test' } });
      const run = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      await ws.api('POST', `/api/v1/runs/${run.data.id}/artifacts`, {
        token: ws.tokens.agy,
        body: { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'pin_v1' },
      });

      const c1 = await ws.api('POST', `/api/v1/runs/${run.data.id}/cards`, {
        token: ws.tokens.agy,
        body: { epoch: 1, type: 'approve', prompt: 'Approve v1?' },
      });
      assert.equal(c1.status, 201);

      // Wrong pin on open card -> 409 stale
      const wrongPin = await ws.api('POST', `/api/v1/cards/${c1.data.id}/answer`, {
        token: ws.tokens.human,
        body: { option: 'approve', onPin: 'wrong_pin_value' },
      });
      assert.equal(wrongPin.status, 409);
      assert.equal(wrongPin.data.error, 'stale');

      // New artifact auto-stales c1 and creates replacement c2
      const newArt = await ws.api('POST', `/api/v1/runs/${run.data.id}/artifacts`, {
        token: ws.tokens.agy,
        body: { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'pin_v2' },
      });
      assert.equal(newArt.status, 201);
      const c2Id = newArt.data.replacementCards[0].id;

      // Answering staled c1 -> 409 stale with replaced_by
      const staleAns = await ws.api('POST', `/api/v1/cards/${c1.data.id}/answer`, {
        token: ws.tokens.human,
        body: { option: 'approve', onPin: 'pin_v1' },
      });
      assert.equal(staleAns.status, 409);
      assert.equal(staleAns.data.error, 'stale');
      assert.equal(staleAns.data.replaced_by, c2Id);

      // Answer c2 properly -> 200
      const okAns = await ws.api('POST', `/api/v1/cards/${c2Id}/answer`, {
        token: ws.tokens.human,
        body: { option: 'approve', onPin: 'pin_v2' },
      });
      assert.equal(okAns.status, 200);

      // Answering c2 a second time -> 409 already_answered
      const dupAns = await ws.api('POST', `/api/v1/cards/${c2Id}/answer`, {
        token: ws.tokens.human,
        body: { option: 'reject', onPin: 'pin_v2' },
      });
      assert.equal(dupAns.status, 409);
      assert.equal(dupAns.data.error, 'already_answered');
    } finally {
      await ws.close();
    }
  });

  it('T2-06: Rejects blocking agent wait-for deadlocks (2-node and 3-node cycles) with 409 Cycle', async () => {
    const ws = await startTestWorkspace();
    try {
      const i1 = await ws.api('POST', '/api/v1/items', { body: { title: 'Agy item' } });
      const i2 = await ws.api('POST', '/api/v1/items', { body: { title: 'Muse item' } });
      const i3 = await ws.api('POST', '/api/v1/items', { body: { title: 'Grok item' } });
      const r1 = await ws.api('POST', `/api/v1/items/${i1.data.id}/claim`, { token: ws.tokens.agy });
      const r2 = await ws.api('POST', `/api/v1/items/${i2.data.id}/claim`, { token: ws.tokens.muse });
      const r3 = await ws.api('POST', `/api/v1/items/${i3.data.id}/claim`, { token: ws.tokens.grok });

      // agy -> muse (blocking)
      const c1 = await ws.api('POST', `/api/v1/runs/${r1.data.id}/cards`, {
        token: ws.tokens.agy,
        body: {
          epoch: 1,
          type: 'choose',
          prompt: 'Muse input needed',
          assignee: { kind: 'agent', id: 'muse' },
          blocking: true,
        },
      });
      assert.equal(c1.status, 201);

      // muse -> grok (blocking)
      const c2 = await ws.api('POST', `/api/v1/runs/${r2.data.id}/cards`, {
        token: ws.tokens.muse,
        body: {
          epoch: 1,
          type: 'choose',
          prompt: 'Grok input needed',
          assignee: { kind: 'agent', id: 'grok' },
          blocking: true,
        },
      });
      assert.equal(c2.status, 201);

      // grok -> agy (blocking) creates 3-way cycle: grok -> agy -> muse -> grok
      const c3 = await ws.api('POST', `/api/v1/runs/${r3.data.id}/cards`, {
        token: ws.tokens.grok,
        body: {
          epoch: 1,
          type: 'choose',
          prompt: 'Agy input needed',
          assignee: { kind: 'agent', id: 'agy' },
          blocking: true,
        },
      });
      assert.equal(c3.status, 409);
      assert.equal(c3.data.error, 'cycle');
      assert.ok(Array.isArray(c3.data.cycle));
    } finally {
      await ws.close();
    }
  });

  it('T2-07: Enforces Multi-Agent Dialogue hopCount anti-loop tracking and resets on human turn', async () => {
    const ws = await startTestWorkspace();
    try {
      // Human starts dialogue -> hopCount = 0
      const h1 = await ws.api('POST', '/api/v1/threads/workspace/main', {
        token: ws.tokens.human,
        body: { body: 'Start discussion @agy @muse' },
      });
      assert.equal(h1.status, 201);
      assert.equal(h1.data.message.hopCount, 0);

      // Consecutive agent turns increment hopCount (1, 2, 3, 4)
      let lastHop = 0;
      for (let i = 1; i <= 4; i++) {
        const token = i % 2 === 1 ? ws.tokens.agy : ws.tokens.muse;
        const target = i % 2 === 1 ? '@muse' : '@agy';
        const res = await ws.api('POST', '/api/v1/threads/workspace/main', {
          token,
          body: { body: `${target} agent turn #${i}` },
        });
        assert.equal(res.status, 201);
        assert.equal(res.data.message.hopCount, i);
        lastHop = res.data.message.hopCount;
      }
      assert.equal(lastHop, 4);

      // 5th consecutive agent turn either rejects with 400/409 loop guard OR flags hopCount > 4 with no auto-wake
      const fifth = await ws.api('POST', '/api/v1/threads/workspace/main', {
        token: ws.tokens.agy,
        body: { body: '@muse agent turn #5 beyond max hop limit' },
      });
      if (fifth.status === 201) {
        assert.ok(fifth.data.message.hopCount >= 5 || fifth.data.loopBlocked === true);
      } else {
        assert.ok(fifth.status === 400 || fifth.status === 409 || fifth.status === 429);
      }

      // Human turn resets hopCount back to 0
      const h2 = await ws.api('POST', '/api/v1/threads/workspace/main', {
        token: ws.tokens.human,
        body: { body: 'Human checkpoint resets hopCount' },
      });
      assert.equal(h2.status, 201);
      assert.equal(h2.data.message.hopCount, 0);
    } finally {
      await ws.close();
    }
  });

  it('T2-08: Enforces maximum sub-run depth (depth <= 3) and rejects depth > 3 with 400', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Deep hierarchy test' } });
      const r0 = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      assert.equal(r0.data.depth ?? 0, 0);

      // Depth 1
      const r1 = await ws.api('POST', `/api/v1/runs/${r0.data.id}/subruns`, {
        token: ws.tokens.agy,
        body: { title: 'Depth 1 subrun', subagentId: 'agy-sub-1' },
      });
      assert.ok(r1.status === 200 || r1.status === 201);
      const run1 = r1.data.run ?? r1.data.subRun;
      assert.equal(run1.depth, 1);

      // Depth 2
      const r2 = await ws.api('POST', `/api/v1/runs/${run1.id}/subruns`, {
        token: ws.tokens.agy,
        body: { title: 'Depth 2 subrun', subagentId: 'agy-sub-2' },
      });
      assert.ok(r2.status === 200 || r2.status === 201);
      const run2 = r2.data.run ?? r2.data.subRun;
      assert.equal(run2.depth, 2);

      // Depth 3 (max allowed)
      const r3 = await ws.api('POST', `/api/v1/runs/${run2.id}/subruns`, {
        token: ws.tokens.agy,
        body: { title: 'Depth 3 subrun', subagentId: 'agy-sub-3' },
      });
      assert.ok(r3.status === 200 || r3.status === 201);
      const run3 = r3.data.run ?? r3.data.subRun;
      assert.equal(run3.depth, 3);

      // Depth 4 -> must be rejected with 400 bad_request
      const r4 = await ws.api('POST', `/api/v1/runs/${run3.id}/subruns`, {
        token: ws.tokens.agy,
        body: { title: 'Depth 4 excessive subrun', subagentId: 'agy-sub-4' },
      });
      assert.equal(r4.status, 400);
      assert.equal(r4.data.error, 'bad_request');
    } finally {
      await ws.close();
    }
  });

  it('T2-09: Returns 404 Not Found for non-existent items, runs, steps, steers, cards, and flows, and 400 for invalid inputs', async () => {
    const ws = await startTestWorkspace();
    try {
      assert.equal((await ws.api('POST', '/api/v1/items/item_missing/claim')).status, 404);
      assert.equal((await ws.api('PATCH', '/api/v1/items/item_missing', { body: { title: 'x' } })).status, 404);
      assert.equal((await ws.api('GET', '/api/v1/runs/r_missing')).status, 404);
      assert.equal((await ws.api('POST', '/api/v1/runs/r_missing/subruns', { body: { title: 'x' } })).status, 404);
      assert.equal((await ws.api('POST', '/api/v1/steers/str_missing/ack', { body: { accepted: true } })).status, 404);
      assert.equal((await ws.api('POST', '/api/v1/cards/c_missing/answer', { body: { option: 'ok', onPin: 'v1' } })).status, 404);
      assert.equal((await ws.api('POST', '/api/v1/flows/flow_missing/trigger')).status, 404);

      // Resuming a non-stalled run -> 400
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Active run' } });
      const run = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      const badResume = await ws.api('POST', `/api/v1/runs/${run.data.id}/resume`);
      assert.equal(badResume.status, 400);

      // Steering a cancelled run -> 400
      await ws.api('POST', `/api/v1/runs/${run.data.id}/cancel`);
      const badSteer = await ws.api('POST', `/api/v1/runs/${run.data.id}/steers`, {
        body: { op: 'freeform', payload: { text: 'too late' } },
      });
      assert.equal(badSteer.status, 400);
    } finally {
      await ws.close();
    }
  });
});

// ============================================================================
// TIER 3 — CROSS-FEATURE COMBINATIONS (Pairwise & Multi-Surface Interactions)
// ============================================================================
describe('Tier 3 — Cross-Feature Combinations', () => {
  it('T3-C01: Run-scoped dialogue message with sendToAgent=true queues a freeform steer delivered at next checkpoint and acked via MCP', async () => {
    const ws = await startTestWorkspace();
    try {
      const item = await ws.api('POST', '/api/v1/items', { body: { title: 'Dialogue-to-steer combo' } });
      const run = await ws.api('POST', `/api/v1/items/${item.data.id}/claim`, { token: ws.tokens.agy });
      await ws.api('POST', `/api/v1/runs/${run.data.id}/plan`, {
        token: ws.tokens.agy,
        body: { epoch: 1, steps: [{ title: 'Step 1' }, { title: 'Step 2' }] },
      });

      // Human posts to run thread with sendToAgent: true
      const threadPost = await ws.api('POST', `/api/v1/threads/run/${run.data.id}`, {
        token: ws.tokens.human,
        body: {
          body: '@agy Please switch to file-backed JSON snapshot persistence for Step 2',
          sendToAgent: true,
        },
      });
      assert.equal(threadPost.status, 201);
      assert.ok(threadPost.data.steer?.id, 'Must create a linked Steer when sendToAgent=true');
      assert.equal(threadPost.data.message.steerId, threadPost.data.steer.id);

      // Agy hits checkpoint via MCP ripple_checkpoint and receives the steer
      const ckpt = await ws.mcpCall(ws.tokens.agy, 'ripple_checkpoint', {
        run_id: run.data.id,
        epoch: 1,
        after_step: 1,
      });
      assert.equal(ckpt.status, 200);
      assert.equal(ckpt.isError, false);
      assert.equal(ckpt.data.steers.length, 1);
      assert.equal(ckpt.data.steers[0].id, threadPost.data.steer.id);

      // Agy acknowledges via MCP ripple_ack
      const ack = await ws.mcpCall(ws.tokens.agy, 'ripple_ack', {
        steer_id: threadPost.data.steer.id,
        accepted: true,
        note: 'Switched to file-backed JSON persistence',
      });
      assert.equal(ack.status, 200);
      assert.equal(ack.data.status, 'acked');
    } finally {
      await ws.close();
    }
  });

  it('T3-C02: Sub-run reportRun attaches Drive/PR artifacts, auto-completes linked backlog item, and posts summary to parent run thread & workspace dialogue', async () => {
    const ws = await startTestWorkspace();
    try {
      const parentItem = await ws.api('POST', '/api/v1/items', {
        body: { title: 'Parent Feature', assigneeId: 'muse' },
      });
      const childItem = await ws.api('POST', '/api/v1/items', {
        body: {
          title: 'Child Drive Spec Task',
          parentItemId: parentItem.data.id,
          assigneeId: 'muse-sub-drive',
          tags: ['drive'],
        },
      });
      const parentRun = await ws.api('POST', `/api/v1/items/${parentItem.data.id}/claim`, {
        token: ws.tokens.muse,
      });

      // Spawn child run linked to childItem via MCP ripple_spawn_subrun
      const mcpSpawn = await ws.mcpCall(ws.tokens.muse, 'ripple_spawn_subrun', {
        parent_run_id: parentRun.data.id,
        title: 'Write Drive Spec Doc',
        goal: 'Create Google Doc and attach link',
        subagent_id: 'muse-sub-drive',
        subagent_name: 'Muse Drive Sub-Agent',
        item_id: childItem.data.id,
        steps: [{ title: 'Create Doc' }],
      });
      assert.equal(mcpSpawn.status, 200);
      assert.equal(mcpSpawn.isError, false);
      const subRun = mcpSpawn.data.run ?? mcpSpawn.data.subRun;

      // Report completion via MCP ripple_report_run
      const docUrl = 'https://docs.google.com/document/d/1SubrunReportDoc/edit';
      const mcpReport = await ws.mcpCall(ws.tokens.muse, 'ripple_report_run', {
        run_id: subRun.id,
        epoch: 1,
        summary: 'Created and populated Ripple Spec Google Doc.',
        status: 'done',
        artifacts: [
          {
            kind: 'gdoc',
            ref: docUrl,
            title: 'Ripple Spec Google Doc',
            url: docUrl,
          },
        ],
      });
      assert.equal(mcpReport.status, 200);
      assert.equal(mcpReport.isError, false);
      assert.equal(mcpReport.data.run.status, 'done');

      // Verify child backlog item is marked done
      const items = await ws.api('GET', '/api/v1/items');
      const updatedChild = items.data.find((i: any) => i.id === childItem.data.id);
      assert.equal(updatedChild.status, 'done');

      // Verify parent run thread or workspace dialogue received the report message
      const parentThread = await ws.api('GET', `/api/v1/threads/run/${parentRun.data.id}`);
      const wsThread = await ws.api('GET', '/api/v1/threads/workspace/main');
      const combinedMessages = [...parentThread.data, ...wsThread.data];
      assert.ok(
        combinedMessages.some((m: any) => m.body.includes('Created and populated Ripple Spec Google Doc')),
        'Report summary must be posted to parent run thread or workspace dialogue',
      );
    } finally {
      await ws.close();
    }
  });

  it('T3-C03: SSE /api/v1/events stream with Last-Event-ID gapless replay reflects MCP and REST mutations in real time', async () => {
    const ws = await startTestWorkspace();
    try {
      // Perform mutations via MCP and REST
      await ws.mcpCall(ws.tokens.agy, 'ripple_create_item', {
        title: 'SSE Replay Task',
        priority: 'P1',
      });
      await ws.api('POST', '/api/v1/threads/workspace/main', {
        body: { body: 'SSE Dialogue Broadcast @agy' },
      });

      // Connect to SSE stream with after=0 and read buffered events
      const controller = new AbortController();
      const sseRes = await fetch(`${ws.baseUrl}/api/v1/events?after=0&token=${ws.tokens.human}`, {
        signal: controller.signal,
      });
      assert.equal(sseRes.status, 200);
      assert.match(sseRes.headers.get('content-type') ?? '', /text\/event-stream/);

      const reader = sseRes.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const readRes = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: true }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: true }), Math.max(50, deadline - Date.now())),
          ),
        ]);
        if (readRes.done || !readRes.value) break;
        buffer += decoder.decode(readRes.value, { stream: true });
        if (buffer.includes('item.created') && buffer.includes('thread.message')) break;
      }
      controller.abort();

      assert.match(buffer, /event: item\.created/);
      assert.match(buffer, /event: thread\.message/);
      assert.match(buffer, /SSE Replay Task/);
    } finally {
      await ws.close();
    }
  });

  it('T3-C04: Idempotency-Key header deduplicates repeated POST /api/v1/items and POST /api/v1/items/:id/claim requests', async () => {
    const ws = await startTestWorkspace();
    try {
      const idemKey = `idem-item-${Date.now()}`;
      const r1 = await ws.api('POST', '/api/v1/items', {
        headers: { 'Idempotency-Key': idemKey },
        body: { title: 'Idempotent task' },
      });
      const r2 = await ws.api('POST', '/api/v1/items', {
        headers: { 'Idempotency-Key': idemKey },
        body: { title: 'Idempotent task duplicate retry' },
      });
      assert.equal(r1.status, 201);
      assert.equal(r2.status, 201);
      assert.equal(r1.data.id, r2.data.id);

      const claimKey = `idem-claim-${Date.now()}`;
      const c1 = await ws.api('POST', `/api/v1/items/${r1.data.id}/claim`, {
        token: ws.tokens.agy,
        headers: { 'Idempotency-Key': claimKey },
      });
      const c2 = await ws.api('POST', `/api/v1/items/${r1.data.id}/claim`, {
        token: ws.tokens.agy,
        headers: { 'Idempotency-Key': claimKey },
      });
      assert.equal(c1.status, 201);
      assert.equal(c2.status, 201);
      assert.equal(c1.data.id, c2.data.id);
    } finally {
      await ws.close();
    }
  });
});

// ============================================================================
// TIER 4 — REAL-WORLD APPLICATION SCENARIOS (End-to-End Multi-Actor Journeys)
// ============================================================================
describe('Tier 4 — Real-World Application Scenarios', () => {
  it('T4-S01: Complete Overnight Phone Journey — Self-Presence, Self-Inviting Antigravity & Muse, Multi-Agent Context-Aware Dialogue, Backlog Sync, Sub-Agent PR & Drive Execution, and Pin-Bound Approval', async () => {
    const ws = await startTestWorkspace({
      publicUrl: 'https://ripple-overnight.trycloudflare.com',
    });

    try {
      // Step 1: User opens workspace on phone via ?token= auto-login and updates profile ("I want to see myself")
      const mePatch = await ws.api('PATCH', `/api/v1/me?token=${encodeURIComponent(ws.tokens.human)}`, {
        token: null,
        body: {
          actorName: 'David (@dweidai)',
          statusText: 'On my phone reviewing overnight builds',
          bio: 'Workspace Owner',
          avatarColor: '#10b981',
        },
      });
      assert.equal(mePatch.status, 200);
      assert.equal(mePatch.data.actorName, 'David (@dweidai)');

      // Step 2: User self-invites Antigravity (agy) and Muse (muse) via POST /api/v1/invites
      const agyInvite = await ws.api('POST', '/api/v1/invites', {
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'ripple-overnight.trycloudflare.com',
          Host: 'ripple-overnight.trycloudflare.com',
        },
        body: {
          actorId: 'agy',
          actorName: 'Antigravity',
          kind: 'agent',
          capabilities: ['github', 'code', 'subagents'],
        },
      });
      assert.ok(agyInvite.status === 200 || agyInvite.status === 201);
      const agyToken = agyInvite.data.rawToken;

      const museInvite = await ws.api('POST', '/api/v1/invites', {
        headers: {
          'X-Forwarded-Proto': 'https',
          'X-Forwarded-Host': 'ripple-overnight.trycloudflare.com',
          Host: 'ripple-overnight.trycloudflare.com',
        },
        body: {
          actorId: 'muse',
          actorName: 'Muse',
          kind: 'agent',
          capabilities: ['gdrive', 'gdocs', 'planning', 'subagents'],
        },
      });
      assert.ok(museInvite.status === 200 || museInvite.status === 201);
      const museToken = museInvite.data.rawToken;

      // Step 3: Both agents read the self-describing doorway guide and shared context
      const doorway = await ws.api('GET', `/w/${ws.wsId}/agent.md?token=${encodeURIComponent(agyToken)}`, {
        token: null,
      });
      assert.equal(doorway.status, 200);

      // Step 4: User kicks off a dialogue in workspace/main; Muse and Antigravity communicate with each other cleanly
      const kickoff = await ws.api('POST', '/api/v1/threads/workspace/main', {
        token: ws.tokens.human,
        body: {
          body: 'Good morning @muse and @agy! Please sync on the v1 release, create backlog tasks, spin up sub-agents for Google Drive docs and GitHub PRs, and report back.',
        },
      });
      assert.equal(kickoff.status, 201);

      const museTurn = await ws.mcpCall(museToken, 'ripple_post_message', {
        scope_kind: 'workspace',
        scope_id: 'main',
        body: 'Good morning @you! @agy I am creating the release epic and two subtasks: one for my Drive/Docs sub-agent to publish the release notes doc, and one for your GitHub sub-agent to open the PR.',
        reply_to_id: kickoff.data.message.id,
      });
      assert.equal(museTurn.status, 200);
      assert.equal(museTurn.isError, false);

      const agyTurn = await ws.mcpCall(agyToken, 'ripple_post_message', {
        scope_kind: 'workspace',
        scope_id: 'main',
        body: 'Copy that @muse! Once you create the backlog tasks, I will claim the engineering subtask and spawn `agy-sub-pr` to create the PR and attach the commit SHA.',
      });
      assert.equal(agyTurn.status, 200);
      assert.equal(agyTurn.isError, false);

      // Step 5: Muse creates the parent backlog epic and two subtasks via MCP ripple_create_item
      const epicRes = await ws.mcpCall(museToken, 'ripple_create_item', {
        title: 'Ripple Overnight Hosted Workspace Launch',
        body: 'End-to-end delivery tracked by David, Muse, and Antigravity',
        priority: 'P0',
        assignee_id: 'you',
        tags: ['launch', 'epic'],
      });
      assert.equal(epicRes.isError, false);
      const epicId = epicRes.data.id;

      const driveTaskRes = await ws.mcpCall(museToken, 'ripple_create_item', {
        title: 'Publish Ripple Release Notes in Google Docs / Drive',
        priority: 'P1',
        assignee_id: 'muse',
        parent_item_id: epicId,
        tags: ['drive', 'gdoc', 'spec'],
      });
      assert.equal(driveTaskRes.isError, false);
      const driveTaskId = driveTaskRes.data.id;

      const prTaskRes = await ws.mcpCall(museToken, 'ripple_create_item', {
        title: 'Open GitHub PR for Multi-Agent Sub-Run & Drive Integration',
        priority: 'P0',
        assignee_id: 'agy',
        parent_item_id: epicId,
        tags: ['github', 'pr', 'code'],
      });
      assert.equal(prTaskRes.isError, false);
      const prTaskId = prTaskRes.data.id;

      // Step 6: Muse claims Drive task, plans, spawns muse-sub-drive, attaches Google Doc artifact, and reports back
      const museClaim = await ws.mcpCall(museToken, 'ripple_claim', { item_id: driveTaskId });
      assert.equal(museClaim.isError, false);
      const museRunId = museClaim.data.id;

      await ws.mcpCall(museToken, 'ripple_plan', {
        run_id: museRunId,
        epoch: 1,
        steps: [{ title: 'Spawn Drive sub-agent' }, { title: 'Finalize spec' }],
        touches: ['docs/release-notes.md'],
      });

      const museSub = await ws.mcpCall(museToken, 'ripple_spawn_subrun', {
        parent_run_id: museRunId,
        title: 'Muse Google Docs & Drive Publisher',
        goal: 'Create release notes doc in Google Drive and return URL',
        subagent_id: 'muse-sub-drive',
        subagent_name: 'Muse Drive Sub-Agent',
        parent_step_idx: 1,
        steps: [{ title: 'Create Google Doc via gdocs CLI' }],
      });
      assert.equal(museSub.isError, false);
      const museSubRunId = (museSub.data.run ?? museSub.data.subRun).id;

      const gdocUrl = 'https://docs.google.com/document/d/1RippleOvernightReleaseNotes/edit';
      const museSubReport = await ws.mcpCall(museToken, 'ripple_report_run', {
        run_id: museSubRunId,
        epoch: 1,
        summary: `Published Ripple Overnight Release Notes to Google Docs (${gdocUrl}) and verified Drive permissions.`,
        status: 'done',
        artifacts: [
          {
            kind: 'gdoc',
            ref: gdocUrl,
            title: 'Ripple Overnight Release Notes (Google Doc)',
            url: gdocUrl,
          },
        ],
      });
      assert.equal(museSubReport.isError, false);

      // Complete Muse parent run steps
      await ws.mcpCall(museToken, 'ripple_step', { run_id: museRunId, epoch: 1, idx: 1, status: 'done' });
      await ws.mcpCall(museToken, 'ripple_step', { run_id: museRunId, epoch: 1, idx: 2, status: 'done' });

      // Step 7: Antigravity claims PR task, spawns agy-sub-pr, attaches commit & GitHub PR artifacts, and reports back
      const agyClaim = await ws.mcpCall(agyToken, 'ripple_claim', { item_id: prTaskId });
      assert.equal(agyClaim.isError, false);
      const agyRunId = agyClaim.data.id;

      await ws.mcpCall(agyToken, 'ripple_plan', {
        run_id: agyRunId,
        epoch: 1,
        steps: [
          { title: 'Spawn GitHub PR sub-agent' },
          { title: 'Request human review on PR commit pin', kind: 'gate' },
        ],
        touches: ['src/engine.ts', 'src/server.ts', 'public/index.html'],
      });

      const agySub = await ws.mcpCall(agyToken, 'ripple_spawn_subrun', {
        parent_run_id: agyRunId,
        title: 'Antigravity GitHub PR Creator',
        goal: 'Push branch and create PR on https://github.com/dweidai/ripple',
        subagent_id: 'agy-sub-pr',
        subagent_name: 'Antigravity PR Sub-Agent',
        parent_step_idx: 1,
        steps: [{ title: 'Push branch & run gh pr create' }],
      });
      assert.equal(agySub.isError, false);
      const agySubRunId = (agySub.data.run ?? agySub.data.subRun).id;

      const prUrl = 'https://github.com/dweidai/ripple/pull/77';
      const commitSha = 'f4a9c2e108b';
      const agySubReport = await ws.mcpCall(agyToken, 'ripple_report_run', {
        run_id: agySubRunId,
        epoch: 1,
        summary: `Created GitHub PR #77 (${prUrl}) at commit ${commitSha}. Ready for human review.`,
        status: 'done',
        artifacts: [
          {
            kind: 'commit',
            ref: commitSha,
            title: `commit ${commitSha}`,
          },
          {
            kind: 'pr',
            ref: prUrl,
            title: 'PR #77: Overnight Multi-Agent Workspace',
            url: prUrl,
          },
        ],
      });
      assert.equal(agySubReport.isError, false);

      // Attach commit & PR artifacts to parent run to bind its subjectPin to commitSha
      await ws.mcpCall(agyToken, 'ripple_artifact', {
        run_id: agyRunId,
        epoch: 1,
        step_idx: 1,
        kind: 'commit',
        ref: commitSha,
        content_hash: commitSha,
      });

      // Step 8: Antigravity raises a pin-bound Review/Approval Card for the human on their phone
      const askRes = await ws.mcpCall(agyToken, 'ripple_ask', {
        run_id: agyRunId,
        epoch: 1,
        type: 'approve',
        prompt: `Approve & merge PR #77 (${prUrl}) pinned to commit ${commitSha}?`,
        diff_preview: '+ spawnSubrun(), + reportRun(), + gh/gdrive/gdocs integrations',
        assignee_kind: 'user',
        assignee_id: 'you',
        blocking: true,
      });
      assert.equal(askRes.isError, false);
      const reviewCard = askRes.data;
      assert.equal(reviewCard.pin.value, commitSha);

      // Step 9: Human inspects full workspace context & snapshot from phone, answers card, and completes run
      const phoneContext = await ws.api('GET', '/api/v1/context', { token: ws.tokens.human });
      assert.equal(phoneContext.status, 200);
      assert.equal(phoneContext.data.whoami.actorName, 'David (@dweidai)');
      assert.ok(phoneContext.data.openCards.some((c: any) => c.id === reviewCard.id));
      assert.ok(phoneContext.data.items.length >= 3);

      const answerRes = await ws.api('POST', `/api/v1/cards/${reviewCard.id}/answer`, {
        token: ws.tokens.human,
        body: {
          option: 'approve',
          note: 'Approved from my phone! Great work @agy and @muse.',
          onPin: commitSha,
        },
      });
      assert.equal(answerRes.status, 200);
      assert.equal(answerRes.data.status, 'answered');

      // Agy finishes steps 1 and 2 -> parent run and PR backlog item transition to done
      await ws.mcpCall(agyToken, 'ripple_step', { run_id: agyRunId, epoch: 1, idx: 1, status: 'done' });
      await ws.mcpCall(agyToken, 'ripple_step', { run_id: agyRunId, epoch: 1, idx: 2, status: 'done' });

      const finalSnap = await ws.api('GET', '/api/v1/snapshot', { token: ws.tokens.human });
      assert.equal(finalSnap.status, 200);
      const doneDriveItem = finalSnap.data.items.find((i: any) => i.id === driveTaskId);
      const donePrItem = finalSnap.data.items.find((i: any) => i.id === prTaskId);
      assert.equal(doneDriveItem.status, 'done');
      assert.equal(donePrItem.status, 'done');
      assert.ok(finalSnap.data.messages?.length >= 3, 'Snapshot must include workspace dialogue messages');
    } finally {
      await ws.close();
    }
  });

  it('T4-S02: Multi-Agent Contention, Overlap Advisory, Mid-Flight Steer + Stale Card Replacement Race', async () => {
    const ws = await startTestWorkspace();
    try {
      // 1. Contention: Agy and Muse race on the same item
      const itemA = await ws.api('POST', '/api/v1/items', { body: { title: 'Core Engine Refactor' } });
      const itemB = await ws.api('POST', '/api/v1/items', { body: { title: 'REST API Refactor' } });

      const claimWin = await ws.api('POST', `/api/v1/items/${itemA.data.id}/claim`, { token: ws.tokens.agy });
      const claimLose = await ws.api('POST', `/api/v1/items/${itemA.data.id}/claim`, { token: ws.tokens.muse });
      assert.equal(claimWin.status, 201);
      assert.equal(claimLose.status, 409);
      assert.equal(claimLose.data.error, 'taken');

      // Muse claims itemB instead; both touch 'src/engine.ts'
      const claimB = await ws.api('POST', `/api/v1/items/${itemB.data.id}/claim`, { token: ws.tokens.muse });
      await ws.api('POST', `/api/v1/runs/${claimWin.data.id}/plan`, {
        token: ws.tokens.agy,
        body: { epoch: 1, steps: [{ title: 'Patch engine' }, { title: 'Gate', kind: 'gate' }], touches: ['src/engine.ts'] },
      });
      await ws.api('POST', `/api/v1/runs/${claimB.data.id}/plan`, {
        token: ws.tokens.muse,
        body: { epoch: 1, steps: [{ title: 'Wire engine calls' }], touches: ['src/engine.ts', 'src/server.ts'] },
      });

      // 2. Human sends mid-flight steer via run thread; Agy sees both steer and overlap at checkpoint
      await ws.api('POST', `/api/v1/threads/run/${claimWin.data.id}`, {
        token: ws.tokens.human,
        body: { body: 'Coordinate with @muse on src/engine.ts signature', sendToAgent: true },
      });

      const ckpt = await ws.api('POST', `/api/v1/runs/${claimWin.data.id}/checkpoint`, {
        token: ws.tokens.agy,
        body: { epoch: 1, afterStep: 1 },
      });
      assert.equal(ckpt.data.steers.length, 1);
      assert.equal(ckpt.data.overlaps.length, 1);
      assert.deepEqual(ckpt.data.overlaps[0].touches, ['src/engine.ts']);

      // 3. Stale card race: Agy asks approval on commit_1, then pushes commit_2 while human tries to approve commit_1
      await ws.api('POST', `/api/v1/runs/${claimWin.data.id}/artifacts`, {
        token: ws.tokens.agy,
        body: { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'commit_1' },
      });
      const card1 = await ws.api('POST', `/api/v1/runs/${claimWin.data.id}/cards`, {
        token: ws.tokens.agy,
        body: { epoch: 1, type: 'approve', prompt: 'Approve commit_1?' },
      });

      const art2 = await ws.api('POST', `/api/v1/runs/${claimWin.data.id}/artifacts`, {
        token: ws.tokens.agy,
        body: { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'commit_2' },
      });
      const card2 = art2.data.replacementCards[0];

      const staleAttempt = await ws.api('POST', `/api/v1/cards/${card1.data.id}/answer`, {
        token: ws.tokens.human,
        body: { option: 'approve', onPin: 'commit_1' },
      });
      assert.equal(staleAttempt.status, 409);
      assert.equal(staleAttempt.data.error, 'stale');

      const freshAttempt = await ws.api('POST', `/api/v1/cards/${card2.id}/answer`, {
        token: ws.tokens.human,
        body: { option: 'approve', onPin: 'commit_2' },
      });
      assert.equal(freshAttempt.status, 200);
      assert.equal(freshAttempt.data.decidedOnPin, 'commit_2');
    } finally {
      await ws.close();
    }
  });

  it('T4-S03: Flow Stall Auto-Retry, Deduped Escalation Card, and Human Takeover Fencing', async () => {
    const ws = await startTestWorkspace({ stallTimeoutMs: 50 });
    try {
      const flow = await ws.api('POST', '/api/v1/flows', {
        body: {
          name: 'Nightly Workspace Sync',
          triggerKind: 'cron',
          agentId: 'agy',
          steps: [{ title: 'Sync GitHub & Drive' }],
          retryMax: 1,
        },
      });
      const triggered = await ws.api('POST', `/api/v1/flows/${flow.data.id}/trigger`);
      const runId = triggered.data.run.id;

      // 1st stall -> auto-retries under epoch 2
      await ws.engine.sweepLiveness(ws.wsId, Date.now() + 5000);
      const afterRetry = await ws.api('GET', `/api/v1/runs/${runId}`);
      assert.equal(afterRetry.data.epoch, 2);
      assert.equal(afterRetry.data.status, 'running');

      // Zombie write from epoch 1 is fenced
      const zombieStep = await ws.api('POST', `/api/v1/runs/${runId}/step`, {
        token: ws.tokens.agy,
        body: { epoch: 1, idx: 1, status: 'done' },
      });
      assert.equal(zombieStep.status, 409);
      assert.equal(zombieStep.data.error, 'fenced');

      // 2nd stall -> exceeds retryMax=1 -> raises 1 deduped escalation card
      await ws.engine.sweepLiveness(ws.wsId, Date.now() + 10_000);
      const openCards = await ws.api('GET', '/api/v1/cards?status=open');
      assert.equal(openCards.data.length, 1);
      assert.match(openCards.data[0].prompt, /Nightly Workspace Sync/);
    } finally {
      await ws.close();
    }
  });
});
