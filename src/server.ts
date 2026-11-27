import { getRequestListener } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import crypto from 'node:crypto';
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
import { AuthService, assertLead, hashToken, recordToPrincipal } from './auth.js';
import { RippleEngine } from './engine.js';
import { Errors, RippleError } from './errors.js';
import { handleMcpHttpRequest } from './mcp.js';
import {
  buildGithubAuthUrl,
  buildGoogleAuthUrl,
  createPkcePair,
  exchangeGithubCode,
  exchangeGoogleCode,
  isGithubOAuthConfigured,
  isGoogleOAuthConfigured,
  loadOAuthConfig,
} from './oauth.js';
import type { Principal } from './types.js';

type Env = {
  Variables: {
    principal: Principal;
  };
};

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '..');
const publicUrlFilePath = path.resolve(repoRoot, '.ripple-data/public_url.txt');

const CSP_HEADER =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const VALID_WS_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const VALID_HOST_RE = /^[a-zA-Z0-9.-]+(:\d{1,5})?$/;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5000;

function normalizeHttpUrl(raw?: string | null): string | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function isLocalUrl(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return true;
  }
}

function isHttpsRequest(forwardedProto?: string | null, rawUrl?: string | null): boolean {
  if (process.env.RIPPLE_FORCE_SECURE_COOKIE === '1') return true;
  if (forwardedProto?.split(',')[0]?.trim().toLowerCase() === 'https') return true;
  if (rawUrl && rawUrl.startsWith('https://')) return true;
  return false;
}

function parseCookie(cookieHeader: string | undefined | null, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      return part.slice(idx + 1).trim() || null;
    }
  }
  return null;
}

