import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { AuthService } from '../src/auth.js';
import { RippleEngine } from '../src/engine.js';
import { buildGithubAuthUrl, createPkcePair, exchangeGithubCode } from '../src/oauth.js';
import { createRippleHttpServer } from '../src/server.js';
import { MemoryStore } from '../src/store/memory.js';

describe('OAuth security & GitHub login invariants', () => {
  it('createPkcePair generates unique high-entropy S256 verifier/challenge pairs', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    assert.ok(a.verifier.length >= 43);
    assert.ok(a.challenge.length >= 43);
    assert.notEqual(a.verifier, a.challenge);
    assert.notEqual(a.verifier, b.verifier);
  });

  it('buildGithubAuthUrl constructs proper authorize URL with state and scopes', () => {
    const url = new URL(
      buildGithubAuthUrl({
        clientId: 'cid_123',
        redirectUri: 'https://ripple.example/auth/github/callback',
        state: 'st_abc',
      }),
    );
    assert.equal(url.origin + url.pathname, 'https://github.com/login/oauth/authorize');
    assert.equal(url.searchParams.get('client_id'), 'cid_123');
    assert.equal(url.searchParams.get('state'), 'st_abc');
    assert.equal(url.searchParams.get('scope'), 'read:user user:email');
  });

  it('exchangeGithubCode uses application/x-www-form-urlencoded and User-Agent header', async () => {
    const origFetch = globalThis.fetch;
    const seen: Array<{ url: string; contentType?: string; userAgent?: string; bodyStr?: string }> = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const headers = new Headers(init?.headers || {});
      seen.push({
        url,
        contentType: headers.get('content-type') ?? undefined,
        userAgent: headers.get('user-agent') ?? undefined,
        bodyStr: init?.body ? String(init.body) : undefined,
      });
      if (url.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_mock_tok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 42, login: 'dweidai', name: 'David Dai' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const user = await exchangeGithubCode({
        code: 'code_xyz',
        clientId: 'cid_1',
        clientSecret: 'csec_1',
        redirectUri: 'https://ripple.example/auth/github/callback',
      });
      assert.deepEqual(user, { id: '42', login: 'dweidai', name: 'David Dai' });
      assert.equal(seen.length, 2);
      assert.match(seen[0].contentType ?? '', /application\/x-www-form-urlencoded/);
      assert.equal(seen[0].userAgent, 'Ripple-Workspace');
      assert.match(seen[0].bodyStr ?? '', /code=code_xyz/);
      assert.equal(seen[1].userAgent, 'Ripple-Workspace');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('enforces Login CSRF HttpOnly ripple_oauth_state cookie binding on /auth/github/callback', async () => {
    const prevId = process.env.GITHUB_CLIENT_ID;
    const prevSecret = process.env.GITHUB_CLIENT_SECRET;
    process.env.GITHUB_CLIENT_ID = 'test_gh_id';
    process.env.GITHUB_CLIENT_SECRET = 'test_gh_secret';

    const store = new MemoryStore();
    await store.init();
    await store.ensureWorkspace('ws_oauth', 'OAuth Test');
    const auth = new AuthService(store);
    const engine = new RippleEngine(store);
    const server = createRippleHttpServer(engine, auth);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. /api/v1/auth/status reports github OAuth enabled
      const status = await fetch(`${base}/api/v1/auth/status`).then((r) => r.json());
      assert.equal(status.authenticated, false);
      assert.equal(status.oauthEnabled.github, true);

      // 2. /auth/github/start sets HttpOnly ripple_oauth_state cookie and redirects to github.com
      const startRes = await fetch(`${base}/auth/github/start`, { redirect: 'manual' });
      assert.equal(startRes.status, 302);
      const loc = startRes.headers.get('location') ?? '';
      assert.match(loc, /^https:\/\/github\.com\/login\/oauth\/authorize\?/);
      const setCookie = startRes.headers.get('set-cookie') ?? '';
      assert.match(setCookie, /ripple_oauth_state=/);
      assert.match(setCookie, /HttpOnly/i);
      const stateParam = new URL(loc).searchParams.get('state')!;
      assert.ok(stateParam && stateParam.length > 16);

      // 3. Callback WITHOUT the bound cookie is rejected as invalid_oauth_state (prevents Login CSRF)
      const csrfRes = await fetch(`${base}/auth/github/callback?code=fake&state=${encodeURIComponent(stateParam)}`, {
        redirect: 'manual',
      });
      assert.equal(csrfRes.status, 302);
      const csrfLoc = csrfRes.headers.get('location') ?? '';
      assert.match(csrfLoc, /auth_error=invalid_oauth_state/);
    } finally {
      server.close();
      if (prevId === undefined) delete process.env.GITHUB_CLIENT_ID;
      else process.env.GITHUB_CLIENT_ID = prevId;
      if (prevSecret === undefined) delete process.env.GITHUB_CLIENT_SECRET;
      else process.env.GITHUB_CLIENT_SECRET = prevSecret;
    }
  });
});
