import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthService } from './auth.js';
import { RippleEngine } from './engine.js';
import { Errors, RippleError } from './errors.js';
import { handleMcpHttpRequest } from './mcp.js';
import type { Principal } from './types.js';

type Env = {
  Variables: {
    principal: Principal;
  };
};

export function createRippleApp(engine: RippleEngine, auth: AuthService, publicUrl = 'http://localhost:8787') {
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
  app.get('/healthz', (c) => c.json({ ok: true, service: 'ripple' }));

  // Doorway URL for any agent harness (unauthenticated overview or authenticated whoami)
  app.get('/bootstrap', async (c) => {
    let whoami: Principal | null = null;
    try {
      whoami = await auth.authenticate(c.req.header('Authorization'));
    } catch {
      whoami = null;
    }
    const base = c.req.header('x-forwarded-proto')
      ? `${c.req.header('x-forwarded-proto')}://${c.req.header('host')}`
      : publicUrl;
    return c.json({
      service: 'ripple',
      principle: 'Runs with Gates — state parity, not surface parity',
      mcp_endpoint: `${base}/mcp`,
      rest_base: `${base}/api/v1`,
      sse_events: `${base}/api/v1/events`,
      whoami,
      workflow: [
        '1. GET /api/v1/items (or MCP ripple_list_items) to pick an open item',
        '2. POST /api/v1/items/:id/claim -> returns { id: run_id, epoch: 1 }',
        '3. POST /api/v1/runs/:id/plan with ordered steps[] and touches[]',
        '4. Between steps, call POST /api/v1/runs/:id/checkpoint -> delivers queued human steers',
        '5. Call POST /api/v1/runs/:id/heartbeat every <=60s during long steps',
        '6. Use POST /api/v1/runs/:id/cards to ask a pin-bound decision, then GET /api/v1/cards/:id/await',
        '7. If any write returns 409 fenced, stop immediately',
      ],
    });
  });

  // Serve Web UI
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const indexHtmlPath = path.resolve(dir, '../public/index.html');
  app.get('/', async (c) => {
    const html = await fs.readFile(indexHtmlPath, 'utf8');
    return c.html(html);
  });

  // Auth middleware for /api/v1/*
  const api = new Hono<Env>();
  api.use('*', async (c, next) => {
    // Allow token via query param for EventSource (SSE)
    const header = c.req.header('Authorization') ?? (c.req.query('token') ? `Bearer ${c.req.query('token')}` : null);
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

  // Workspace snapshot for the UI
  api.get('/snapshot', async (c) => {
    const p = c.get('principal');
    const [items, runs, cards, flows, events, tokens] = await Promise.all([
      engine.store.listItems(p.wsId),
      engine.store.listRuns(p.wsId),
      engine.store.listCards(p.wsId),
      engine.store.listFlows(p.wsId),
      engine.store.listEvents(p.wsId, 0, 50),
      engine.store.listTokens(p.wsId),
    ]);
    const runsWithDetails = await Promise.all(
      runs.map(async (r) => ({
        ...r,
        steps: await engine.store.listSteps(r.id),
        steers: await engine.store.listSteers(r.id),
        artifacts: await engine.store.listArtifacts(r.id),
      })),
    );
    return c.json({
      whoami: p,
      items,
      runs: runsWithDetails,
      cards,
      flows,
      events: events.reverse(),
      agents: tokens.map((t) => ({
        actorId: t.actorId,
        actorName: t.actorName,
        kind: t.kind,
        sponsorHuman: t.sponsorHuman,
        roles: t.roles,
      })),
    });
  });

  // Mint sponsor-scoped agent/human token
  api.post('/tokens', async (c) => {
    const p = c.get('principal');
    if (p.kind !== 'human') throw Errors.forbidden('Only humans may mint tokens');
    const body = await c.req.json();
    const minted = await auth.mintToken({
      wsId: p.wsId,
      actorId: body.actorId,
      actorName: body.actorName ?? body.actorId,
      kind: body.kind ?? 'agent',
      sponsorHuman: body.kind === 'human' ? undefined : p.actorId,
      roles: body.roles,
    });
    return c.json(minted, 201);
  });

  // Items
  api.get('/items', async (c) => c.json(await engine.store.listItems(c.get('principal').wsId)));
  api.post('/items', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    const item = await withIdempotency(c.req.header('Idempotency-Key'), p.wsId, () =>
      engine.createItem(p, { title: body.title, body: body.body, priority: body.priority }),
    );
    return c.json(item, 201);
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
    const [steps, steers, artifacts, cards] = await Promise.all([
      engine.store.listSteps(run.id),
      engine.store.listSteers(run.id),
      engine.store.listArtifacts(run.id),
      engine.store.listCards(p.wsId, { runId: run.id }),
    ]);
    return c.json({ ...run, steps, steers, artifacts, cards });
  });

  api.post('/runs/:id/plan', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.plan(p, c.req.param('id'), {
        epoch: body.epoch,
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
        epoch: body.epoch,
        idx: body.idx,
        status: body.status,
        note: body.note,
      }),
    );
  });

  api.post('/runs/:id/artifacts', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(
      await engine.addArtifact(p, c.req.param('id'), {
        epoch: body.epoch,
        stepIdx: body.stepIdx ?? body.step_idx ?? 1,
        kind: body.kind,
        ref: body.ref,
        label: body.label,
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
        epoch: body.epoch,
        afterStep: body.afterStep ?? body.after_step ?? 0,
      }),
    );
  });

  api.post('/runs/:id/heartbeat', async (c) => {
    const p = c.get('principal');
    const body = await c.req.json();
    return c.json(await engine.heartbeat(p, c.req.param('id'), body.epoch));
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
        epoch: body.epoch,
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

  // Scoped Threads
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
        sendToAgent: Boolean(body.sendToAgent),
      }),
      201,
    );
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

export function createRippleHttpServer(engine: RippleEngine, auth: AuthService, publicUrl?: string): http.Server {
  const app = createRippleApp(engine, auth, publicUrl);
  const honoListener = getRequestListener(app.fetch);

  return http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url === '/mcp' || url.startsWith('/mcp?')) {
      try {
        const principal = await auth.authenticate(req.headers.authorization);
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
