import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { AuthService, generateToken, hashToken, recordToPrincipal } from '../src/auth.js';
import { RippleEngine } from '../src/engine.js';
import { RippleError } from '../src/errors.js';
import { createRippleHttpServer } from '../src/server.js';
import { MemoryStore } from '../src/store/memory.js';

async function setup() {
  const store = new MemoryStore();
  await store.init();
  await store.ensureWorkspace('ws_1', 'Test');
  const auth = new AuthService(store);
  const engine = new RippleEngine(store, 1000); // 1s stall timeout for fast tests

  const human = await auth.mintToken({
    wsId: 'ws_1',
    actorId: 'maya',
    actorName: 'Maya',
    kind: 'human',
    roles: ['lead', 'reviewer'],
    rawToken: 'rpl_human_test',
  });
  const agy = await auth.mintToken({
    wsId: 'ws_1',
    actorId: 'agy',
    actorName: 'Antigravity',
    kind: 'agent',
    sponsorHuman: 'maya',
    rawToken: 'rpl_agy_test',
  });
  const grok = await auth.mintToken({
    wsId: 'ws_1',
    actorId: 'grok',
    actorName: 'Grok',
    kind: 'agent',
    sponsorHuman: 'maya',
    rawToken: 'rpl_grok_test',
  });
  return { store, auth, engine, human, agy, grok };
}

