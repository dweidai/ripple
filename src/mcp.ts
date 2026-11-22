import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { RippleError } from './errors.js';
import type { RippleEngine } from './engine.js';
import type { Principal } from './types.js';

function ok(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function fail(err: unknown) {
  const payload =
    err instanceof RippleError
      ? err.toJSON()
      : { error: 'internal_error', message: err instanceof Error ? err.message : String(err) };
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function createRippleMcpServer(engine: RippleEngine, principal: Principal): McpServer {
  const server = new McpServer({
    name: 'ripple',
    version: '0.1.0',
  });

  server.tool(
    'ripple_list_items',
    'List backlog items and active runs in the Ripple workspace.',
    {},
    async () => {
      try {
        const [items, runs, openCards] = await Promise.all([
          engine.store.listItems(principal.wsId),
          engine.store.listRuns(principal.wsId),
          engine.store.listCards(principal.wsId, { status: 'open' }),
        ]);
        return ok({ whoami: principal, items, runs, openCards });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_claim',
    'Claim an open backlog item to start a new Run (returns run_id and epoch=1; 409 taken if already claimed).',
    { item_id: z.string() },
    async ({ item_id }) => {
      try {
        return ok(await engine.claim(principal, item_id));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_plan',
    'Post or update the ordered step plan for a Run (bumps plan_version). Declare touches[] for overlap detection.',
    {
      run_id: z.string(),
      epoch: z.number().int().positive(),
      steps: z.array(
        z.object({
          title: z.string(),
          kind: z.enum(['task', 'gate']).optional(),
          status: z.enum(['pending', 'active', 'done', 'failed', 'skipped']).optional(),
          note: z.string().optional(),
        }),
      ),
      touches: z.array(z.string()).optional(),
    },
    async ({ run_id, epoch, steps, touches }) => {
      try {
        return ok(await engine.plan(principal, run_id, { epoch, steps, touches }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_step',
    'Update the status and note of a step in the active plan.',
    {
      run_id: z.string(),
      epoch: z.number().int().positive(),
      idx: z.number().int().positive(),
      status: z.enum(['pending', 'active', 'done', 'failed', 'skipped']),
      note: z.string().optional(),
    },
    async ({ run_id, epoch, idx, status, note }) => {
      try {
        return ok(await engine.updateStep(principal, run_id, { epoch, idx, status, note }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_artifact',
    'Attach an artifact (commit, PR, file, url) with content_hash/SHA. Automatically stales and re-asks open Cards pinned to older hashes.',
    {
      run_id: z.string(),
      epoch: z.number().int().positive(),
      step_idx: z.number().int().positive(),
      kind: z.enum(['commit', 'pr', 'file', 'url']),
      ref: z.string(),
      label: z.string().optional(),
      content_hash: z.string().optional(),
    },
    async ({ run_id, epoch, step_idx, kind, ref, label, content_hash }) => {
      try {
        return ok(
          await engine.addArtifact(principal, run_id, {
            epoch,
            stepIdx: step_idx,
            kind,
            ref,
            label,
            contentHash: content_hash,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_checkpoint',
    'Report a safe checkpoint after a step. Returns any queued human steers and advisory touches overlaps.',
    {
      run_id: z.string(),
      epoch: z.number().int().positive(),
      after_step: z.number().int().nonnegative(),
    },
    async ({ run_id, epoch, after_step }) => {
      try {
        return ok(await engine.checkpoint(principal, run_id, { epoch, afterStep: after_step }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_heartbeat',
    'Send liveness heartbeat (every <=60s). Returns any urgency=now steers and directives.',
    {
      run_id: z.string(),
      epoch: z.number().int().positive(),
    },
    async ({ run_id, epoch }) => {
      try {
        return ok(await engine.heartbeat(principal, run_id, epoch));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_ack',
    'Idempotently acknowledge (accept or reject) a delivered human steer.',
    {
      steer_id: z.string(),
      accepted: z.boolean(),
      note: z.string().optional(),
    },
    async ({ steer_id, accepted, note }) => {
      try {
        return ok(await engine.ackSteer(principal, steer_id, { accepted, note }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_ask',
    'Raise a typed decision Card (approve/choose/provide/review) pinned to current state. Rejects blocking wait cycles with 409 cycle.',
    {
      run_id: z.string(),
      epoch: z.number().int().positive(),
      type: z.enum(['approve', 'choose', 'provide', 'review']),
      prompt: z.string(),
      options: z.array(z.string()).optional(),
      diff_preview: z.string().optional(),
      assignee_kind: z.enum(['user', 'role', 'agent']).optional(),
      assignee_id: z.string().optional(),
      blocking: z.boolean().optional(),
      on_expire: z.enum(['hold', 'default_option', 'escalate']).optional(),
      default_option: z.string().optional(),
    },
    async (args) => {
      try {
        return ok(
          await engine.askCard(principal, args.run_id, {
            epoch: args.epoch,
            type: args.type,
            prompt: args.prompt,
            options: args.options,
            diffPreview: args.diff_preview,
            assignee:
              args.assignee_kind && args.assignee_id
                ? { kind: args.assignee_kind, id: args.assignee_id }
                : undefined,
            blocking: args.blocking,
            onExpire: args.on_expire,
            defaultOption: args.default_option,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.tool(
    'ripple_await',
    'Block until a Card is answered, staled, expired, or withdrawn (counts as a heartbeat).',
    {
      card_id: z.string(),
      timeout_ms: z.number().int().positive().max(60000).optional(),
    },
    async ({ card_id, timeout_ms }) => {
      try {
        return ok(await engine.awaitCard(principal, card_id, timeout_ms ?? 25_000));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  engine: RippleEngine,
  principal: Principal,
): Promise<void> {
  const server = createRippleMcpServer(engine, principal);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless per-request for easy scaling & serverless/PaaS compatibility
  });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