function getAllowedOriginsFromEnv(): string[] {
  return (process.env.RIPPLE_ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(
  origin: string | undefined | null,
  requestHost: string | undefined | null,
  configuredPublicUrl?: string,
  extraAllowedOrigins: string[] = [],
): boolean {
  if (!origin) return false;
  if (extraAllowedOrigins.includes(origin)) return true;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') return false;
  } catch {
    return false;
  }

  const normalizedPublic = normalizeHttpUrl(configuredPublicUrl);
  if (normalizedPublic && parsedOrigin.origin === normalizedPublic) {
    return true;
  }

  const envPublic = normalizeHttpUrl(process.env.PUBLIC_URL);
  if (envPublic && parsedOrigin.origin === envPublic) {
    return true;
  }

  if (requestHost && VALID_HOST_RE.test(requestHost)) {
    // Exact host match (including port)
    if (parsedOrigin.host.toLowerCase() === requestHost.toLowerCase()) {
      return true;
    }
    // Allow matching localhost / 127.0.0.1 ONLY on the server's exact listening port
    const portMatch = requestHost.match(/:(\d{1,5})$/);
    if (portMatch) {
      const requestPort = portMatch[1];
      if (
        parsedOrigin.protocol === 'http:' &&
        (parsedOrigin.origin === `http://localhost:${requestPort}` ||
          parsedOrigin.origin === `http://127.0.0.1:${requestPort}`)
      ) {
        return true;
      }
    }
  }

  return false;
}

export function resolvePublicUrl(c: Context, fallback = 'http://localhost:8787'): string {
  // 1. Validated PUBLIC_URL env var (if non-localhost)
  const envUrl = normalizeHttpUrl(process.env.PUBLIC_URL);
  if (envUrl && !isLocalUrl(envUrl)) {
    return envUrl;
  }

  // 2. Validated explicit non-localhost fallback (e.g. explicitly configured server publicUrl)
  const fallbackUrl = normalizeHttpUrl(fallback);
  if (fallbackUrl && !isLocalUrl(fallbackUrl)) {
    return fallbackUrl;
  }

  // 3. Validated .ripple-data/public_url.txt (live tunnel URL)
  try {
    if (fsSync.existsSync(publicUrlFilePath)) {
      const fromFile = normalizeHttpUrl(fsSync.readFileSync(publicUrlFilePath, 'utf8'));
      if (fromFile) {
        return fromFile;
      }
    }
  } catch {
    // ignore read error
  }

  // 4. Reverse proxy headers ONLY when explicitly trusted (RIPPLE_TRUST_PROXY=1 or host in RIPPLE_ALLOWED_HOSTS)
  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  const allowedHosts = (process.env.RIPPLE_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const trustProxy =
    process.env.RIPPLE_TRUST_PROXY === '1' ||
    Boolean(forwardedHost && allowedHosts.includes(forwardedHost.toLowerCase()));

  if (trustProxy && forwardedHost && VALID_HOST_RE.test(forwardedHost)) {
    const proto = forwardedProto === 'https' || forwardedProto === 'http' ? forwardedProto : 'https';
    const candidate = normalizeHttpUrl(`${proto}://${forwardedHost}`);
    if (candidate) return candidate;
  }

  // 5. Validated fallback
  return fallbackUrl ?? 'http://localhost:8787';
}

function buildOnboardingBundle(base: string, wsId: string, actorId: string, actorName: string, rawToken: string) {
  const doorwayUrl = `${base}/w/${wsId}/agent.md`;
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
    doorwayPrompt: `You are invited to Project Ripple as ${actorName} (@${actorId}). Read ${doorwayUrl} to connect via MCP (${base}/mcp) or REST (${base}/api/v1) with Authorization: Bearer ${rawToken}.`,
    bootstrapCurl: `curl -fsSL -H "Authorization: Bearer ${rawToken}" "${base}/bootstrap"`,
  };
}

function renderDoorwayMarkdown(opts: {
  base: string;
  wsId: string;
  whoami?: Principal | null;
  participants: Principal[];
}): string {
  // Never reflect bearer tokens in markdown output (M3)
  const tok = '<YOUR_RIPPLE_TOKEN>';
  const actorLine = opts.whoami
    ? `Authenticated as **${opts.whoami.actorName}** (\`@${opts.whoami.actorId}\`, kind: \`${opts.whoami.kind}\`).`
    : `Pass \`Authorization: Bearer rpl_...\` header to authenticate.`;

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

  const allowedOrigins = getAllowedOriginsFromEnv();

  // Bounded session store for HttpOnly cookie authentication (H2 + Google/GitHub OAuth)
  const sessions = new Map<
    string,
    {
      tokenHash?: string;
      googleSub?: string;
      requiresGithubLink?: boolean;
      wsId: string;
      actorId: string;
      expiresAt: number;
    }
  >();

  // Short-lived OAuth PKCE/state store (10m TTL)
  const oauthStates = new Map<
    string,
    { provider: 'google' | 'github'; codeVerifier?: string; sessionId?: string; expiresAt: number }
  >();

  // Track active SSE streams by `${wsId}:${actorId}` so revocation closes them immediately (H6)
  const activeSseClosers = new Map<string, Set<() => void>>();

  auth.onActorRevoked((wsId, actorId) => {
    const key = `${wsId}:${actorId}`;
    const closers = activeSseClosers.get(key);
    if (closers) {
      for (const close of [...closers]) {
        try {
          close();
        } catch {
          // ignore close errors
        }
      }
      activeSseClosers.delete(key);
    }
    for (const [sid, session] of sessions.entries()) {
      if (session.wsId === wsId && session.actorId === actorId) {
        sessions.delete(sid);
      }
    }
  });

  function pruneSessions(): void {
    const now = Date.now();
    for (const [sid, s] of sessions.entries()) {
      if (s.expiresAt <= now) sessions.delete(sid);
    }
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    for (const [st, v] of oauthStates.entries()) {
      if (v.expiresAt <= now) oauthStates.delete(st);
    }
  }

  function getSessionRecord(c: Context) {
    const sid = parseCookie(c.req.header('cookie'), 'ripple_session');
    if (!sid) return null;
    const session = sessions.get(sid);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(sid);
      return null;
    }
    return { sid, session };
  }

  async function authenticateFromCookie(c: Context): Promise<Principal | null> {
    const rec = getSessionRecord(c);
    if (!rec) return null;
    if (rec.session.requiresGithubLink || !rec.session.tokenHash) return null;
    try {
      return await auth.authenticateByHash(rec.session.tokenHash);
    } catch {
      sessions.delete(rec.sid);
      return null;
    }
  }

  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', CSP_HEADER);
    if (isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url)) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  });

  app.use(
    '*',
    cors({
      origin: (origin, c) => {
        if (!origin) return '';
        const allowed = isAllowedOrigin(origin, c.req.header('host'), publicUrl, allowedOrigins);
        return allowed ? origin : '';
      },
      credentials: true,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof RippleError) {
      if (typeof err.extra?.retry_after_sec === 'number') {
        c.header('Retry-After', String(err.extra.retry_after_sec));
      }
      return c.json(err.toJSON(), err.status as any);
    }
    console.error('[ripple] unhandled error:', err);
    return c.json({ error: 'internal_error', message: 'Internal server error' }, 500);
  });

  // Health check
  app.get('/healthz', (c) => {
    const burst = engine.getAgentBurstConfig();
    return c.json({
      ok: true,
      service: 'ripple',
      publicUrl: resolvePublicUrl(c, publicUrl),
      maxAgentHops: engine.getMaxAgentHops(),
      agentBurstLimit: burst.limit,
      agentBurstWindowSec: Math.round(burst.windowMs / 1000),
      commit: (process.env.RAILWAY_GIT_COMMIT_SHA || process.env.GIT_SHA || 'local').slice(0, 7),
    });
  });

  // Doorway URL for any agent harness (unauthenticated overview or authenticated whoami)
  app.get('/bootstrap', async (c) => {
    if (c.req.query('token') !== undefined) {
      throw Errors.unauthorized('Query string tokens are disabled; use Authorization: Bearer header or session cookie');
    }
    let whoami: Principal | null = null;
    const rawHeader = c.req.header('Authorization');
    if (rawHeader) {
      try {
        whoami = await auth.authenticate(rawHeader);
      } catch {
        whoami = null;
      }
    } else {
      whoami = await authenticateFromCookie(c);
    }
    const base = resolvePublicUrl(c, publicUrl);
    const wsId = whoami?.wsId ?? 'ws_default';
    const participants = whoami
      ? (await engine.store.listTokens(wsId)).map(recordToPrincipal)
      : [];

    c.header('Cache-Control', 'no-store');
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

  // Markdown Doorway Guide (/w/:wsId/agent.md and /agent.md) — never authenticates via ?token= or reflects tokens (M3)
  const handleAgentMd = async (c: Context) => {
    const rawWsId = c.req.param('wsId') || 'ws_default';
    const safeWsId = VALID_WS_ID_RE.test(rawWsId) ? rawWsId : 'ws_default';
    const rawHeader = c.req.header('Authorization');
    let whoami: Principal | null = null;
    if (rawHeader) {
      try {
        whoami = await auth.authenticate(rawHeader);
      } catch {
        whoami = null;
      }
    }
    const base = resolvePublicUrl(c, publicUrl);
    const participants = whoami
      ? (await engine.store.listTokens(whoami.wsId)).map(recordToPrincipal)
      : [];
    const md = renderDoorwayMarkdown({
      base,
      wsId: whoami?.wsId ?? safeWsId,
      whoami,
      participants,
    });
    return c.text(md, 200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  };
  app.get('/w/:wsId/agent.md', handleAgentMd);
  app.get('/agent.md', handleAgentMd);

  // /api/v1/demo-actors removed for security (tokens must never be exposed unauthenticated)

  // Serve Web UI & strictly allowlisted local static assets from public/ (H1)
  const assetCache = new Map<string, string>();
  async function readPublicAsset(filename: 'index.html' | 'app.js' | 'styles.css'): Promise<string | null> {
    const cached = assetCache.get(filename);
    if (cached !== undefined) return cached;
    const candidates = [
      path.resolve(dir, '../public', filename),
      path.resolve(dir, '../../public', filename),
      path.resolve(process.cwd(), 'public', filename),
    ];
    for (const p of candidates) {
      try {
        const content = await fs.readFile(p, 'utf8');
        assetCache.set(filename, content);
        return content;
      } catch {
        // try next
      }
    }
    return null;
  }

  app.get('/', async (c) => {
    const html = await readPublicAsset('index.html');
    if (!html) return c.text('Ripple Web UI index.html not found', 500);
    return c.html(html);
  });

  app.get('/app.js', async (c) => {
    const js = await readPublicAsset('app.js');
    if (!js) return c.text('Not found', 404);
    return c.text(js, 200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.get('/styles.css', async (c) => {
    const css = await readPublicAsset('styles.css');
    if (!css) return c.text('Not found', 404);
    return c.text(css, 200, {
      'Content-Type': 'text/css; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
  });

  // Google OAuth 2.0 (PKCE) + Mandatory GitHub Account Linking
  const MAX_OAUTH_STATES = 500;
  function capOAuthStates() {
    while (oauthStates.size >= MAX_OAUTH_STATES) {
      const oldest = oauthStates.keys().next().value;
      if (oldest === undefined) break;
      oauthStates.delete(oldest);
    }
  }

  app.get('/auth/google/start', (c) => {
    const cfg = loadOAuthConfig();
    if (!isGoogleOAuthConfigured(cfg)) {
      return c.redirect('/?auth_error=google_not_configured');
    }
    pruneSessions();
    capOAuthStates();
    const state = crypto.randomBytes(24).toString('base64url');
    const pkce = createPkcePair();
    oauthStates.set(state, {
      provider: 'google',
      codeVerifier: pkce.verifier,
      expiresAt: Date.now() + 10 * 60_000,
    });
    const secureAttr = isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url) ? '; Secure' : '';
    c.header(
      'Set-Cookie',
      `ripple_oauth_state=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secureAttr}`,
    );
    const base = resolvePublicUrl(c, publicUrl);
    const redirectUri = `${base}/auth/google/callback`;
    const authUrl = buildGoogleAuthUrl({
      clientId: cfg.googleClientId,
      redirectUri,
      state,
      codeChallenge: pkce.challenge,
    });
    return c.redirect(authUrl);
  });

  app.get('/auth/google/callback', async (c) => {
    const cfg = loadOAuthConfig();
    if (!isGoogleOAuthConfigured(cfg)) {
      return c.redirect('/?auth_error=google_not_configured');
    }
    const state = c.req.query('state') || '';
    const cookieState = parseCookie(c.req.header('cookie'), 'ripple_oauth_state') || '';
    const code = c.req.query('code') || '';
    const saved = oauthStates.get(state);
    oauthStates.delete(state);
    const secureAttrClear = isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url) ? '; Secure' : '';
    c.header('Set-Cookie', `ripple_oauth_state=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureAttrClear}`);
    if (
      !state ||
      state !== cookieState ||
      !saved ||
      saved.provider !== 'google' ||
      !saved.codeVerifier ||
      saved.expiresAt <= Date.now() ||
      !code
    ) {
      return c.redirect('/?auth_error=invalid_oauth_state');
    }
    try {
      const base = resolvePublicUrl(c, publicUrl);
      const redirectUri = `${base}/auth/google/callback`;
      const profile = await exchangeGoogleCode({
        code,
        codeVerifier: saved.codeVerifier,
        clientId: cfg.googleClientId,
        clientSecret: cfg.googleClientSecret,
        redirectUri,
      });
      if (!profile.emailVerified) {
        return c.redirect('/?auth_error=email_not_verified');
      }
      if (cfg.allowedGoogleEmails.length > 0 && !cfg.allowedGoogleEmails.includes(profile.email)) {
        return c.redirect('/?auth_error=email_not_allowed');
      }

      const wsId = process.env.RIPPLE_WS_ID ?? 'ws_default';
      const now = new Date().toISOString();
      const existing = await engine.store.getUserByGoogleSub(profile.sub);
      const actorId = existing?.actorId ?? 'you';
      const account = await engine.store.upsertUserAccount({
        googleSub: profile.sub,
        email: profile.email,
        name: profile.name,
        picture: profile.picture,
        githubId: existing?.githubId,
        githubLogin: existing?.githubLogin,
        actorId,
        wsId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      pruneSessions();
      const sessionId = crypto.randomBytes(32).toString('base64url');
      const secureAttr = isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url) ? '; Secure' : '';

      // True Double OAuth: Google OAuth ALWAYS requires GitHub OAuth verification on every login
      sessions.set(sessionId, {
        googleSub: account.googleSub,
        requiresGithubLink: true,
        wsId,
        actorId: account.actorId,
        expiresAt: Date.now() + 30 * 60_000,
      });
      c.header(
        'Set-Cookie',
        `ripple_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800${secureAttr}`,
        { append: true },
      );
      return c.redirect('/?link_github=1');
    } catch (err) {
      console.error('[ripple] Google OAuth callback error:', err);
      return c.redirect('/?auth_error=google_auth_failed');
    }
  });

  app.get('/auth/github/start', (c) => {
    const cfg = loadOAuthConfig();
    if (!isGithubOAuthConfigured(cfg)) {
      return c.redirect('/?auth_error=github_not_configured');
    }
    const requireDoubleOAuth = isGoogleOAuthConfigured(cfg);
    const rec = getSessionRecord(c);
    if (requireDoubleOAuth && (!rec || !rec.session.googleSub)) {
      return c.redirect('/?auth_error=google_login_required');
    }
    pruneSessions();
    capOAuthStates();
    const state = crypto.randomBytes(24).toString('base64url');
    oauthStates.set(state, {
      provider: 'github',
      sessionId: rec?.sid,
      expiresAt: Date.now() + 10 * 60_000,
    });
    const secureAttr = isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url) ? '; Secure' : '';
    c.header(
      'Set-Cookie',
      `ripple_oauth_state=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secureAttr}`,
    );
    const base = resolvePublicUrl(c, publicUrl);
    const redirectUri = `${base}/auth/github/callback`;
    const authUrl = buildGithubAuthUrl({
      clientId: cfg.githubClientId,
      redirectUri,
      state,
    });
    return c.redirect(authUrl);
  });

  app.get('/auth/github/callback', async (c) => {
    const cfg = loadOAuthConfig();
    if (!isGithubOAuthConfigured(cfg)) {
      return c.redirect('/?auth_error=github_not_configured');
    }
    const state = c.req.query('state') || '';
    const cookieState = parseCookie(c.req.header('cookie'), 'ripple_oauth_state') || '';
    const code = c.req.query('code') || '';
    const saved = oauthStates.get(state);
    oauthStates.delete(state);
    const secureAttrClear = isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url) ? '; Secure' : '';
    c.header('Set-Cookie', `ripple_oauth_state=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secureAttrClear}`);
    if (
      !state ||
      state !== cookieState ||
      !saved ||
      saved.provider !== 'github' ||
      saved.expiresAt <= Date.now() ||
      !code
    ) {
      return c.redirect('/?auth_error=invalid_oauth_state');
    }
    const requireDoubleOAuth = isGoogleOAuthConfigured(cfg);
    const rec = getSessionRecord(c);
    if (requireDoubleOAuth && (!rec || rec.sid !== saved.sessionId || !rec.session.googleSub)) {
      return c.redirect('/?auth_error=session_mismatch');
    }
    try {
      const base = resolvePublicUrl(c, publicUrl);
      const redirectUri = `${base}/auth/github/callback`;
      const ghUser = await exchangeGithubCode({
        code,
        clientId: cfg.githubClientId,
        clientSecret: cfg.githubClientSecret,
        redirectUri,
      });
      if (
        cfg.allowedGithubLogins.length > 0 &&
        !cfg.allowedGithubLogins.includes(ghUser.login.toLowerCase())
      ) {
        return c.redirect('/?auth_error=github_not_allowed');
      }

      const now = new Date().toISOString();
      const wsId = process.env.RIPPLE_WS_ID ?? 'ws_default';
      let actorId = 'you';
      let displayName = ghUser.name ? `${ghUser.name} (@${ghUser.login})` : `@${ghUser.login}`;
      let googleSub: string | undefined;

      if (requireDoubleOAuth && rec?.session.googleSub) {
        const existing = await engine.store.getUserByGoogleSub(rec.session.googleSub);
        if (!existing) {
          return c.redirect('/?auth_error=google_login_required');
        }
        if (existing.githubId && existing.githubId !== ghUser.id) {
          return c.redirect('/?auth_error=github_account_mismatch');
        }
        const linked = await engine.store.upsertUserAccount({
          ...existing,
          githubId: ghUser.id,
          githubLogin: ghUser.login,
          updatedAt: now,
        });
        actorId = linked.actorId;
        displayName = `${linked.name} (@${ghUser.login})`;
        googleSub = linked.googleSub;
      } else {
        // Standalone GitHub OAuth mode
        await engine.store.upsertUserAccount({
          googleSub: `github:${ghUser.id}`,
          email: `${ghUser.login}@users.noreply.github.com`,
          name: ghUser.name || ghUser.login,
          githubId: ghUser.id,
          githubLogin: ghUser.login,
          actorId,
          wsId,
          createdAt: now,
          updatedAt: now,
        });
      }

      let tokenRec = await engine.store.getTokenByActor(wsId, actorId);
      let tokenHash = tokenRec?.tokenHash;
      if (!tokenHash) {
        const minted = await auth.mintToken({
          wsId,
          actorId,
          actorName: displayName,
          kind: 'human',
          roles: ['lead', 'reviewer'],
        });
        tokenHash = hashToken(minted.rawToken);
      } else {
        await engine.store.updateTokenByActor(wsId, actorId, {
          actorName: displayName,
          lastSeenAt: now,
          online: true,
        });
      }

      if (rec) sessions.delete(rec.sid);
      const newSessionId = crypto.randomBytes(32).toString('base64url');
      sessions.set(newSessionId, {
        tokenHash,
        googleSub,
        requiresGithubLink: false,
        wsId,
        actorId,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      const secureAttr = isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url) ? '; Secure' : '';
      c.header(
        'Set-Cookie',
        `ripple_session=${newSessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secureAttr}`,
        { append: true },
      );
      return c.redirect('/');
    } catch (err: any) {
      const msg = String(err?.message || 'unknown');
      console.error('[ripple] GitHub OAuth callback error:', msg, err);
      const safeReason = msg.startsWith('github_token_')
        ? msg.replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 64)
        : err?.code
          ? `pg_${String(err.code).replace(/[^a-zA-Z0-9_]/g, '')}`
          : 'internal';
      return c.redirect(`/?auth_error=github_link_failed&reason=${encodeURIComponent(safeReason)}`);
    }
  });

  // Auth middleware for /api/v1/*
  const api = new Hono<Env>();

  // Public auth status endpoint for UI login / GitHub-link gating
  api.get('/auth/status', async (c) => {
    const cfg = loadOAuthConfig();
    const rec = getSessionRecord(c);
    let user: { email?: string; name?: string; githubLogin?: string } | null = null;
    if (rec?.session.googleSub) {
      const acc = await engine.store.getUserByGoogleSub(rec.session.googleSub);
      if (acc) {
        user = { email: acc.email, name: acc.name, githubLogin: acc.githubLogin };
      }
    }
    const authenticated = Boolean(await authenticateFromCookie(c));
    return c.json({
      oauthEnabled: {
        google: isGoogleOAuthConfigured(cfg),
        github: isGithubOAuthConfigured(cfg),
      },
      authenticated,
      requiresGithubLink: Boolean(rec?.session.requiresGithubLink),
      user,
    });
  });

  // Per-IP rate limiter for session login (15 attempts / 60s)
  const loginAttempts = new Map<string, number[]>();
  const LOGIN_WINDOW_MS = 60_000;
  const LOGIN_MAX_ATTEMPTS = 15;

  // Session cookie login / logout endpoints (H2)
  api.post('/auth/session', async (c) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
      c.req.header('x-real-ip') ||
      'local';
    const now = Date.now();
    const recent = (loginAttempts.get(ip) ?? []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_MAX_ATTEMPTS) {
      return c.json({ error: 'rate_limited', message: 'Too many login attempts; try again later' }, 429);
    }
    recent.push(now);
    loginAttempts.set(ip, recent);
    if (loginAttempts.size > 1000) {
      for (const [k, v] of loginAttempts) {
        if (v.every((ts) => now - ts >= LOGIN_WINDOW_MS)) loginAttempts.delete(k);
      }
    }

    const body = await c.req.json().catch(() => null);
    const rawToken = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!rawToken) throw Errors.badRequest('token is required');
    const principal = await auth.authenticate(`Bearer ${rawToken}`);

    pruneSessions();
    const sessionId = crypto.randomBytes(32).toString('base64url');
    sessions.set(sessionId, {
      tokenHash: hashToken(rawToken),
      wsId: principal.wsId,
      actorId: principal.actorId,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    const secureAttr = isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url) ? '; Secure' : '';
    c.header(
      'Set-Cookie',
      `ripple_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${secureAttr}`,
    );
    return c.json({ ok: true, principal }, 200);
  });

  const handleLogout = (c: Context<Env>) => {
    const sid = parseCookie(c.req.header('cookie'), 'ripple_session');
    if (sid) sessions.delete(sid);
    const secureAttr = isHttpsRequest(c.req.header('x-forwarded-proto'), c.req.url) ? '; Secure' : '';
    c.header(
      'Set-Cookie',
      `ripple_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureAttr}`,
    );
    return c.json({ ok: true }, 200);
  };
  api.post('/auth/logout', handleLogout);
  api.delete('/auth/session', handleLogout);

  api.use('*', async (c, next) => {
    // Reject ?token= query parameters everywhere on /api/v1/* (H2)
    if (c.req.query('token') !== undefined) {
      throw Errors.unauthorized(
        'Query string tokens are disabled; use Authorization: Bearer header or session cookie',
      );
    }

    const authHeader = c.req.header('Authorization');
    if (authHeader) {
      const principal = await auth.authenticate(authHeader);
      c.set('principal', principal);
      await next();
      return;
    }

    const sessionRec = getSessionRecord(c);
    if (sessionRec?.session.requiresGithubLink) {
      throw new RippleError(
        'github_link_required',
        403,
        'You must link your GitHub account to your Google account before using Ripple',
      );
    }

    const cookiePrincipal = await authenticateFromCookie(c);
    if (!cookiePrincipal) {
      throw Errors.unauthorized();
    }

    // CSRF defense-in-depth for cookie-authenticated mutating requests
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const secFetchSite = c.req.header('sec-fetch-site')?.toLowerCase();
      if (secFetchSite === 'cross-site') {
        throw Errors.forbidden('Cross-site cookie mutation rejected');
      }
      const origin = c.req.header('origin');
      if (origin && !isAllowedOrigin(origin, c.req.header('host'), publicUrl, allowedOrigins)) {
        throw Errors.forbidden('Cross-origin cookie mutation rejected');
      }
    }

    c.set('principal', cookiePrincipal);
    await next();
  });

  // Idempotency helper for write endpoints
  async function withIdempotency<T>(
    c: Context<Env>,
    p: Principal,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = c.req.header('Idempotency-Key');
    if (!key) return fn();
    const scope = {
      wsId: p.wsId,
      actorId: p.actorId,
      method: c.req.method,
      path: c.req.path,
      key,
    };
    const cached = await engine.store.getIdempotency(scope);
    if (cached !== undefined) return cached as T;
    const res = await fn();
    await engine.store.saveIdempotency(scope, res);
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
      activityState: body.activityState ?? body.activity_state ?? body.state,
      errorDetail: body.errorDetail ?? body.error_detail,
      online: body.online,
    });
    return c.json(updated);
  });

  // Quick Agent Observability & Status endpoints
  const statusHandler = async (c: any) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const updated = await engine.updateProfile(p, {
      activityState: body.activityState ?? body.activity_state ?? body.state,
      statusText: body.statusText ?? body.status_text,
      errorDetail: body.errorDetail ?? body.error_detail,
      online: body.online,
    });
    return c.json(updated);
  };
  api.post('/status', statusHandler);
  api.patch('/status', statusHandler);

  // Lightweight Agent Delta Inbox endpoint (token-efficient polling)
  api.get('/inbox', async (c) => {
    const p = c.get('principal');
    const sinceId = c.req.query('since_id') || undefined;
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : undefined;
    const markReadParam = c.req.query('mark_read');
    const markRead = markReadParam === 'false' || markReadParam === '0' ? false : true;
    const inbox = await engine.getInbox(p, { sinceId, limit, markRead });
    return c.json(inbox);
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
      agents: tokens.map((t) => recordToPrincipal(t)),
      dialogueHealth: engine.computeDialogueHealth(workspaceMessages),
      activeLocks: engine.computeActiveLocks(runs),
    });
  });

  const consumedApprovalCards = new Set<string>();

  // Helper: gate host-credentialed external integrations behind lead role or capability (+ human lead approval for writes) (C3)
  async function assertIntegrationAccess(
    p: Principal,
    opts: { capability: string; isWrite: boolean; approvalCardId?: string },
  ): Promise<void> {
    const isLead = p.kind === 'human' && p.roles.includes('lead');
    if (!opts.isWrite) {
      if (isLead || Boolean(p.capabilities?.includes(opts.capability))) {
        return;
      }
      throw Errors.forbidden(
        `Principal '${p.actorId}' lacks '${opts.capability}' capability or lead role for read integration`,
      );
    }
    if (isLead) return;
    if (!p.capabilities?.includes(opts.capability)) {
      throw Errors.forbidden(
        `Principal '${p.actorId}' lacks '${opts.capability}' capability for write integration`,
      );
    }
    const cardId = typeof opts.approvalCardId === 'string' ? opts.approvalCardId.trim() : '';
    if (!cardId) {
      throw Errors.forbidden(
        `Write integration '${opts.capability}' requires human lead approvalCardId`,
      );
    }
    const card = await engine.store.getCard(cardId);
    if (
      !card ||
      card.wsId !== p.wsId ||
      card.status !== 'answered' ||
      card.answerOption !== 'approve' ||
      !card.answeredBy
    ) {
      throw Errors.forbidden(
        `Approval card '${cardId}' is not an approved decision card in workspace '${p.wsId}'`,
      );
    }
    const approver = await engine.store.getTokenByActor(p.wsId, card.answeredBy);
    if (!approver || approver.kind !== 'human' || !approver.roles.includes('lead')) {
      throw Errors.forbidden(
        `Approval card '${cardId}' must be approved by a human workspace lead`,
      );
    }
    if (consumedApprovalCards.has(cardId)) {
      throw Errors.forbidden(`Approval card '${cardId}' has already been consumed`);
    }
    consumedApprovalCards.add(cardId);
  }

  // Self-service agent invitation & token minting
  const handleInviteOrMint = async (c: Context<Env>) => {
    const p = c.get('principal');
    assertLead(p, 'invite or mint tokens');
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
      rotateExisting: Boolean(body.rotate),
    });
    const rawToken = minted.rawToken;
    const principal = minted.principal;

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
    assertLead(p, 'revoke tokens');
    const targetActor = c.req.param('actorId');
    await auth.revokeActor(p.wsId, targetActor);
    return c.json({ ok: true, revokedActorId: targetActor });
  });

  // Items (Backlog & Tasks)
  api.get('/items', async (c) => c.json(await engine.store.listItems(c.get('principal').wsId)));
  api.post('/items', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const item = await withIdempotency(c, p, () =>
      engine.createItem(p, {
        title: body.title,
        body: body.body,
        priority: body.priority,
        assigneeId: body.assigneeId ?? body.assignee_id,
        parentItemId: body.parentItemId ?? body.parent_item_id,
        tags: body.tags,
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
    const run = await withIdempotency(c, p, () =>
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
      if (p.kind !== 'human' && p.actorId !== parentRun.ownerAgent) {
        throw Errors.forbidden('Only humans or the parent run owner may execute bridge sub-agent tools');
      }
      const approvalCardId = body.approvalCardId ?? body.approval_card_id;
      if (body.executeTool === 'github_pr') {
        await assertIntegrationAccess(p, {
          capability: 'github',
          isWrite: true,
          approvalCardId,
        });
        const res = await bridge.executeGitHubPrSubagent(p, parentRun, {
          title: body.title || 'Sub-Agent GitHub PR',
          userPrompt: body.goal || body.title || 'Triggered from Web UI',
        });
        const steps = await engine.store.listSteps(res.subRun.id);
        return c.json({ run: res.subRun, steps, prResult: res.prResult }, 201);
      }
      if (body.executeTool === 'drive_doc') {
        await assertIntegrationAccess(p, {
          capability: 'gdocs',
          isWrite: true,
          approvalCardId,
        });
        const res = await bridge.executeDriveSubagent(p, parentRun, {
          title: body.title || 'Sub-Agent Google Doc Spec',
          userPrompt: body.goal || body.title || 'Triggered from Web UI',
        });
        const steps = await engine.store.listSteps(res.subRun.id);
        return c.json({ run: res.subRun, steps, gdocResult: res.gdocResult }, 201);
      }
      throw Errors.badRequest(`Unsupported executeTool: ${String(body.executeTool)}`);
    }

    const spawned = await engine.spawnSubrun(p, parentRunId, {
      epoch: body.epoch,
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
    const scopeKind = c.req.param('scopeKind');
    const scopeId = c.req.param('scopeId');
    await engine.markThreadRead(p, scopeKind, scopeId);
    return c.json(
      await engine.store.listThreadMessages(p.wsId, scopeKind, scopeId),
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
  api.post('/threads/:scopeKind/:scopeId/messages/:msgId/ack', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json().catch(() => ({}));
    const updated = await engine.ackMessage(p, {
      scopeKind: c.req.param('scopeKind'),
      scopeId: c.req.param('scopeId'),
      msgId: c.req.param('msgId'),
      emoji: body.emoji,
      ack: body.ack ?? true,
    });
    return c.json(updated);
  });
  api.get('/audit/reads', async (c) => {
    const p = c.get('principal');
    const [msgs, events] = await Promise.all([
      engine.store.listThreadMessages(p.wsId, 'workspace', 'main'),
      engine.store.listEvents(p.wsId, 0, 100),
    ]);
    const readEvents = events.filter((e) => e.type === 'thread.read' || e.type === 'thread.ack');
    return c.json({
      messages: msgs.map((m) => ({
        id: m.id,
        actorId: m.actorId,
        author: m.author,
        createdAt: m.createdAt,
        readBy: m.readBy ?? [],
      })),
      auditEvents: readEvents,
    });
  });

  // Real GitHub (gh) and Google Drive/Docs (gdrive/gdocs) integration endpoints
  api.post('/integrations/github/pr', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    if (body.action === 'status' || body.action === 'inspect') {
      await assertIntegrationAccess(p, { capability: 'github', isWrite: false });
      const status = await inspectGitHubRepo(body.repo);
      return c.json(status);
    }
    await assertIntegrationAccess(p, {
      capability: 'github',
      isWrite: true,
      approvalCardId: body.approvalCardId ?? body.approval_card_id,
    });
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
      await assertIntegrationAccess(p, { capability: 'gdrive', isWrite: false });
      const files = await listRecentDriveFiles(body.limit ?? 10);
      return c.json({ files });
    }
    if (action === 'search') {
      await assertIntegrationAccess(p, { capability: 'gdrive', isWrite: false });
      const files = await searchDriveFiles(body.query ?? '', body.limit ?? 10);
      return c.json({ files });
    }
    if (action === 'read') {
      await assertIntegrationAccess(p, { capability: 'gdocs', isWrite: false });
      if (!body.docId) throw Errors.badRequest('docId is required for read action');
      const doc = await readGoogleDoc(body.docId);
      return c.json(doc);
    }

    await assertIntegrationAccess(p, {
      capability: 'gdocs',
      isWrite: true,
      approvalCardId: body.approvalCardId ?? body.approval_card_id,
    });
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

  // SSE stream with Last-Event-ID gapless replay & instant teardown on token revocation
  api.get('/events', async (c) => {
    const p = c.get('principal');
    const afterParam = c.req.query('after');
    const lastIdHeader = c.req.header('Last-Event-ID');
    const skipReplay = afterParam === 'latest' && !lastIdHeader;
    const lastId = skipReplay ? 0 : Number(lastIdHeader ?? afterParam ?? 0);
    const encoder = new TextEncoder();
    const sseKey = `${p.wsId}:${p.actorId}`;

    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = (ev: { seq: number; type: string }) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`));
          } catch {
            closeStream();
          }
        };
        controller.enqueue(encoder.encode('retry: 3000\n\n'));
        if (!skipReplay) {
          const missed = await engine.store.listEvents(p.wsId, lastId, 100);
          for (const ev of missed) send(ev);
        } else {
          controller.enqueue(encoder.encode(': connected\n\n'));
        }

        const unsub = engine.store.subscribe(p.wsId, (ev) => send(ev));
        const ping = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(': ping\n\n'));
          } catch {
            closeStream();
          }
        }, 15_000);

        const closeStream = () => {
          if (closed) return;
          closed = true;
          clearInterval(ping);
          unsub();
          const set = activeSseClosers.get(sseKey);
          if (set) {
            set.delete(closeStream);
            if (set.size === 0) activeSseClosers.delete(sseKey);
          }
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        let set = activeSseClosers.get(sseKey);
        if (!set) {
          set = new Set();
          activeSseClosers.set(sseKey, set);
        }
        set.add(closeStream);

        c.req.raw.signal.addEventListener('abort', closeStream);
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store, no-transform',
        'X-Accel-Buffering': 'no',
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
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'no-store');
      try {
        const parsedUrl = new URL(url, 'http://localhost');
        if (parsedUrl.searchParams.has('token')) {
          throw Errors.unauthorized('Query string tokens are disabled on /mcp; use Authorization: Bearer header');
        }
        const authHeader = req.headers.authorization;
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

