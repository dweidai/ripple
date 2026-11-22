import { getRequestListener } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createGitHubPullRequest,
  createGoogleDoc,
  inspectGitHubRepo,
  listRecentDriveFiles,
  readGoogleDoc,
  searchDriveFiles,
} from './agents/tools.js';
import type { MultiAgentBridge } from './agents/bridge.js';
import { AuthService, recordToPrincipal } from './auth.js';
import { RippleEngine } from './engine.js';
import { Errors, RippleError } from './errors.js';
import { handleMcpHttpRequest } from './mcp.js';
import type { Principal } from './types.js';

type Env = {
  Variables: {
    principal: Principal;
  };
};

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '..');
const publicUrlFilePath = path.resolve(repoRoot, '.ripple-data/public_url.txt');

export function resolvePublicUrl(c: Context, fallback = 'http://localhost:8787'): string {
  // 1. Check forwarded headers first (Cloudflare tunnel / reverse proxy / specific request host)
  const forwardedProto = c.req.header('x-forwarded-proto');
  const forwardedHost = c.req.header('x-forwarded-host') ?? c.req.header('host');
  if (forwardedHost && (forwardedProto || forwardedHost.includes('trycloudflare.com') || (!forwardedHost.includes('localhost') && !forwardedHost.includes('127.0.0.1')))) {
    const proto = forwardedProto ?? (forwardedHost.includes('trycloudflare.com') ? 'https' : 'http');
    return `${proto}://${forwardedHost}`.replace(/\/$/, '');
  }

  // 2. Check live tunnel URL file if present
  try {
    if (fsSync.existsSync(publicUrlFilePath)) {
      const fromFile = fsSync.readFileSync(publicUrlFilePath, 'utf8').trim();
      if (fromFile.startsWith('http://') || fromFile.startsWith('https://')) {
        return fromFile.replace(/\/$/, '');
      }
    }
  } catch {
    // ignore read error
  }

  // 3. Check explicit PUBLIC_URL env var if not localhost
  if (
    process.env.PUBLIC_URL &&
    !process.env.PUBLIC_URL.includes('localhost') &&
    !process.env.PUBLIC_URL.includes('127.0.0.1')
  ) {
    return process.env.PUBLIC_URL.replace(/\/$/, '');
  }

  if (forwardedHost && !fallback.includes('trycloudflare.com')) {
    return `http://${forwardedHost}`.replace(/\/$/, '');
  }

  return fallback.replace(/\/$/, '');
}

function buildOnboardingBundle(base: string, wsId: string, actorId: string, actorName: string, rawToken: string) {
  const doorwayUrl = `${base}/w/${wsId}/agent.md?token=${encodeURIComponent(rawToken)}`;
  return {
    publicUrl: base,
    mcpJson: {
      mcpServers: {
        ripple: {
          url: `${base}/mcp`,
          headers: {
            Authorization: `Bearer ${rawToken}`,
          },
        },
      },
    },
    cliCommand: `RIPPLE_URL="${base}" RIPPLE_TOKEN="${rawToken}" npx tsx src/cli.ts context`,
    doorwayUrl,
    doorwayPrompt: `You are invited to Project Ripple as ${actorName} (@${actorId}). Read ${doorwayUrl} to connect via MCP (${base}/mcp) or REST (${base}/api/v1) with Bearer token ${rawToken}.`,
    bootstrapCurl: `curl -fsSL -H "Authorization: Bearer ${rawToken}" "${base}/bootstrap"`,
  };
}

