import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { AuthService } from '../src/auth.js';
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
    } finally {
      server.close();
    }
  });
});