describe('RippleEngine core invariants', () => {
  it('enforces single-writer claim mutex (409 taken)', async () => {
    const { engine, human, agy, grok } = await setup();
    const item = await engine.createItem(human.principal, { title: 'Search index' });
    const run = await engine.claim(agy.principal, item.id);
    assert.equal(run.epoch, 1);

    await assert.rejects(
      () => engine.claim(grok.principal, item.id),
      (err: unknown) => err instanceof RippleError && err.code === 'taken' && err.status === 409,
    );
  });

  it('delivers durable steers at checkpoint, acks idempotently, and detects touches overlap', async () => {
    const { engine, human, agy, grok } = await setup();
    const i1 = await engine.createItem(human.principal, { title: 'Task 1' });
    const i2 = await engine.createItem(human.principal, { title: 'Task 2' });
    const r1 = await engine.claim(agy.principal, i1.id);
    const r2 = await engine.claim(grok.principal, i2.id);

    await engine.plan(agy.principal, r1.id, {
      epoch: 1,
      steps: [{ title: 'Audit' }, { title: 'Add LIKE search' }],
      touches: ['db/migrations', 'api/search'],
    });
    await engine.plan(grok.principal, r2.id, {
      epoch: 1,
      steps: [{ title: 'Cleanup schema' }],
      touches: ['db/migrations'],
    });

    const steer = await engine.queueSteer(human.principal, r1.id, {
      op: 'edit',
      payload: { step_idx: 2, title: 'Use tsvector GIN index' },
    });

    const ckpt = await engine.checkpoint(agy.principal, r1.id, { epoch: 1, afterStep: 1 });
    assert.equal(ckpt.steers.length, 1);
    assert.equal(ckpt.steers[0].id, steer.id);
    assert.equal(ckpt.overlaps.length, 1);
    assert.deepEqual(ckpt.overlaps[0].touches, ['db/migrations']);

    const ack1 = await engine.ackSteer(agy.principal, steer.id, { accepted: true, note: 'Switching to GIN' });
    const ack2 = await engine.ackSteer(agy.principal, steer.id, { accepted: true, note: 'Duplicate retry' });
    assert.equal(ack1.status, 'acked');
    assert.equal(ack2.ackNote, 'Switching to GIN');
  });

  it('invalidates stale cards on new artifact commit, auto re-asks, and wakes awaitCard()', async () => {
    const { engine, human, agy } = await setup();
    const item = await engine.createItem(human.principal, { title: 'Migration' });
    const run = await engine.claim(agy.principal, item.id);
    await engine.plan(agy.principal, run.id, { epoch: 1, steps: [{ title: 'Patch' }, { title: 'Gate', kind: 'gate' }] });
    await engine.addArtifact(agy.principal, run.id, { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'a1b2c3d' });

    const c1 = await engine.askCard(agy.principal, run.id, {
      epoch: 1,
      type: 'approve',
      prompt: 'Merge migration?',
      assignee: { kind: 'role', id: 'reviewer' },
    });
    assert.equal(c1.pin.value, 'a1b2c3d');

    // Agent cannot answer human/role card
    await assert.rejects(
      () => engine.answerCard(agy.principal, c1.id, { option: 'approve', onPin: 'a1b2c3d' }),
      (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
    );

    // Agent pushes a new commit -> c1 becomes stale and c2 is opened on c3d4e5f
    const artRes = await engine.addArtifact(agy.principal, run.id, { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'c3d4e5f' });
    assert.equal(artRes.staledCards.length, 1);
    assert.equal(artRes.replacementCards.length, 1);
    const c2 = artRes.replacementCards[0];
    assert.equal(c2.pin.value, 'c3d4e5f');

    // Answering stale c1 fails with 409 stale
    await assert.rejects(
      () => engine.answerCard(human.principal, c1.id, { option: 'approve', onPin: 'a1b2c3d' }),
      (err: unknown) => err instanceof RippleError && err.code === 'stale' && err.status === 409,
    );

    // Blocking await wakes immediately when human answers c2 on c3d4e5f
    const waitPromise = engine.awaitCard(agy.principal, c2.id, 5000);
    await engine.answerCard(human.principal, c2.id, { option: 'approve_with_change', onPin: 'c3d4e5f' });
    const resolved = await waitPromise;
    assert.equal(resolved.status, 'answered');
    assert.equal(resolved.answerOption, 'approve_with_change');
    assert.equal(resolved.decidedOnPin, 'c3d4e5f');
  });

  it('fences zombie writes with 409 fenced after human takeover', async () => {
    const { engine, human, agy } = await setup();
    const item = await engine.createItem(human.principal, { title: 'Fence test' });
    const run = await engine.claim(agy.principal, item.id);
    await engine.plan(agy.principal, run.id, { epoch: 1, steps: [{ title: 'Step 1' }] });

    const taken = await engine.takeoverRun(human.principal, run.id);
    assert.equal(taken.epoch, 2);
    assert.equal(taken.status, 'overridden');

    await assert.rejects(
      () => engine.updateStep(agy.principal, run.id, { epoch: 1, idx: 1, status: 'done' }),
      (err: unknown) => err instanceof RippleError && err.code === 'fenced' && err.status === 409,
    );
  });

  it('rejects blocking agent wait-for cycles with 409 cycle', async () => {
    const { engine, human, agy, grok } = await setup();
    const i1 = await engine.createItem(human.principal, { title: 'A' });
    const i2 = await engine.createItem(human.principal, { title: 'B' });
    const r1 = await engine.claim(agy.principal, i1.id);
    const r2 = await engine.claim(grok.principal, i2.id);

    await engine.askCard(agy.principal, r1.id, {
      epoch: 1,
      type: 'choose',
      prompt: 'Need grok input',
      assignee: { kind: 'agent', id: 'grok' },
      blocking: true,
    });

    await assert.rejects(
      () =>
        engine.askCard(grok.principal, r2.id, {
          epoch: 1,
          type: 'choose',
          prompt: 'Need agy input',
          assignee: { kind: 'agent', id: 'agy' },
          blocking: true,
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'cycle' && err.status === 409,
    );
  });

  it('auto-retries stalled flows under epoch 2 and dedupes escalation after retryMax', async () => {
    const { engine, human } = await setup();
    const flow = await engine.createFlow(human.principal, {
      name: 'Nightly triage',
      triggerKind: 'cron',
      agentId: 'openclaw',
      steps: [{ title: 'Scan' }],
      retryMax: 1,
    });
    const { run } = await engine.triggerFlow(human.principal, flow.id);

    // 1st stall -> auto-retries under epoch 2
    await engine.sweepLiveness('ws_1', Date.now() + 5000);
    const afterRetry = await engine.store.getRun(run.id);
    assert.equal(afterRetry?.epoch, 2);
    assert.equal(afterRetry?.status, 'running');

    // 2nd stall -> exceeds retryMax=1 -> raises 1 escalation card
    await engine.sweepLiveness('ws_1', Date.now() + 10_000);
    const cards = await engine.store.listCards('ws_1', { status: 'open' });
    assert.equal(cards.length, 1);
    assert.match(cards[0].prompt, /Nightly triage/);
  });

  it('serves REST API and Streamable HTTP MCP over HTTP', async () => {
    const { engine, auth } = await setup();
    const server = createRippleHttpServer(engine, auth);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      const health = await fetch(`${base}/healthz`).then((r) => r.json());
      assert.equal(health.ok, true);

      const item = await fetch(`${base}/api/v1/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rpl_human_test' },
        body: JSON.stringify({ title: 'HTTP item' }),
      }).then((r) => r.json());
      assert.equal(item.title, 'HTTP item');

      // MCP tools/list over Streamable HTTP
      const mcpRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer rpl_agy_test',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      assert.equal(mcpRes.status, 200);
      const bodyText = await mcpRes.text();
      assert.match(bodyText, /ripple_claim/);
      assert.match(bodyText, /ripple_checkpoint/);
      assert.match(bodyText, /ripple_ask/);
      assert.match(bodyText, /ripple_get_context/);
      assert.match(bodyText, /ripple_create_item/);
      assert.match(bodyText, /ripple_update_item/);
      assert.match(bodyText, /ripple_post_message/);
      assert.match(bodyText, /ripple_read_messages/);
      assert.match(bodyText, /ripple_spawn_subrun/);
      assert.match(bodyText, /ripple_report_run/);
      assert.match(bodyText, /ripple_answer_card/);
    } finally {
      server.close();
    }
  });

  it('supports human profile updates, backlog item CRUD with subtasks/tags/assignee, and getContext', async () => {
    const { engine, human, agy } = await setup();

    const updatedMe = await engine.updateProfile(human.principal, {
      actorName: 'David (@dweidai)',
      statusText: 'Reviewing from phone',
      bio: 'Workspace Lead',
      avatarColor: '#3fb950',
    });
    assert.equal(updatedMe.actorName, 'David (@dweidai)');
    assert.equal(updatedMe.statusText, 'Reviewing from phone');
    assert.equal(updatedMe.online, true);

    const epic = await engine.createItem(human.principal, {
      title: 'Multi-Agent Workspace Epic',
      body: 'Parent task for Drive spec and GitHub PR',
      priority: 'P0',
      assigneeId: 'agy',
      tags: ['epic', 'github', 'drive'],
    });
    assert.equal(epic.createdBy, 'maya');
    assert.equal(epic.assigneeId, 'agy');
    assert.deepEqual(epic.tags, ['epic', 'github', 'drive']);

    const subtask = await engine.createItem(agy.principal, {
      title: 'Draft Google Doc Spec',
      priority: 'P1',
      assigneeId: 'muse',
      parentItemId: epic.id,
      tags: ['gdocs'],
    });
    assert.equal(subtask.parentItemId, epic.id);
    assert.equal(subtask.createdBy, 'agy');

    const patched = await engine.updateItem(agy.principal, subtask.id, {
      status: 'done',
      resultUrl: 'https://docs.google.com/document/d/doc_123/edit',
      tags: ['gdocs', 'completed'],
    });
    assert.equal(patched.status, 'done');
    assert.equal(patched.version, 2);
    assert.equal(patched.resultUrl, 'https://docs.google.com/document/d/doc_123/edit');

    const ctx = await engine.getContext(human.principal);
    assert.equal(ctx.workspaceId, 'ws_1');
    assert.equal(ctx.items.length, 2);
    assert.ok(ctx.participants.some((p) => p.actorName === 'David (@dweidai)'));
  });

  it('spawns hierarchical sub-runs up to depth 3, reports artifacts back to parent run & workspace dialogue', async () => {
    const { engine, human, agy } = await setup();
    const item = await engine.createItem(human.principal, {
      title: 'Ship Sub-Agent PR & Drive Doc',
      assigneeId: 'agy',
    });
    const parentRun = await engine.claim(agy.principal, item.id);
    await engine.plan(agy.principal, parentRun.id, {
      epoch: 1,
      steps: [{ title: 'Spawn PR sub-agent' }, { title: 'Verify report' }],
    });

    const sub1 = await engine.spawnSubrun(agy.principal, parentRun.id, {
      epoch: 1,
      title: 'Create GitHub PR via gh CLI',
      goal: 'Open PR on dweidai/ripple',
      subagentId: 'agy-sub-github',
      subagentName: 'Agy GitHub Sub-Agent',
      parentStepIdx: 1,
      steps: [{ title: 'Create branch & commit' }, { title: 'Open PR' }],
      touches: ['docs/subagents'],
    });
    assert.equal(sub1.run.parentRunId, parentRun.id);
    assert.equal(sub1.run.depth, 1);
    assert.equal(sub1.subagent.parentAgentId, 'agy');

    // Test depth limit enforcement (depth 1 -> 2 -> 3 -> 4 throws 400)
    const sub2 = await engine.spawnSubrun(sub1.subagent, sub1.run.id, { epoch: 1, title: 'Depth 2 child' });
    assert.equal(sub2.run.depth, 2);
    const sub3 = await engine.spawnSubrun(sub2.subagent, sub2.run.id, { epoch: 1, title: 'Depth 3 child' });
    assert.equal(sub3.run.depth, 3);
    await assert.rejects(
      () => engine.spawnSubrun(sub3.subagent, sub3.run.id, { epoch: 1, title: 'Depth 4 overflow' }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );

    // Report completion of sub1 with PR and Google Doc artifacts
    const report = await engine.reportRun(sub1.subagent, sub1.run.id, {
      epoch: 1,
      summary: 'Opened PR #42 and linked Google Doc specification',
      status: 'done',
      artifacts: [
        {
          kind: 'pr',
          ref: 'https://github.com/dweidai/ripple/pull/42',
          title: 'PR #42: Sub-agent spec',
          url: 'https://github.com/dweidai/ripple/pull/42',
        },
        {
          kind: 'gdoc',
          ref: 'https://docs.google.com/document/d/12345/edit',
          title: 'Google Doc Spec',
          url: 'https://docs.google.com/document/d/12345/edit',
        },
      ],
    });
    assert.equal(report.run.status, 'done');
    assert.equal(report.artifacts.length, 2);
    assert.ok(report.parentMessage);
    assert.ok(report.workspaceMessage);

    // Verify parent run thread and workspace dialogue received the report
    const parentMsgs = await engine.store.listThreadMessages('ws_1', 'run', parentRun.id);
    assert.ok(parentMsgs.some((m) => m.body.includes('Opened PR #42')));
    const wsMsgs = await engine.store.listThreadMessages('ws_1', 'workspace', 'main');
    assert.ok(wsMsgs.some((m) => m.body.includes('Opened PR #42')));

    const ctx = await engine.getContext(agy.principal);
    assert.equal(ctx.subrunTree.length, 1);
    assert.equal(ctx.subrunTree[0].children.length, 1);
  });

  it('extracts @mentions in multi-agent dialogue and enforces hopCount anti-loop guard', async () => {
    const { engine, human, agy, grok } = await setup();

    const m0 = await engine.postThreadMessage(human.principal, {
      scopeKind: 'workspace',
      scopeId: 'main',
      body: 'Hey @agy and @muse, please sync the backlog and spin sub-agents!',
    });
    assert.deepEqual(m0.message.mentions, ['agy', 'muse']);
    assert.equal(m0.message.hopCount, 0);

    // 25 consecutive agent replies succeed, 26th without human input is blocked by anti-loop guard
    for (let i = 1; i <= 25; i++) {
      const sender = i % 2 === 1 ? agy.principal : grok.principal;
      const res = await engine.postThreadMessage(sender, {
        scopeKind: 'workspace',
        scopeId: 'main',
        body: `@${i % 2 === 1 ? 'grok' : 'agy'} agent turn ${i}`,
      });
      assert.equal(res.message.hopCount, i);
    }

    await assert.rejects(
      () =>
        engine.postThreadMessage(agy.principal, {
          scopeKind: 'workspace',
          scopeId: 'main',
          body: '@grok turn 26 runaway loop',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );

    // Human message resets hopCount back to 0
    const resetMsg = await engine.postThreadMessage(human.principal, {
      scopeKind: 'workspace',
      scopeId: 'main',
      body: 'Human check-in resets hopCount',
    });
    assert.equal(resetMsg.message.hopCount, 0);
  });

  it('supports self-service agent invites, doorway markdown guide, and file-backed MemoryStore persistence', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tmpFile = path.resolve(
      '/home/antigravity/.gemini/jetski/scratch/teamwork_tmp/f61cd444cd24e10d1755b65be5f1559b',
      `state-${Date.now()}.json`,
    );

    const store1 = new MemoryStore(tmpFile);
    await store1.init();
    await store1.ensureWorkspace('ws_persist', 'Persist Test');
    const auth1 = new AuthService(store1);
    const engine1 = new RippleEngine(store1);
    const human = await auth1.mintToken({
      wsId: 'ws_persist',
      actorId: 'you',
      actorName: 'David (@dweidai)',
      kind: 'human',
      roles: ['lead'],
      rawToken: 'rpl_david_persist',
    });
    await engine1.createItem(human.principal, { title: 'Persisted Task', priority: 'P0' });
    await store1.close();

    // Reload from disk in a fresh MemoryStore instance
    const store2 = new MemoryStore(tmpFile);
    await store2.init();
    const auth2 = new AuthService(store2);
    const engine2 = new RippleEngine(store2);
    const items = await store2.listItems('ws_persist');
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Persisted Task');

    const server = createRippleHttpServer(engine2, auth2, 'https://demo.trycloudflare.com');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      const inviteRes = await fetch(`${base}/api/v1/invites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rpl_david_persist' },
        body: JSON.stringify({ actorId: 'muse', actorName: 'Muse (@muse)', announceInDialogue: true }),
      }).then((r) => r.json());
      assert.equal(inviteRes.principal.actorId, 'muse');
      assert.ok(inviteRes.rawToken.startsWith('rpl_'));
      assert.ok(inviteRes.onboarding.mcpJson.mcpServers.ripple.url.endsWith('/mcp'));

      const guideMd = await fetch(`${base}/w/ws_persist/agent.md`, {
        headers: { Authorization: `Bearer ${inviteRes.rawToken}` },
      }).then((r) => r.text());
      assert.match(guideMd, /Ripple Workspace Doorway Guide/);
      assert.match(guideMd, /Muse \(@muse\)/);
      assert.match(guideMd, /ripple_spawn_subrun/);
      assert.ok(!guideMd.includes(inviteRes.rawToken), 'agent.md must never reflect raw bearer tokens');
    } finally {
      server.close();
      await store2.close();
      await fs.rm(path.dirname(tmpFile), { recursive: true, force: true }).catch(() => {});
    }
  });

  it('coordinates live MultiAgentBridge dialogue between David, Muse, and Antigravity and spawns sub-agents', async () => {
    const { MultiAgentBridge } = await import('../src/agents/bridge.js');
    const { store, auth, engine, human } = await setup();
    await auth.mintToken({
      wsId: 'ws_1',
      actorId: 'muse',
      actorName: 'Muse (@muse)',
      kind: 'agent',
      sponsorHuman: 'maya',
      rawToken: 'rpl_muse_test',
    });

    const bridge = new MultiAgentBridge(engine, auth, {
      wsId: 'ws_1',
      enabled: true,
      executeRealTools: false, // use deterministic fast tool mock in unit test
    });

    const res = await bridge.runCollaborativeTurn({
      scopeKind: 'workspace',
      scopeId: 'main',
      userPrompt: '@muse @agy Sync backlog tasks and spin up sub-agents for Drive spec and GitHub PR!',
      spawnTools: true,
      syncBacklog: true,
    });

    assert.ok(res.gdocResult);
    assert.ok(res.prResult);
    assert.ok(res.museRun);
    assert.ok(res.agyRun);

    const ctx = await engine.getContext(human.principal);
    assert.ok(ctx.items.length >= 2);
    assert.ok(ctx.recentDialogue.some((m) => m.actorId === 'muse'));
    assert.ok(ctx.recentDialogue.some((m) => m.actorId === 'agy'));
    assert.ok(ctx.recentArtifacts.some((a) => a.kind === 'gdoc'));
    assert.ok(ctx.recentArtifacts.some((a) => a.kind === 'pr'));
    assert.ok(ctx.openCards.some((c) => c.type === 'review'));
  });
});

describe('M1 Security Hardening invariants', () => {
  it('C1: enforces server-side allowlists on item.status, actorId, and pin.value', async () => {
    const { auth, engine, human, agy } = await setup();

    // Invalid actorId in mintToken
    await assert.rejects(
      () =>
        auth.mintToken({
          wsId: 'ws_1',
          actorId: 'bad<script>id',
          actorName: 'Bad',
          kind: 'agent',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );

    // Invalid assigneeId in createItem
    await assert.rejects(
      () => engine.createItem(human.principal, { title: 'Test', assigneeId: 'bad actor!' }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );

    // Invalid item.status in updateItem
    const item = await engine.createItem(human.principal, { title: 'Allowlist item' });
    await assert.rejects(
      () => engine.updateItem(human.principal, item.id, { status: 'hacked' as any }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );

    // Invalid pin.value in askCard and addArtifact
    const run = await engine.claim(agy.principal, item.id);
    await assert.rejects(
      () =>
        engine.askCard(agy.principal, run.id, {
          epoch: 1,
          type: 'choose',
          prompt: 'Pick',
          pin: { kind: 'plan', value: 'v1" onclick="alert(1)' },
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );

    await assert.rejects(
      () =>
        engine.addArtifact(agy.principal, run.id, {
          epoch: 1,
          stepIdx: 1,
          kind: 'commit',
          ref: 'abc<script>',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );
  });

  it('C2: enforces run ownership (with ancestor walk), human-only controls, and mandatory epoch after 404', async () => {
    const { engine, human, agy, grok } = await setup();
    const item = await engine.createItem(human.principal, { title: 'Owned run' });
    const run = await engine.claim(agy.principal, item.id);
    await engine.plan(agy.principal, run.id, { epoch: 1, steps: [{ title: 'Step 1' }] });
    const steer = await engine.queueSteer(human.principal, run.id, { op: 'freeform', payload: { text: 'hi' } });

    // Cross-agent mutations on agy's run -> 403
    const crossAgentCalls = [
      () => engine.plan(grok.principal, run.id, { epoch: 1, steps: [{ title: 'Hijack' }] }),
      () => engine.updateStep(grok.principal, run.id, { epoch: 1, idx: 1, status: 'done' }),
      () => engine.addArtifact(grok.principal, run.id, { epoch: 1, stepIdx: 1, kind: 'commit', ref: 'a1b2c3d' }),
      () => engine.checkpoint(grok.principal, run.id, { epoch: 1, afterStep: 1 }),
      () => engine.heartbeat(grok.principal, run.id, 1),
      () => engine.ackSteer(grok.principal, steer.id, { accepted: true }),
      () => engine.askCard(grok.principal, run.id, { epoch: 1, type: 'choose', prompt: 'Hijack?' }),
      () => engine.spawnSubrun(grok.principal, run.id, { epoch: 1, title: 'Hijack sub' }),
      () => engine.reportRun(grok.principal, run.id, { epoch: 1, summary: 'Hijack report' }),
    ];
    for (const fn of crossAgentCalls) {
      await assert.rejects(
        fn,
        (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
      );
    }

    // Human-only controls rejected for agents -> 403
    const humanOnlyCalls = [
      () => engine.queueSteer(agy.principal, run.id, { op: 'freeform', payload: { text: 'nope' } }),
      () => engine.takeoverRun(agy.principal, run.id),
      () => engine.cancelRun(agy.principal, run.id),
      () => engine.resumeRun(agy.principal, run.id),
      () =>
        engine.createFlow(agy.principal, {
          name: 'Rogue flow',
          triggerKind: 'manual',
          agentId: 'agy',
          steps: [{ title: 's1' }],
        }),
    ];
    for (const fn of humanOnlyCalls) {
      await assert.rejects(
        fn,
        (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
      );
    }

    const flow = await engine.createFlow(human.principal, {
      name: 'Human flow',
      triggerKind: 'manual',
      agentId: 'agy',
      steps: [{ title: 's1' }],
    });
    await assert.rejects(
      () => engine.triggerFlow(agy.principal, flow.id),
      (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
    );

    // Ancestor owner (agy) can operate on its own spawned sub-run
    const sub = await engine.spawnSubrun(agy.principal, run.id, {
      epoch: 1,
      title: 'Child task',
      subagentId: 'agy-sub-1',
    });
    const rep = await engine.reportRun(agy.principal, sub.run.id, { epoch: 1, summary: 'Parent reported' });
    assert.equal(rep.run.status, 'done');

    // Missing run returns 404 BEFORE epoch validation
    await assert.rejects(
      () => engine.spawnSubrun(agy.principal, 'r_nonexistent', { epoch: undefined as any, title: 'Missing' }),
      (err: unknown) => err instanceof RippleError && err.code === 'not_found' && err.status === 404,
    );
    await assert.rejects(
      () => engine.reportRun(agy.principal, 'r_nonexistent', { epoch: undefined as any, summary: 'Missing' }),
      (err: unknown) => err instanceof RippleError && err.code === 'not_found' && err.status === 404,
    );

    // Stale epoch on spawnSubrun / reportRun -> 409 fenced
    await assert.rejects(
      () => engine.spawnSubrun(agy.principal, run.id, { epoch: 99, title: 'Stale' }),
      (err: unknown) => err instanceof RippleError && err.code === 'fenced' && err.status === 409,
    );
    await assert.rejects(
      () => engine.reportRun(agy.principal, run.id, { epoch: 99, summary: 'Stale' }),
      (err: unknown) => err instanceof RippleError && err.code === 'fenced' && err.status === 409,
    );
  });

  it('C4: isolates idempotency keys by (wsId, actorId, method, path, key) with TTL expiry', async () => {
    const store = new MemoryStore();
    await store.init();
    const baseScope = { wsId: 'ws_1', actorId: 'maya', method: 'POST', path: '/api/v1/items', key: 'k1' };
    await store.saveIdempotency(baseScope, { id: 'item_a' });

    assert.deepEqual(await store.getIdempotency(baseScope), { id: 'item_a' });
    assert.equal(await store.getIdempotency({ ...baseScope, wsId: 'ws_2' }), undefined);
    assert.equal(await store.getIdempotency({ ...baseScope, actorId: 'agy' }), undefined);
    assert.equal(await store.getIdempotency({ ...baseScope, method: 'PATCH' }), undefined);
    assert.equal(await store.getIdempotency({ ...baseScope, path: '/api/v1/other' }), undefined);

    // TTL expiry
    const shortScope = { ...baseScope, key: 'k_exp' };
    await store.saveIdempotency(shortScope, { id: 'item_b' }, -10);
    assert.equal(await store.getIdempotency(shortScope), undefined);
  });

  it('C5: rejects non-http/https URLs while preserving non-URL commit SHAs', async () => {
    const { engine, human, agy } = await setup();
    const item = await engine.createItem(human.principal, { title: 'URL test' });
    const run = await engine.claim(agy.principal, item.id);

    await assert.rejects(
      () => engine.updateItem(human.principal, item.id, { resultUrl: 'javascript:alert(1)' }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );
    await assert.rejects(
      () =>
        engine.addArtifact(agy.principal, run.id, {
          epoch: 1,
          stepIdx: 1,
          kind: 'url',
          ref: 'javascript:alert(1)',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );
    await assert.rejects(
      () =>
        engine.addArtifact(agy.principal, run.id, {
          epoch: 1,
          stepIdx: 1,
          kind: 'file',
          ref: 'data:text/html,<script>alert(1)</script>',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );
    await assert.rejects(
      () =>
        engine.addArtifact(agy.principal, run.id, {
          epoch: 1,
          stepIdx: 1,
          kind: 'pr',
          ref: 'a1b2c3d',
          url: 'vbscript:msgbox(1)',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );

    // Commit SHA without URI scheme still succeeds
    const okArt = await engine.addArtifact(agy.principal, run.id, {
      epoch: 1,
      stepIdx: 1,
      kind: 'commit',
      ref: 'a1b2c3d',
    });
    assert.equal(okArt.artifact.ref, 'a1b2c3d');
  });

  it('H4: enforces Decision Card gate integrity (no self-answer, strict assignee/role, safe onExpire)', async () => {
    const { auth, engine, human, agy, grok } = await setup();
    const rolelessHuman = await auth.mintToken({
      wsId: 'ws_1',
      actorId: 'bob',
      actorName: 'Bob',
      kind: 'human',
      roles: [],
    });

    const item = await engine.createItem(human.principal, { title: 'Gate test' });
    const run = await engine.claim(agy.principal, item.id);

    // Forbid onExpire: 'default_option' on approve or non-agent cards
    await assert.rejects(
      () =>
        engine.askCard(agy.principal, run.id, {
          epoch: 1,
          type: 'approve',
          prompt: 'Auto-approve?',
          assignee: { kind: 'user', id: 'maya' },
          onExpire: 'default_option',
          defaultOption: 'approve',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
    );

    // Reject past expiresAt
    await assert.rejects(
      () =>
        engine.askCard(agy.principal, run.id, {
          epoch: 1,
          type: 'choose',
          prompt: 'Past expiry',
          options: ['a', 'b'],
          expiresAt: new Date(Date.now() - 5000).toISOString(),
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );

    // Role card: roleless human cannot bypass role check
    const roleCard = await engine.askCard(agy.principal, run.id, {
      epoch: 1,
      type: 'approve',
      prompt: 'Need reviewer',
      assignee: { kind: 'role', id: 'reviewer' },
    });
    await assert.rejects(
      () => engine.answerCard(rolelessHuman.principal, roleCard.id, { option: 'approve', onPin: roleCard.pin.value }),
      (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
    );

    // User card: wrong human rejected
    const userCard = await engine.askCard(agy.principal, run.id, {
      epoch: 1,
      type: 'approve',
      prompt: 'Need Maya',
      assignee: { kind: 'user', id: 'maya' },
      blocking: false,
    });
    await assert.rejects(
      () => engine.answerCard(rolelessHuman.principal, userCard.id, { option: 'approve', onPin: userCard.pin.value }),
      (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
    );

    // Agent card: asker cannot self-answer; wrong agent rejected; right agent succeeds
    const agentCard = await engine.askCard(agy.principal, run.id, {
      epoch: 1,
      type: 'choose',
      prompt: 'Grok pick',
      options: ['x', 'y'],
      assignee: { kind: 'agent', id: 'grok' },
      blocking: false,
    });
    await assert.rejects(
      () => engine.answerCard(agy.principal, agentCard.id, { option: 'x', onPin: agentCard.pin.value }),
      (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
    );
    const answered = await engine.answerCard(grok.principal, agentCard.id, {
      option: 'x',
      onPin: agentCard.pin.value,
    });
    assert.equal(answered.status, 'answered');

    // Sweeper defense-in-depth: persisted approve card with default_option escalates instead of auto-approving
    await engine.store.createCard({
      id: 'c_forged_expire',
      wsId: 'ws_1',
      runId: run.id,
      asker: 'agy',
      type: 'approve',
      prompt: 'Forged auto-approve',
      options: ['approve', 'reject'],
      diffPreview: '',
      pin: { kind: 'plan', value: 'v0' },
      assignee: { kind: 'user', id: 'maya' },
      blocking: true,
      status: 'open',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      onExpire: 'default_option',
      defaultOption: 'approve',
      createdAt: new Date().toISOString(),
    });
    await engine.sweepExpiredCards('ws_1');
    const swept = await engine.store.getCard('c_forged_expire');
    assert.equal(swept?.status, 'open');
    assert.deepEqual(swept?.assignee, { kind: 'role', id: 'lead' });
  });

  it('H5: hardens sub-agent spawning (prefix isolation, no human/unowned overwrite, capability intersection, caps)', async () => {
    const { auth, engine, human } = await setup();
    const limitedAgy = await auth.mintToken({
      wsId: 'ws_1',
      actorId: 'limited',
      actorName: 'Limited Agent',
      kind: 'agent',
      sponsorHuman: 'maya',
      capabilities: ['github'],
    });
    const item = await engine.createItem(human.principal, { title: 'Sub-agent security' });
    const run = await engine.claim(limitedAgy.principal, item.id);

    // Disallowed prefix (attempting to target human 'maya' or unrelated agent 'grok')
    await assert.rejects(
      () => engine.spawnSubrun(limitedAgy.principal, run.id, { epoch: 1, title: 'Hijack', subagentId: 'maya' }),
      (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
    );
    await assert.rejects(
      () => engine.spawnSubrun(limitedAgy.principal, run.id, { epoch: 1, title: 'Hijack', subagentId: 'grok' }),
      (err: unknown) => err instanceof RippleError && err.code === 'forbidden' && err.status === 403,
    );

    // Capability intersection: cannot escalate beyond parent's ['github']
    const sub = await engine.spawnSubrun(limitedAgy.principal, run.id, {
      epoch: 1,
      title: 'Scoped sub',
      subagentId: 'limited-sub-1',
      capabilities: ['github', 'gdrive', 'admin'],
    });
    assert.deepEqual(sub.subagent.capabilities, ['github']);

    // Sub-agent cap (MAX_SUBAGENTS_PER_AGENT = 10)
    for (let i = 2; i <= 10; i++) {
      await engine.spawnSubrun(limitedAgy.principal, run.id, {
        epoch: 1,
        title: `Sub ${i}`,
        subagentId: `limited-sub-${i}`,
      });
    }
    await assert.rejects(
      () =>
        engine.spawnSubrun(limitedAgy.principal, run.id, {
          epoch: 1,
          title: 'Sub 11 overflow',
          subagentId: 'limited-sub-11',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'bad_request' && err.status === 400,
    );
  });

  it('H6 & L2: enforces token expiry, no rawToken persistence, revocation hook, and 256-bit/128-bit entropy', async () => {
    const { store, auth, engine, human } = await setup();

    // Expired token rejected with 401
    const expired = await auth.mintToken({
      wsId: 'ws_1',
      actorId: 'temp_agent',
      actorName: 'Temp',
      kind: 'agent',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await assert.rejects(
      () => auth.authenticate(`Bearer ${expired.rawToken}`),
      (err: unknown) => err instanceof RippleError && err.code === 'unauthorized' && err.status === 401,
    );

    // No rawToken persisted on TokenRecord
    const storedRec = await store.getTokenByHash(hashToken(expired.rawToken));
    assert.ok(storedRec);
    assert.equal('rawToken' in storedRec, false);

    // authenticateByHash & onActorRevoked hook
    const revokedEvents: Array<{ wsId: string; actorId: string }> = [];
    const unsub = auth.onActorRevoked((wsId, actorId) => revokedEvents.push({ wsId, actorId }));
    const fresh = await auth.mintToken({
      wsId: 'ws_1',
      actorId: 'fresh_agent',
      actorName: 'Fresh',
      kind: 'agent',
    });
    const authed = await auth.authenticateByHash(hashToken(fresh.rawToken));
    assert.equal(authed.actorId, 'fresh_agent');

    await auth.revokeActor('ws_1', 'fresh_agent');
    assert.deepEqual(revokedEvents, [{ wsId: 'ws_1', actorId: 'fresh_agent' }]);
    await assert.rejects(
      () => auth.authenticateByHash(hashToken(fresh.rawToken)),
      (err: unknown) => err instanceof RippleError && err.code === 'unauthorized' && err.status === 401,
    );
    unsub();

    // 256-bit token entropy (43 base64url chars) & 128-bit uid entropy (32 hex chars)
    const tok = generateToken('ent');
    assert.match(tok, /^rpl_ent_[A-Za-z0-9_-]{43}$/);
    const item = await engine.createItem(human.principal, { title: 'Entropy check' });
    assert.match(item.id, /^item_[0-9a-f]{32}$/);
  });

  it('M2 & M5: enforces server-derived createdBy, cross-workspace entity ownership, and 0o600/0o700 state.json permissions', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { store, auth, engine, human, agy } = await setup();

    // Server-derived createdBy ignores spoofed caller input
    const item = await engine.createItem(agy.principal, {
      title: 'Spoof attempt',
      createdBy: 'maya',
    });
    assert.equal(item.createdBy, 'agy');

    // Cross-workspace isolation on parentItemId, linkedRunId, spawnSubrun.itemId, postThreadMessage
    await store.ensureWorkspace('ws_other', 'Other');
    const otherHuman = await auth.mintToken({
      wsId: 'ws_other',
      actorId: 'other_human',
      actorName: 'Other',
      kind: 'human',
    });
    const otherItem = await engine.createItem(otherHuman.principal, { title: 'Foreign item' });
    const otherRun = await engine.claim(otherHuman.principal, otherItem.id);

    await assert.rejects(
      () => engine.createItem(human.principal, { title: 'Child', parentItemId: otherItem.id }),
      (err: unknown) => err instanceof RippleError && err.code === 'not_found' && err.status === 404,
    );
    await assert.rejects(
      () => engine.updateItem(human.principal, item.id, { linkedRunId: otherRun.id }),
      (err: unknown) => err instanceof RippleError && err.code === 'not_found' && err.status === 404,
    );
    const localRun = await engine.claim(agy.principal, item.id);
    await assert.rejects(
      () =>
        engine.spawnSubrun(agy.principal, localRun.id, {
          epoch: 1,
          title: 'Foreign item sub',
          itemId: otherItem.id,
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'not_found' && err.status === 404,
    );
    await assert.rejects(
      () =>
        engine.postThreadMessage(human.principal, {
          scopeKind: 'run',
          scopeId: otherRun.id,
          body: 'Cross-tenant run thread',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'not_found' && err.status === 404,
    );
    await assert.rejects(
      () =>
        engine.postThreadMessage(human.principal, {
          scopeKind: 'workspace',
          scopeId: 'main',
          body: 'Bad replyToId',
          replyToId: 'msg_nonexistent',
        }),
      (err: unknown) => err instanceof RippleError && err.code === 'not_found' && err.status === 404,
    );

    // M5: MemoryStore file permissions (0o700 dir, 0o600 file)
    const tmpDir = path.resolve(
      '/home/antigravity/.gemini/jetski/scratch/teamwork_tmp/5bb8d2190f6ed01aaa8131cb419b05f7',
      `perm-test-${Date.now()}`,
    );
    const stateFile = path.join(tmpDir, 'state.json');
    try {
      const fileStore = new MemoryStore(stateFile);
      await fileStore.init();
      await fileStore.ensureWorkspace('ws_perm', 'Perm');
      await fileStore.close();

      const dirStat = await fs.stat(tmpDir);
      const fileStat = await fs.stat(stateFile);
      assert.equal(dirStat.mode & 0o777, 0o700);
      assert.equal(fileStat.mode & 0o777, 0o600);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('supports agent observability states (thinking, working, discussing, idle, error, quota_exceeded, offline) via REST and MCP', async () => {
    const { engine, auth, agy } = await setup();
    const server = createRippleHttpServer(engine, auth);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Agent updates state to thinking via POST /api/v1/status
      const st1 = await fetch(`${base}/api/v1/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rpl_agy_test' },
        body: JSON.stringify({ state: 'thinking', status_text: 'Evaluating Benchmark 2' }),
      }).then((r) => r.json());
      assert.equal(st1.activityState, 'thinking');
      assert.equal(st1.statusText, 'Evaluating Benchmark 2');
      assert.equal(st1.online, true);

      // 2. Agent reports quota_exceeded with error detail (verifies DLP redaction and online=false)
      const st2 = await fetch(`${base}/api/v1/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rpl_agy_test' },
        body: JSON.stringify({
          activityState: 'quota_exceeded',
          errorDetail: 'Groq TPM rate limit reached: 8000 TPM exceeded for openai/gpt-oss-20b',
        }),
      }).then((r) => r.json());
      assert.equal(st2.activityState, 'quota_exceeded');
      assert.equal(st2.online, false);
      assert.match(st2.errorDetail, /Groq TPM rate limit reached/);

      // 3. Snapshot includes updated activityState and errorDetail
      const snap = await fetch(`${base}/api/v1/snapshot`, {
        headers: { Authorization: 'Bearer rpl_agy_test' },
      }).then((r) => r.json());
      const agyAgent = (snap.agents || []).find((a: any) => a.actorId === 'agy');
      assert.ok(agyAgent);
      assert.equal(agyAgent.activityState, 'quota_exceeded');
      assert.equal(agyAgent.online, false);

      // 4. Invalid activityState is rejected with 400
      const errRes = await fetch(`${base}/api/v1/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer rpl_agy_test' },
        body: JSON.stringify({ state: 'sleeping' }),
      });
      assert.equal(errRes.status, 400);

      // 5. MCP ripple_set_status tool works
      const mcpRes = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer rpl_agy_test',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 42,
          method: 'tools/call',
          params: {
            name: 'ripple_set_status',
            arguments: {
              state: 'working',
              status_text: 'Running trial 18/36',
            },
          },
        }),
      });
      assert.equal(mcpRes.status, 200);
      const mcpText = await mcpRes.text();
      assert.match(mcpText, /working/);

      // 6. Agents unseen for > 5 minutes derive 'offline' state
      const pastTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      await engine.store.updateTokenByActor(agy.principal.wsId, agy.principal.actorId, {
        lastSeenAt: pastTime,
        activityState: 'working',
      });
      const tokens = await engine.store.listTokens(agy.principal.wsId);
      const agyToken = tokens.find((t) => t.actorId === 'agy')!;
      const derived = recordToPrincipal(agyToken);
      assert.equal(derived.activityState, 'offline');
      assert.equal(derived.online, false);
    } finally {
      server.close();
    }
  });
});



