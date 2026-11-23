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

  // 1. ripple_list_items
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

  // 2. ripple_claim
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

  // 3. ripple_plan
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

  // 4. ripple_step
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

  // 5. ripple_artifact
  server.tool(
    'ripple_artifact',
    'Attach an artifact (commit, pr, file, url, drive, gdoc) with content_hash/SHA. Automatically stales and re-asks open Cards pinned to older hashes.',
    {
      run_id: z.string(),
      epoch: z.number().int().positive(),
      step_idx: z.number().int().positive(),
      kind: z.enum(['commit', 'pr', 'file', 'url', 'drive', 'gdoc']),
      ref: z.string(),
      label: z.string().optional(),
      url: z.string().optional(),
      content_hash: z.string().optional(),
    },
    async ({ run_id, epoch, step_idx, kind, ref, label, url, content_hash }) => {
      try {
        return ok(
          await engine.addArtifact(principal, run_id, {
            epoch,
            stepIdx: step_idx,
            kind,
            ref,
            label,
            url,
            contentHash: content_hash,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 6. ripple_checkpoint
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

  // 7. ripple_heartbeat
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

  // 8. ripple_ack
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

  // 9. ripple_ask
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

  // 10. ripple_await
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

  // 11. ripple_get_context
  server.tool(
    'ripple_get_context',
    'Fetch full workspace situational awareness: whoami, participants/presence, recent workspace dialogue, backlog items, active runs, sub-run tree, open cards, and recent artifacts.',
    {
      run_id: z.string().optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
    async ({ run_id, limit }) => {
      try {
        return ok(await engine.getContext(principal, { runId: run_id, limit }));
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 12. ripple_create_item
  server.tool(
    'ripple_create_item',
    'Create a new backlog item or subtask for humans or agents to track.',
    {
      title: z.string(),
      body: z.string().optional(),
      priority: z.string().optional(),
      assignee_id: z.string().optional(),
      parent_item_id: z.string().optional(),
      tags: z.array(z.string()).optional(),
    },
    async ({ title, body, priority, assignee_id, parent_item_id, tags }) => {
      try {
        return ok(
          await engine.createItem(principal, {
            title,
            body,
            priority,
            assigneeId: assignee_id,
            parentItemId: parent_item_id,
            tags,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 13. ripple_update_item
  server.tool(
    'ripple_update_item',
    'Update an existing backlog item or task (title, body, priority, status, assignee_id, parent_item_id, tags, result_url).',
    {
      item_id: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      priority: z.string().optional(),
      status: z.enum(['open', 'active', 'done', 'dropped']).optional(),
      assignee_id: z.string().optional(),
      parent_item_id: z.string().optional(),
      tags: z.array(z.string()).optional(),
      result_url: z.string().optional(),
    },
    async (args) => {
      try {
        return ok(
          await engine.updateItem(principal, args.item_id, {
            title: args.title,
            body: args.body,
            priority: args.priority,
            status: args.status,
            assigneeId: args.assignee_id,
            parentItemId: args.parent_item_id,
            tags: args.tags,
            resultUrl: args.result_url,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 14. ripple_post_message
  server.tool(
    'ripple_post_message',
    'Post a message to the workspace dialogue (scope_kind=workspace, scope_id=main) or a run/step/card thread. Supports @mentions (@agy, @muse, @you, @all) and anti-loop hopCount tracking.',
    {
      body: z.string(),
      scope_kind: z.enum(['workspace', 'run', 'step', 'card']).optional(),
      scope_id: z.string().optional(),
      reply_to_id: z.string().optional(),
      run_id: z.string().optional(),
      item_id: z.string().optional(),
      send_to_agent: z.boolean().optional(),
      urgency: z.enum(['normal', 'now']).optional(),
    },
    async (args) => {
      try {
        return ok(
          await engine.postThreadMessage(principal, {
            scopeKind: args.scope_kind ?? 'workspace',
            scopeId: args.scope_id ?? 'main',
            body: args.body,
            replyToId: args.reply_to_id,
            runId: args.run_id,
            itemId: args.item_id,
            sendToAgent: args.send_to_agent,
            urgency: args.urgency,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 15. ripple_read_messages
  server.tool(
    'ripple_read_messages',
    'Read messages from the workspace dialogue (scope_kind=workspace, scope_id=main) or a specific run/step/card thread.',
    {
      scope_kind: z.enum(['workspace', 'run', 'step', 'card']).optional(),
      scope_id: z.string().optional(),
    },
    async ({ scope_kind, scope_id }) => {
      try {
        const sk = scope_kind ?? 'workspace';
        const si = scope_id ?? 'main';
        await engine.markThreadRead(principal, sk, si);
        return ok(
          await engine.store.listThreadMessages(principal.wsId, sk, si),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 15b. ripple_ack_message
  server.tool(
    'ripple_ack_message',
    'Acknowledge or react with an emoji to a message for read/audit attribution.',
    {
      msg_id: z.string(),
      emoji: z.string().optional(),
      scope_kind: z.enum(['workspace', 'run', 'step', 'card']).optional(),
      scope_id: z.string().optional(),
    },
    async ({ msg_id, emoji, scope_kind, scope_id }) => {
      try {
        return ok(
          await engine.ackMessage(principal, {
            scopeKind: scope_kind ?? 'workspace',
            scopeId: scope_id ?? 'main',
            msgId: msg_id,
            emoji,
            ack: true,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 16. ripple_spawn_subrun
  server.tool(
    'ripple_spawn_subrun',
    'Spawn a sub-agent and child Run under a parent Run (up to depth 3). Optionally mints/registers the sub-agent identity and posts a status notice in the parent run thread.',
    {
      parent_run_id: z.string(),
      title: z.string(),
      goal: z.string().optional(),
      subagent_id: z.string().optional(),
      subagent_name: z.string().optional(),
      item_id: z.string().optional(),
      parent_step_idx: z.number().int().positive().optional(),
      steps: z
        .array(
          z.object({
            title: z.string(),
            kind: z.enum(['task', 'gate']).optional(),
          }),
        )
        .optional(),
      touches: z.array(z.string()).optional(),
    },
    async (args) => {
      try {
        return ok(
          await engine.spawnSubrun(principal, args.parent_run_id, {
            title: args.title,
            goal: args.goal,
            subagentId: args.subagent_id,
            subagentName: args.subagent_name,
            itemId: args.item_id,
            parentStepIdx: args.parent_step_idx,
            steps: args.steps,
            touches: args.touches,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 17. ripple_report_run
  server.tool(
    'ripple_report_run',
    'Report completion (or failure) of a sub-agent run or primary run, attach PR/Drive/Google Doc artifacts, update the linked backlog item, and post a structured report back to the parent run and workspace dialogue.',
    {
      run_id: z.string(),
      epoch: z.number().int().positive().optional(),
      summary: z.string(),
      status: z.enum(['done', 'failed']).optional(),
      artifacts: z
        .array(
          z.object({
            kind: z.enum(['commit', 'pr', 'file', 'url', 'drive', 'gdoc']),
            ref: z.string(),
            title: z.string().optional(),
            url: z.string().optional(),
          }),
        )
        .optional(),
    },
    async (args) => {
      try {
        return ok(
          await engine.reportRun(principal, args.run_id, {
            epoch: args.epoch,
            summary: args.summary,
            status: args.status,
            artifacts: args.artifacts,
          }),
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  // 18. ripple_answer_card
  server.tool(
    'ripple_answer_card',
    'Answer an open Decision Card (agents may answer agent-assigned cards; humans may answer any card) with CAS pin verification.',
    {
      card_id: z.string(),
      option: z.string(),
      on_pin: z.string(),
      note: z.string().optional(),
    },
    async ({ card_id, option, on_pin, note }) => {
      try {
        return ok(await engine.answerCard(principal, card_id, { option, onPin: on_pin, note }));
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