function renderDoorwayMarkdown(opts: {
  base: string;
  wsId: string;
  token?: string;
  whoami?: Principal | null;
  participants: Principal[];
}): string {
  const tok = opts.token || '<YOUR_RIPPLE_TOKEN>';
  const actorLine = opts.whoami
    ? `Authenticated as **${opts.whoami.actorName}** (\`@${opts.whoami.actorId}\`, kind: \`${opts.whoami.kind}\`).`
    : `Pass \`?token=rpl_...\` or \`Authorization: Bearer rpl_...\` to authenticate.`;

  return `# Ripple Workspace Doorway Guide (\`${opts.wsId}\`)

${actorLine}

- **Public Workspace URL**: ${opts.base}
- **Streamable HTTP MCP Endpoint**: \`${opts.base}/mcp\`
- **REST API Base**: \`${opts.base}/api/v1\`
- **Live SSE Event Stream**: \`${opts.base}/api/v1/events\`

## 1. Quick Connect via Remote MCP (\`/mcp\`)
Add this to your MCP configuration (\`antigravity-mcp.json\` / \`muse-mcp.json\`):
\`\`\`json
{
  "mcpServers": {
    "ripple": {
      "url": "${opts.base}/mcp",
      "headers": {
        "Authorization": "Bearer ${tok}"
      }
    }
  }
}
\`\`\`

## 2. Quick Connect via CLI or REST
\`\`\`bash
# Fetch full workspace context (dialogue, backlog tasks, runs, sub-runs, cards)
curl -fsSL -H "Authorization: Bearer ${tok}" "${opts.base}/api/v1/context"

# Post a message in Workspace Dialogue (#main)
curl -fsSL -X POST -H "Authorization: Bearer ${tok}" -H "Content-Type: application/json" \\
  "${opts.base}/api/v1/threads/workspace/main" \\
  -d '{"body":"@you @agy @muse Ready and synced with workspace context!"}'
\`\`\`

## 3. Available 18 MCP Tools
1. \`ripple_get_context\` — Get full situational awareness (participants, recent dialogue, items, active runs, subrun tree, open cards, artifacts)
2. \`ripple_list_items\` — List backlog items, runs, and open decision cards
3. \`ripple_create_item\` — Create a backlog item or subtask (\`title\`, \`body\`, \`priority\`, \`assignee_id\`, \`parent_item_id\`, \`tags\`)
4. \`ripple_update_item\` — Update item status, assignee, priority, tags, or result URL
5. \`ripple_claim\` — Claim an open item to start a single-writer Run (\`epoch = 1\`)
6. \`ripple_plan\` — Post or update ordered steps and \`touches[]\`
7. \`ripple_step\` — Update step status (\`pending\`, \`active\`, \`done\`, \`failed\`, \`skipped\`)
8. \`ripple_spawn_subrun\` — Spawn a hierarchical child Run and sub-agent (\`agy-sub-github\`, \`muse-sub-drive\`) up to depth 3
9. \`ripple_report_run\` — Report sub-agent completion summary, attach \`pr\` / \`gdoc\` / \`drive\` / \`commit\` artifacts, and post back to parent run & workspace dialogue
10. \`ripple_artifact\` — Attach a pin-bound artifact (\`commit\`, \`pr\`, \`file\`, \`url\`, \`drive\`, \`gdoc\`)
11. \`ripple_checkpoint\` — Report a safe checkpoint and receive queued steers & overlap warnings
12. \`ripple_heartbeat\` — Refresh run liveness (every <=60s)
13. \`ripple_ack\` — Idempotently acknowledge a human steer
14. \`ripple_ask\` — Raise a pin-bound Decision Card (\`approve\`, \`choose\`, \`provide\`, \`review\`)
15. \`ripple_answer_card\` — Answer an agent-assigned Decision Card with CAS \`on_pin\`
16. \`ripple_await\` — Long-poll until a Decision Card is answered
17. \`ripple_post_message\` — Post to workspace dialogue (\`workspace/main\`) or run thread with \`@mentions\`
18. \`ripple_read_messages\` — Read workspace dialogue or run thread messages

## 4. Active Workspace Roster
${opts.participants.map((p) => `- **${p.actorName}** (\`@${p.actorId}\`, ${p.kind}${p.parentAgentId ? `, sub-agent of @${p.parentAgentId}` : ''}) — ${p.statusText ?? 'Ready'}`).join('\n')}
`;
}

export function createRippleApp(
  engine: RippleEngine,
  auth: AuthService,
  publicUrl = 'http://localhost:8787',
  bridge?: MultiAgentBridge,
) {
  const app = new Hono<Env>();

  app.use('*', cors());

  app.onError((err, c) => {
    if (err instanceof RippleError) {
      return c.json(err.toJSON(), err.status as any);
    }
    console.error('[ripple] unhandled error:', err);
    return c.json({ error: 'internal_error', message: err.message }, 500);
  });

  // Health check
  app.get('/healthz', (c) =>
    c.json({
      ok: true,
      service: 'ripple',
      publicUrl: resolvePublicUrl(c, publicUrl),
    }),
  );

  // Doorway URL for any agent harness (unauthenticated overview or authenticated whoami)
  app.get('/bootstrap', async (c) => {
    let whoami: Principal | null = null;
    const rawHeader =
      c.req.header('Authorization') ??
      (c.req.query('token') ? `Bearer ${c.req.query('token')}` : null);
    try {
      whoami = await auth.authenticate(rawHeader);
    } catch {
      whoami = null;
    }
    const base = resolvePublicUrl(c, publicUrl);
    const wsId = whoami?.wsId ?? 'ws_default';
    const tokens = await engine.store.listTokens(wsId);
    const participants = tokens.map(recordToPrincipal);

    return c.json({
      service: 'ripple',
      principle: 'Runs with Gates — state parity, not surface parity',
      public_url: base,
      publicUrl: base,
      workspace_id: wsId,
      mcp_endpoint: `${base}/mcp`,
      rest_base: `${base}/api/v1`,
      sse_events: `${base}/api/v1/events`,
      agent_guide_md: `${base}/w/${wsId}/agent.md`,
      whoami,
      participants,
      workflow: [
        '1. GET /api/v1/context (or MCP ripple_get_context) to inspect dialogue, tasks, active runs, and cards',
        '2. POST /api/v1/threads/workspace/main (or MCP ripple_post_message) to converse with @you, @agy, @muse',
        '3. POST /api/v1/items or PATCH /api/v1/items/:id to create/sync backlog tasks and subtasks',
        '4. POST /api/v1/items/:id/claim -> returns { id: run_id, epoch: 1 }',
        '5. POST /api/v1/runs/:id/plan with ordered steps[] and touches[]',
        '6. POST /api/v1/runs/:id/subruns (or MCP ripple_spawn_subrun) to spin up sub-agents for GitHub PRs or Google Drive/Docs',
        '7. POST /api/v1/runs/:id/report (or MCP ripple_report_run) to attach PR/Drive artifacts and report back',
        '8. Use POST /api/v1/runs/:id/cards to ask a pin-bound decision, then GET /api/v1/cards/:id/await',
      ],
    });
  });

  // Markdown Doorway Guide (/w/:wsId/agent.md and /agent.md)
  const handleAgentMd = async (c: Context) => {
    const wsId = c.req.param('wsId') || 'ws_default';
    const queryToken = c.req.query('token');
    const rawHeader =
      c.req.header('Authorization') ?? (queryToken ? `Bearer ${queryToken}` : null);
    let whoami: Principal | null = null;
    try {
      whoami = await auth.authenticate(rawHeader);
    } catch {
      whoami = null;
    }
    const base = resolvePublicUrl(c, publicUrl);
    const tokens = await engine.store.listTokens(whoami?.wsId ?? wsId);
    const md = renderDoorwayMarkdown({
      base,
      wsId: whoami?.wsId ?? wsId,
      token: queryToken,
      whoami,
      participants: tokens.map(recordToPrincipal),
    });
    return c.text(md, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  };
  app.get('/w/:wsId/agent.md', handleAgentMd);
  app.get('/agent.md', handleAgentMd);

  // Public starter / phone auto-login helper so opening the URL on a phone logs straight in as David (@dweidai)
  app.get('/api/v1/demo-actors', async (c) => {
    const wsId = c.req.query('ws_id') || 'ws_default';
    const tokens = await engine.store.listTokens(wsId);
    const base = resolvePublicUrl(c, publicUrl);
    const actors = tokens.map((t) => ({
      actorId: t.actorId,
      actorName: t.actorName,
      kind: t.kind,
      roles: t.roles,
      parentAgentId: t.parentAgentId,
      avatarColor: t.avatarColor,
      statusText: t.statusText,
      online: t.online ?? true,
      rawToken: t.rawToken,
    }));
    const defaultHuman = actors.find((a) => a.kind === 'human') ?? actors[0];
    return c.json({
      publicUrl: base,
      defaultToken: defaultHuman?.rawToken ?? 'rpl_human_dev_token',
      defaultActor: defaultHuman,
      actors,
    });
  });

  // Serve Web UI
  const possibleHtmlPaths = [
    path.resolve(dir, '../public/index.html'),
    path.resolve(dir, '../../public/index.html'),
    path.resolve(process.cwd(), 'public/index.html'),
  ];
  let cachedHtml: string | null = null;
  app.get('/', async (c) => {
    if (!cachedHtml) {
      for (const p of possibleHtmlPaths) {
        try {
          cachedHtml = await fs.readFile(p, 'utf8');
          break;
        } catch {
          // try next
        }
      }
    }
    if (!cachedHtml) {
      return c.text('Ripple Web UI index.html not found', 500);
    }
    return c.html(cachedHtml);
  });

  // Auth middleware for /api/v1/*
  const api = new Hono<Env>();
  api.use('*', async (c, next) => {
    // Allow token via query param for EventSource (SSE) or phone links
    const header =
      c.req.header('Authorization') ??
      (c.req.query('token') ? `Bearer ${c.req.query('token')}` : null);
    const principal = await auth.authenticate(header);
    c.set('principal', principal);
    await next();
  });

  // Idempotency helper for write endpoints
  async function withIdempotency<T>(
    key: string | undefined,
    wsId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!key) return fn();
    const cached = await engine.store.getIdempotency(key);
    if (cached !== undefined) return cached as T;
    const res = await fn();
    await engine.store.saveIdempotency(key, wsId, res);
    return res;
  }

  api.get('/whoami', (c) => c.json(c.get('principal')));

  // Update human/actor profile ("See myself")
  api.patch('/me', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const updated = await engine.updateProfile(p, {
      actorName: body.actorName ?? body.actor_name,
      statusText: body.statusText ?? body.status_text,
      bio: body.bio,
      avatarColor: body.avatarColor ?? body.avatar_color,
    });
    return c.json(updated);
  });

  // Structured Multi-Agent Context endpoint
  api.get('/context', async (c) => {
    const p = c.get('principal');
    const base = resolvePublicUrl(c, publicUrl);
    const runId = c.req.query('run_id');
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const ctx = await engine.getContext(p, { runId, limit, publicUrl: base });
    return c.json(ctx);
  });

  // Workspace snapshot for the UI
  api.get('/snapshot', async (c) => {
    const p = c.get('principal');
    const base = resolvePublicUrl(c, publicUrl);
    const [items, runs, cards, flows, events, tokens, workspaceMessages] = await Promise.all([
      engine.store.listItems(p.wsId),
      engine.store.listRuns(p.wsId),
      engine.store.listCards(p.wsId),
      engine.store.listFlows(p.wsId),
      engine.store.listEvents(p.wsId, 0, 60),
      engine.store.listTokens(p.wsId),
      engine.store.listThreadMessages(p.wsId, 'workspace', 'main'),
    ]);

    const allSteps: any[] = [];
    const allSteers: any[] = [];
    const allArtifacts: any[] = [];

    const runsWithDetails = await Promise.all(
      runs.map(async (r) => {
        const [steps, steers, artifacts] = await Promise.all([
          engine.store.listSteps(r.id),
          engine.store.listSteers(r.id),
          engine.store.listArtifacts(r.id),
        ]);
        allSteps.push(...steps);
        allSteers.push(...steers);
        allArtifacts.push(...artifacts);
        return {
          ...r,
          steps,
          steers,
          artifacts,
        };
      }),
    );

    const flowsWithHistory = flows.map((f) => {
      const flowRuns = runs
        .filter((r) => r.flowTemplateId === f.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-14);
      return {
        ...f,
        recentRuns: flowRuns.map((r) => ({
          id: r.id,
          status: r.status,
          epoch: r.epoch,
          createdAt: r.createdAt,
        })),
      };
    });

    return c.json({
      publicUrl: base,
      whoami: p,
      items,
      runs: runsWithDetails,
      steps: allSteps,
      steers: allSteers,
      artifacts: allArtifacts,
      cards,
      flows: flowsWithHistory,
      messages: workspaceMessages,
      events: events.reverse(),
      agents: tokens.map((t) => ({
        ...recordToPrincipal(t),
        rawToken: t.rawToken,
      })),
    });
  });

  // Self-service agent invitation & token minting
  const handleInviteOrMint = async (c: Context<Env>) => {
    const p = c.get('principal');
    if (p.kind !== 'human') throw Errors.forbidden('Only humans may invite or mint tokens');
    const body = await c.req.json();
    const actorId = String(body.actorId ?? body.actor_id ?? '').trim();
    if (!actorId) throw Errors.badRequest('actorId is required');

    const presetNames: Record<string, { name: string; bio: string; color: string; caps: string[] }> = {
      agy: {
        name: 'Antigravity (@agy)',
        bio: 'Lead Engineering & Architecture Agent · Spawns GitHub PR sub-agents',
        color: '#58a6ff',
        caps: ['github', 'subagents', 'code', 'mcp'],
      },
      muse: {
        name: 'Muse (@muse)',
        bio: 'Product, Research & Strategy Lead · Spawns Google Drive & Docs sub-agents',
        color: '#bc8cff',
        caps: ['gdrive', 'gdocs', 'subagents', 'strategy', 'mcp'],
      },
    };
    const preset = presetNames[actorId];
    const actorName = body.actorName ?? body.actor_name ?? preset?.name ?? actorId;
    const kind = body.kind ?? 'agent';

    // Check if actor already has an active token and rotateExisting is not explicitly requested
    const existing = await engine.store.getTokenByActor(p.wsId, actorId);
    let rawToken: string;
    let principal: Principal;

    if (existing && existing.rawToken && !body.rotate) {
      rawToken = existing.rawToken;
      const updated = await engine.store.updateTokenByActor(p.wsId, actorId, {
        actorName,
        bio: body.bio ?? existing.bio ?? preset?.bio,
        avatarColor: body.avatarColor ?? existing.avatarColor ?? preset?.color,
        capabilities: body.capabilities ?? existing.capabilities ?? preset?.caps,
        lastSeenAt: new Date().toISOString(),
        statusText: 'Invited & Connected via Bridge',
        online: true,
      });
      principal = recordToPrincipal(updated ?? existing);
    } else {
      const minted = await auth.mintToken({
        wsId: p.wsId,
        actorId,
        actorName,
        kind,
        sponsorHuman: kind === 'human' ? undefined : p.actorId,
        parentAgentId: body.parentAgentId ?? body.parent_agent_id,
        roles: body.roles,
        bio: body.bio ?? preset?.bio,
        avatarColor: body.avatarColor ?? preset?.color,
        capabilities: body.capabilities ?? preset?.caps,
        statusText: kind === 'agent' ? 'Invited & Connected via Bridge' : 'Collaborator',
        rawToken: body.rawToken,
        rotateExisting: Boolean(body.rotate),
      });
      rawToken = minted.rawToken;
      principal = minted.principal;
    }

    const base = resolvePublicUrl(c, publicUrl);
    const onboarding = buildOnboardingBundle(base, p.wsId, principal.actorId, principal.actorName, rawToken);

    if (body.announceInDialogue) {
      await engine.postThreadMessage(principal, {
        scopeKind: 'workspace',
        scopeId: 'main',
        body: `👋 **${principal.actorName}** (\`@${principal.actorId}\`) joined the workspace (invited by @${p.actorId}) and synced workspace context.`,
      });
    }

    return c.json({ rawToken, principal, onboarding }, 201);
  };

  api.post('/invites', handleInviteOrMint);
  api.post('/tokens', handleInviteOrMint);

  api.delete('/tokens/:actorId', async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'human') throw Errors.forbidden('Only humans may revoke tokens');
    const targetActor = c.req.param('actorId');
    await auth.revokeActor(p.wsId, targetActor);
    return c.json({ ok: true, revokedActorId: targetActor });
  });

  // Items (Backlog & Tasks)
  api.get('/items', async (c) => c.json(await engine.store.listItems(c.get('principal').wsId)));
  api.post('/items', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const item = await withIdempotency(c.req.header('Idempotency-Key'), p.wsId, () =>
      engine.createItem(p, {
        title: body.title,
        body: body.body,
        priority: body.priority,
        assigneeId: body.assigneeId ?? body.assignee_id,
        parentItemId: body.parentItemId ?? body.parent_item_id,
        tags: body.tags,
        createdBy: body.createdBy ?? body.created_by,
      }),
    );
    return c.json(item, 201);
  });

  api.patch('/items/:id', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const item = await engine.updateItem(p, c.req.param('id'), {
      title: body.title,
      body: body.body,
      priority: body.priority,
      status: body.status,
      assigneeId: body.assigneeId ?? body.assignee_id,
      parentItemId: body.parentItemId ?? body.parent_item_id,
      tags: body.tags,
      linkedRunId: body.linkedRunId ?? body.linked_run_id,
      resultUrl: body.resultUrl ?? body.result_url,
    });
    return c.json(item);
  });

  api.post('/items/:id/claim', async (c) => {
    const p = c.get('principal');
    const run = await withIdempotency(c.req.header('Idempotency-Key'), p.wsId, () =>
      engine.claim(p, c.req.param('id')),
    );
    return c.json(run, 201);
  });

  // Runs
  api.get('/runs', async (c) => c.json(await engine.store.listRuns(c.get('principal').wsId)));
  api.get('/runs/:id', async (c) => {
    const p = c.get('principal');
    const run = await engine.store.getRun(c.req.param('id'));
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', c.req.param('id'));
    const [steps, steers, artifacts, cards, allRuns] = await Promise.all([
      engine.store.listSteps(run.id),
      engine.store.listSteers(run.id),
      engine.store.listArtifacts(run.id),
      engine.store.listCards(p.wsId, { runId: run.id }),
      engine.store.listRuns(p.wsId),
    ]);
    const subruns = allRuns.filter((r) => r.parentRunId === run.id);
    return c.json({ ...run, steps, steers, artifacts, cards, subruns });
  });

  api.post('/runs/:id/plan', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.plan(p, c.req.param('id'), {
        epoch: body.epoch ?? 1,
        steps: body.steps,
        touches: body.touches,
      }),
    );
  });

  api.post('/runs/:id/step', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.updateStep(p, c.req.param('id'), {
        epoch: body.epoch ?? 1,
        idx: body.idx,
        status: body.status,
        note: body.note,
      }),
    );
  });

  // Sub-agent spawning & run reporting
  api.post('/runs/:id/subruns', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const parentRunId = c.req.param('id');

    // If caller asks the live bridge to execute a real GitHub PR or Google Drive/Docs sub-agent
    if (body.executeTool && bridge) {
      const parentRun = await engine.store.getRun(parentRunId);
      if (!parentRun || parentRun.wsId !== p.wsId) throw Errors.notFound('Run', parentRunId);
      if (body.executeTool === 'github_pr') {
        const res = await bridge.executeGitHubPrSubagent(p, parentRun, {
          title: body.title || 'Sub-Agent GitHub PR',
          userPrompt: body.goal || body.title || 'Triggered from Web UI',
        });
        const steps = await engine.store.listSteps(res.subRun.id);
        return c.json({ run: res.subRun, steps, prResult: res.prResult }, 201);
      }
      if (body.executeTool === 'drive_doc') {
        const res = await bridge.executeDriveSubagent(p, parentRun, {
          title: body.title || 'Sub-Agent Google Doc Spec',
          userPrompt: body.goal || body.title || 'Triggered from Web UI',
        });
        const steps = await engine.store.listSteps(res.subRun.id);
        return c.json({ run: res.subRun, steps, gdocResult: res.gdocResult }, 201);
      }
    }

    const spawned = await engine.spawnSubrun(p, parentRunId, {
      title: body.title,
      goal: body.goal,
      subagentId: body.subagentId ?? body.subagent_id,
      subagentName: body.subagentName ?? body.subagent_name,
      itemId: body.itemId ?? body.item_id,
      parentStepIdx: body.parentStepIdx ?? body.parent_step_idx,
      steps: body.steps,
      touches: body.touches,
      capabilities: body.capabilities,
    });
    return c.json(spawned, 201);
  });

  api.post('/runs/:id/report', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const reported = await engine.reportRun(p, c.req.param('id'), {
      epoch: body.epoch,
      summary: body.summary,
      status: body.status,
      reportData: body.reportData ?? body.report_data,
      artifacts: body.artifacts,
    });
    return c.json(reported);
  });

  api.post('/runs/:id/artifacts', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.addArtifact(p, c.req.param('id'), {
        epoch: body.epoch ?? 1,
        stepIdx: body.stepIdx ?? body.step_idx ?? 1,
        kind: body.kind,
        ref: body.ref,
        label: body.label ?? body.title,
        url: body.url,
        meta: body.meta,
        contentHash: body.contentHash ?? body.content_hash,
      }),
      201,
    );
  });

  api.post('/runs/:id/checkpoint', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.checkpoint(p, c.req.param('id'), {
        epoch: body.epoch ?? 1,
        afterStep: body.afterStep ?? body.after_step ?? 0,
      }),
    );
  });

  api.post('/runs/:id/heartbeat', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(await engine.heartbeat(p, c.req.param('id'), body.epoch ?? 1));
  });

  api.post('/runs/:id/steers', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.queueSteer(p, c.req.param('id'), {
        op: body.op ?? 'edit',
        payload: body.payload ?? {},
        urgency: body.urgency ?? 'normal',
        pinPlanVersion: body.pinPlanVersion ?? body.pin_plan_version,
      }),
      201,
    );
  });

  api.post('/steers/:id/ack', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.ackSteer(p, c.req.param('id'), {
        accepted: body.accepted ?? true,
        note: body.note,
      }),
    );
  });

  api.post('/runs/:id/takeover', async (c) => c.json(await engine.takeoverRun(c.get('principal'), c.req.param('id'))));
  api.post('/runs/:id/cancel', async (c) => c.json(await engine.cancelRun(c.get('principal'), c.req.param('id'))));
  api.post('/runs/:id/resume', async (c) => c.json(await engine.resumeRun(c.get('principal'), c.req.param('id'))));

  // Cards
  api.get('/cards', async (c) => {
    const p = c.get('principal');
    return c.json(
      await engine.store.listCards(p.wsId, {
        runId: c.req.query('run_id'),
        status: c.req.query('status'),
      }),
    );
  });

  api.post('/runs/:id/cards', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.askCard(p, c.req.param('id'), {
        epoch: body.epoch ?? 1,
        type: body.type ?? 'approve',
        prompt: body.prompt,
        options: body.options,
        diffPreview: body.diffPreview ?? body.diff_preview,
        pin: body.pin,
        assignee: body.assignee,
        blocking: body.blocking,
        expiresAt: body.expiresAt ?? body.expires_at,
        onExpire: body.onExpire ?? body.on_expire,
        defaultOption: body.defaultOption ?? body.default_option,
        dedupeKey: body.dedupeKey ?? body.dedupe_key,
      }),
      201,
    );
  });

  api.post('/cards/:id/answer', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.answerCard(p, c.req.param('id'), {
        option: body.option,
        note: body.note,
        onPin: body.onPin ?? body.on_pin,
      }),
    );
  });

  api.get('/cards/:id/await', async (c) => {
    const p = c.get('principal');
    const timeout = Number(c.req.query('timeout_ms') ?? 25_000);
    return c.json(await engine.awaitCard(p, c.req.param('id'), timeout));
  });

  // Flows
  api.get('/flows', async (c) => c.json(await engine.store.listFlows(c.get('principal').wsId)));
  api.post('/flows', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(await engine.createFlow(p, body), 201);
  });
  api.post('/flows/:id/trigger', async (c) => {
    const p = c.get('principal');
    return c.json(await engine.triggerFlow(p, c.req.param('id')), 201);
  });

  // Scoped Threads & Workspace Dialogue
  api.get('/threads/:scopeKind/:scopeId', async (c) => {
    const p = c.get('principal');
    return c.json(
      await engine.store.listThreadMessages(p.wsId, c.req.param('scopeKind'), c.req.param('scopeId')),
    );
  });
  api.post('/threads/:scopeKind/:scopeId', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.postThreadMessage(p, {
        scopeKind: c.req.param('scopeKind') as any,
        scopeId: c.req.param('scopeId'),
        body: body.body,
        replyToId: body.replyToId ?? body.reply_to_id,
        runId: body.runId ?? body.run_id,
        itemId: body.itemId ?? body.item_id,
        sendToAgent: Boolean(body.sendToAgent ?? body.send_to_agent),
        urgency: body.urgency,
      }),
      201,
    );
  });

  // Real GitHub (gh) and Google Drive/Docs (gdrive/gdocs) integration endpoints
  api.post('/integrations/github/pr', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    if (body.action === 'status' || body.action === 'inspect') {
      const status = await inspectGitHubRepo(body.repo);
      return c.json(status);
    }
    const pr = await createGitHubPullRequest({
      repo: body.repo,
      title: body.title ?? 'Ripple Sub-Agent Automated PR',
      body: body.body,
      branch: body.branch,
      filePath: body.filePath ?? body.file_path,
      fileContent: body.fileContent ?? body.file_content,
      commitMessage: body.commitMessage ?? body.commit_message,
    });
    if (body.runId) {
      const run = await engine.store.getRun(body.runId);
      if (run && run.wsId === p.wsId) {
        await engine.addArtifact(p, run.id, {
          epoch: body.epoch ?? run.epoch,
          stepIdx: body.stepIdx ?? 1,
          kind: 'pr',
          ref: pr.prUrl,
          label: `PR #${pr.prNumber}: ${pr.title}`,
          url: pr.prUrl,
          contentHash: pr.commitSha,
        });
      }
    }
    return c.json(pr, 201);
  });

  api.post('/integrations/drive', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const action = body.action ?? (body.title ? 'create_doc' : 'list');

    if (action === 'list') {
      const files = await listRecentDriveFiles(body.limit ?? 10);
      return c.json({ files });
    }
    if (action === 'search') {
      const files = await searchDriveFiles(body.query ?? '', body.limit ?? 10);
      return c.json({ files });
    }
    if (action === 'read') {
      if (!body.docId) throw Errors.badRequest('docId is required for read action');
      const doc = await readGoogleDoc(body.docId);
      return c.json(doc);
    }

    const doc = await createGoogleDoc({
      title: body.title ?? 'Ripple Sub-Agent Google Doc',
      heading: body.heading,
      sections: body.sections,
      content: body.content ?? body.markdown ?? body.body,
    });
    if (body.runId) {
      const run = await engine.store.getRun(body.runId);
      if (run && run.wsId === p.wsId) {
        await engine.addArtifact(p, run.id, {
          epoch: body.epoch ?? run.epoch,
          stepIdx: body.stepIdx ?? 1,
          kind: 'gdoc',
          ref: doc.docUrl,
          label: `Google Doc: ${doc.title}`,
          url: doc.docUrl,
          contentHash: doc.docId,
        });
      }
    }
    return c.json(doc, 201);
  });

  // SSE stream with Last-Event-ID gapless replay
  api.get('/events', async (c) => {
    const p = c.get('principal');
    const lastId = Number(c.req.header('Last-Event-ID') ?? c.req.query('after') ?? 0);
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        const send = (ev: { seq: number; type: string }) => {
          controller.enqueue(encoder.encode(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
        };
        const missed = await engine.store.listEvents(p.wsId, lastId, 100);
        for (const ev of missed) send(ev);

        const unsub = engine.store.subscribe(p.wsId, (ev) => send(ev));
        const ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            clearInterval(ping);
          }
        }, 20_000);

        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(ping);
          unsub();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  app.route('/api/v1', api);
  return app;
}

export function createRippleHttpServer(
  engine: RippleEngine,
  auth: AuthService,
  publicUrl?: string,
  bridge?: MultiAgentBridge,
): http.Server {
  const app = createRippleApp(engine, auth, publicUrl, bridge);
  const honoListener = getRequestListener(app.fetch);

  return http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url === '/mcp' || url.startsWith('/mcp?')) {
      try {
        const parsedUrl = new URL(url, 'http://localhost');
        const queryTok = parsedUrl.searchParams.get('token');
        const authHeader =
          req.headers.authorization ?? (queryTok ? `Bearer ${queryTok}` : undefined);
        const principal = await auth.authenticate(authHeader);
        await handleMcpHttpRequest(req, res, engine, principal);
      } catch (err) {
        const status = err instanceof RippleError ? err.status : 401;
        const payload = err instanceof RippleError ? err.toJSON() : { error: 'unauthorized' };
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
      return;
    }
    return honoListener(req, res);
  });
}

