import crypto from 'node:crypto';
import { Errors } from './errors.js';
import type { Store } from './store/interface.js';
import {
  TERMINAL_RUN_STATUSES,
  type Artifact,
  type ArtifactKind,
  type Card,
  type CardAssignee,
  type CardOnExpire,
  type CardType,
  type CheckpointResponse,
  type FlowTemplate,
  type HeartbeatResponse,
  type Item,
  type OverlapWarning,
  type Pin,
  type Principal,
  type Run,
  type Steer,
  type SteerOp,
  type SteerUrgency,
  type Step,
  type StepKind,
  type StepStatus,
  type ThreadMessage,
} from './types.js';

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

export class RippleEngine {
  private cardWaiters = new Map<string, Set<(card: Card) => void>>();

  constructor(
    public readonly store: Store,
    private readonly stallTimeoutMs = 3 * 60 * 1000,
  ) {}

  private async emit(
    wsId: string,
    entity: string,
    entityId: string,
    type: string,
    actor: string,
    payload: Record<string, unknown> = {},
    epoch?: number,
  ) {
    return this.store.appendEvent({
      wsId,
      entity,
      entityId,
      type,
      actor,
      epoch,
      payload,
      at: new Date().toISOString(),
    });
  }

  private assertEpoch(run: Run, sentEpoch: number) {
    if (sentEpoch !== run.epoch) {
      throw Errors.fenced(sentEpoch, run.epoch);
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw Errors.fenced(sentEpoch, run.epoch);
    }
  }

  // ---------- Items ----------
  async createItem(
    p: Principal,
    input: { title: string; body?: string; priority?: string },
  ): Promise<Item> {
    const now = new Date().toISOString();
    const item: Item = {
      id: uid('item'),
      wsId: p.wsId,
      title: input.title,
      body: input.body ?? '',
      priority: input.priority ?? 'P1',
      version: 1,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createItem(item);
    await this.emit(p.wsId, 'item', item.id, 'item.created', p.actorId, { title: item.title });
    return item;
  }

  // ---------- Runs: Claim, Plan, Step, Artifact ----------
  async claim(p: Principal, itemId: string): Promise<Run> {
    const item = await this.store.getItem(itemId);
    if (!item || item.wsId !== p.wsId) throw Errors.notFound('Item', itemId);

    const existing = await this.store.findActiveRunByItem(itemId);
    if (existing) throw Errors.taken(itemId, existing.id);

    const now = new Date().toISOString();
    const run: Run = {
      id: uid('r'),
      wsId: p.wsId,
      itemId: item.id,
      ownerAgent: p.actorId,
      sponsorHuman: p.sponsorHuman ?? p.actorId,
      epoch: 1,
      planVersion: 0,
      status: 'planning',
      heartbeatAt: now,
      lastCheckpointStep: 0,
      touches: [],
      subjectPin: { kind: 'item', value: `v${item.version}` },
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);
    item.status = 'active';
    item.updatedAt = now;
    await this.store.updateItem(item);
    await this.emit(p.wsId, 'run', run.id, 'run.claimed', p.actorId, { itemId: item.id }, run.epoch);
    return run;
  }

  async plan(
    p: Principal,
    runId: string,
    input: {
      epoch: number;
      steps: Array<{ title: string; kind?: StepKind; status?: StepStatus; note?: string }>;
      touches?: string[];
    },
  ): Promise<{ run: Run; steps: Step[] }> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    this.assertEpoch(run, input.epoch);

    const now = new Date().toISOString();
    run.planVersion += 1;
    run.status = 'running';
    run.heartbeatAt = now;
    run.updatedAt = now;
    if (input.touches) run.touches = [...new Set(input.touches)];
    if (!run.subjectPin || run.subjectPin.kind === 'plan' || run.subjectPin.kind === 'item') {
      run.subjectPin = { kind: 'plan', value: `v${run.planVersion}` };
    }
    await this.store.updateRun(run);

    const steps: Step[] = input.steps.map((s, i) => ({
      id: uid('st'),
      runId: run.id,
      planVersion: run.planVersion,
      idx: i + 1,
      title: s.title,
      kind: s.kind ?? 'task',
      status: s.status ?? (i === 0 ? 'active' : 'pending'),
      note: s.note ?? '',
      startedAt: (s.status ?? (i === 0 ? 'active' : 'pending')) === 'active' ? now : undefined,
    }));
    await this.store.replaceSteps(run.id, run.planVersion, steps);
    await this.emit(
      p.wsId,
      'run',
      run.id,
      'run.planned',
      p.actorId,
      { planVersion: run.planVersion, stepCount: steps.length, touches: run.touches },
      run.epoch,
    );
    return { run, steps };
  }

  async updateStep(
    p: Principal,
    runId: string,
    input: { epoch: number; idx: number; status: StepStatus; note?: string },
  ): Promise<{ run: Run; step: Step }> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    this.assertEpoch(run, input.epoch);

    const steps = await this.store.listSteps(run.id, run.planVersion);
    const step = steps.find((s) => s.idx === input.idx);
    if (!step) throw Errors.notFound('Step', `${runId}#${input.idx}`);

    const now = new Date().toISOString();
    step.status = input.status;
    if (input.note !== undefined) step.note = input.note;
    if (input.status === 'active' && !step.startedAt) step.startedAt = now;
    if (input.status === 'done') step.doneAt = now;
    await this.store.updateStep(step);

    run.heartbeatAt = now;
    run.updatedAt = now;
    const allDone = steps.every((s) => (s.idx === step.idx ? step.status === 'done' : s.status === 'done' || s.status === 'skipped'));
    if (allDone && steps.length > 0) {
      run.status = 'done';
      if (run.itemId) {
        const item = await this.store.getItem(run.itemId);
        if (item) {
          item.status = 'done';
          item.updatedAt = now;
          await this.store.updateItem(item);
        }
      }
      await this.emit(p.wsId, 'run', run.id, 'run.done', p.actorId, { itemId: run.itemId }, run.epoch);
    }
    await this.store.updateRun(run);
    await this.emit(
      p.wsId,
      'run',
      run.id,
      'run.step',
      p.actorId,
      { idx: step.idx, status: step.status, note: step.note },
      run.epoch,
    );
    return { run, step };
  }

  async addArtifact(
    p: Principal,
    runId: string,
    input: {
      epoch: number;
      stepIdx: number;
      kind: ArtifactKind;
      ref: string;
      label?: string;
      contentHash?: string;
    },
  ): Promise<{ artifact: Artifact; staledCards: Card[]; replacementCards: Card[] }> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    this.assertEpoch(run, input.epoch);

    const now = new Date().toISOString();
    const hash = input.contentHash ?? input.ref;
    const artifact: Artifact = {
      id: uid('art'),
      runId: run.id,
      stepIdx: input.stepIdx,
      kind: input.kind,
      ref: input.ref,
      label: input.label ?? `${input.kind} ${input.ref}`,
      contentHash: hash,
      createdAt: now,
    };
    await this.store.createArtifact(artifact);

    const newPin: Pin = {
      kind: input.kind === 'commit' ? 'commit' : 'artifact',
      value: hash,
    };
    run.subjectPin = newPin;
    run.heartbeatAt = now;
    run.updatedAt = now;
    await this.store.updateRun(run);

    await this.emit(
      p.wsId,
      'artifact',
      artifact.id,
      'artifact.added',
      p.actorId,
      { runId: run.id, kind: artifact.kind, ref: artifact.ref, contentHash: hash },
      run.epoch,
    );

    // Invalidate any open cards pinned to an older fingerprint & auto re-ask on the new pin
    const openCards = await this.store.listCards(p.wsId, { runId: run.id, status: 'open' });
    const staledCards: Card[] = [];
    const replacementCards: Card[] = [];

    for (const oldCard of openCards) {
      if (oldCard.pin.value !== newPin.value) {
        const replacement: Card = {
          ...oldCard,
          id: uid('c'),
          pin: newPin,
          status: 'open',
          createdAt: now,
          answerOption: undefined,
          answerNote: undefined,
          answeredBy: undefined,
          decidedOnPin: undefined,
          replacedBy: undefined,
          answeredAt: undefined,
        };
        oldCard.status = 'stale';
        oldCard.replacedBy = replacement.id;
        await this.store.updateCard(oldCard);
        await this.store.createCard(replacement);
        staledCards.push(oldCard);
        replacementCards.push(replacement);

        this.notifyCardWaiters(oldCard);
        await this.emit(
          p.wsId,
          'card',
          oldCard.id,
          'card.stale',
          p.actorId,
          { oldPin: oldCard.pin.value, newPin: newPin.value, replacedBy: replacement.id },
          run.epoch,
        );
        await this.emit(
          p.wsId,
          'card',
          replacement.id,
          'card.opened',
          p.actorId,
          { runId: run.id, pin: newPin, reaskedFrom: oldCard.id },
          run.epoch,
        );
      }
    }

    return { artifact, staledCards, replacementCards };
  }

  // ---------- Steers, Checkpoint, Heartbeat ----------
  async queueSteer(
    p: Principal,
    runId: string,
    input: {
      op: SteerOp;
      payload: Record<string, unknown>;
      urgency?: SteerUrgency;
      pinPlanVersion?: number;
    },
  ): Promise<Steer> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw Errors.badRequest(`Cannot steer terminal run ${run.id} (${run.status})`);
    }
    const steer: Steer = {
      id: uid('str'),
      runId: run.id,
      author: p.actorId,
      pinPlanVersion: input.pinPlanVersion ?? run.planVersion,
      urgency: input.urgency ?? 'normal',
      op: input.op,
      payload: input.payload,
      status: 'queued',
      ackNote: '',
      createdAt: new Date().toISOString(),
    };
    await this.store.createSteer(steer);
    await this.emit(
      p.wsId,
      'steer',
      steer.id,
      'steer.queued',
      p.actorId,
      { runId: run.id, op: steer.op, urgency: steer.urgency, pinPlanVersion: steer.pinPlanVersion },
      run.epoch,
    );
    return steer;
  }

  async checkpoint(
    p: Principal,
    runId: string,
    input: { epoch: number; afterStep: number },
  ): Promise<CheckpointResponse> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    this.assertEpoch(run, input.epoch);

    const now = new Date().toISOString();
    run.heartbeatAt = now;
    run.lastCheckpointStep = Math.max(run.lastCheckpointStep, input.afterStep);
    run.updatedAt = now;
    await this.store.updateRun(run);

    const allSteers = await this.store.listSteers(run.id);
    const pending = allSteers.filter((s) => s.status === 'queued' || s.status === 'delivered');
    for (const s of pending) {
      if (s.status === 'queued') {
        s.status = 'delivered';
        await this.store.updateSteer(s);
        await this.emit(p.wsId, 'steer', s.id, 'steer.delivered', p.actorId, { runId: run.id }, run.epoch);
      }
    }

    const overlaps = await this.computeOverlaps(run);
    await this.emit(
      p.wsId,
      'run',
      run.id,
      'run.checkpoint',
      p.actorId,
      { afterStep: input.afterStep, steerCount: pending.length, overlapCount: overlaps.length },
      run.epoch,
    );

    return {
      runId: run.id,
      epoch: run.epoch,
      planVersion: run.planVersion,
      steers: pending,
      directives: [],
      overlaps,
    };
  }

  async heartbeat(p: Principal, runId: string, epoch: number): Promise<HeartbeatResponse> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    this.assertEpoch(run, epoch);

    const now = new Date().toISOString();
    run.heartbeatAt = now;
    run.updatedAt = now;
    await this.store.updateRun(run);

    const allSteers = await this.store.listSteers(run.id);
    const urgent = allSteers.filter((s) => s.urgency === 'now' && (s.status === 'queued' || s.status === 'delivered'));
    for (const s of urgent) {
      if (s.status === 'queued') {
        s.status = 'delivered';
        await this.store.updateSteer(s);
        await this.emit(p.wsId, 'steer', s.id, 'steer.delivered', p.actorId, { runId: run.id, urgent: true }, run.epoch);
      }
    }

    return {
      runId: run.id,
      epoch: run.epoch,
      status: run.status,
      urgentSteers: urgent,
      directives: [],
    };
  }

  async ackSteer(
    p: Principal,
    steerId: string,
    input: { accepted: boolean; note?: string },
  ): Promise<Steer> {
    const steer = await this.store.getSteer(steerId);
    if (!steer) throw Errors.notFound('Steer', steerId);
    const run = await this.store.getRun(steer.runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', steer.runId);

    // Idempotent: already acked/rejected returns the recorded steer without duplicating events
    if (steer.status === 'acked' || steer.status === 'rejected') {
      return steer;
    }

    steer.status = input.accepted ? 'acked' : 'rejected';
    steer.ackNote = input.note ?? '';
    steer.ackedAt = new Date().toISOString();
    await this.store.updateSteer(steer);
    await this.emit(
      p.wsId,
      'steer',
      steer.id,
      'steer.acked',
      p.actorId,
      { runId: run.id, accepted: input.accepted, note: steer.ackNote },
      run.epoch,
    );
    return steer;
  }

  // ---------- Cards (Gates) + Wait-For Cycle Check ----------
  async askCard(
    p: Principal,
    runId: string,
    input: {
      epoch: number;
      type: CardType;
      prompt: string;
      options?: string[];
      diffPreview?: string;
      pin?: Pin;
      assignee?: CardAssignee;
      blocking?: boolean;
      expiresAt?: string;
      onExpire?: CardOnExpire;
      defaultOption?: string;
      dedupeKey?: string;
    },
  ): Promise<Card> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    this.assertEpoch(run, input.epoch);

    const assignee: CardAssignee = input.assignee ?? { kind: 'user', id: run.sponsorHuman };
    const blocking = input.blocking ?? true;

    // Wait-for graph cycle check when blocking on another agent
    if (blocking && assignee.kind === 'agent') {
      const cycle = await this.detectWaitCycle(p.wsId, run.ownerAgent, assignee.id);
      if (cycle) throw Errors.cycle(cycle);
    }

    // Dedupe open card by dedupeKey (prevents flow spam)
    if (input.dedupeKey) {
      const open = await this.store.listCards(p.wsId, { status: 'open' });
      const dup = open.find((c) => c.dedupeKey === input.dedupeKey);
      if (dup) return dup;
    }

    const pin: Pin = input.pin ?? run.subjectPin ?? { kind: 'plan', value: `v${run.planVersion}` };
    const now = new Date().toISOString();
    const card: Card = {
      id: uid('c'),
      wsId: p.wsId,
      runId: run.id,
      asker: run.ownerAgent,
      type: input.type,
      prompt: input.prompt,
      options: input.options ?? (input.type === 'approve' ? ['approve', 'approve_with_change', 'reject'] : []),
      diffPreview: input.diffPreview ?? '',
      pin,
      assignee,
      blocking,
      status: 'open',
      expiresAt: input.expiresAt,
      onExpire: input.onExpire ?? 'escalate',
      defaultOption: input.defaultOption,
      dedupeKey: input.dedupeKey,
      createdAt: now,
    };
    await this.store.createCard(card);

    if (blocking) {
      run.status = 'gated';
      run.heartbeatAt = now;
      run.updatedAt = now;
      await this.store.updateRun(run);
    }

    await this.emit(
      p.wsId,
      'card',
      card.id,
      'card.opened',
      p.actorId,
      { runId: run.id, type: card.type, pin: card.pin, assignee: card.assignee, blocking },
      run.epoch,
    );
    return card;
  }

  async answerCard(
    p: Principal,
    cardId: string,
    input: { option: string; note?: string; onPin: string },
  ): Promise<Card> {
    const card = await this.store.getCard(cardId);
    if (!card || card.wsId !== p.wsId) throw Errors.notFound('Card', cardId);

    // Security: agents may not answer human/role-assigned cards
    if (p.kind === 'agent' && card.assignee.kind !== 'agent') {
      throw Errors.forbidden('Agents cannot answer human- or role-assigned cards');
    }
    if (card.assignee.kind === 'role' && !p.roles.includes(card.assignee.id) && p.kind === 'human') {
      // allow if human has role; if no roles configured on principal, require role match
      if (p.roles.length > 0) {
        throw Errors.forbidden(`Requires role '${card.assignee.id}'`);
      }
    }

    if (card.status === 'stale') {
      throw Errors.stalePin(card.id, input.onPin, 'changed', card.replacedBy);
    }
    if (card.status !== 'open') {
      throw Errors.alreadyAnswered(card.id, card.status);
    }

    // CAS check against both card.pin and current run.subjectPin
    const run = await this.store.getRun(card.runId);
    if (input.onPin !== card.pin.value) {
      throw Errors.stalePin(card.id, input.onPin, card.pin.value, card.replacedBy);
    }
    if (run?.subjectPin && run.subjectPin.kind === card.pin.kind && run.subjectPin.value !== card.pin.value) {
      throw Errors.stalePin(card.id, input.onPin, run.subjectPin.value, card.replacedBy);
    }

    const now = new Date().toISOString();
    card.status = 'answered';
    card.answerOption = input.option;
    card.answerNote = input.note ?? '';
    card.answeredBy = p.actorId;
    card.decidedOnPin = input.onPin;
    card.answeredAt = now;
    await this.store.updateCard(card);

    if (run && run.status === 'gated') {
      run.status = 'running';
      run.heartbeatAt = now;
      run.updatedAt = now;
      await this.store.updateRun(run);
    }

    await this.emit(
      p.wsId,
      'card',
      card.id,
      'card.answered',
      p.actorId,
      { runId: card.runId, option: card.answerOption, note: card.answerNote, decidedOnPin: card.decidedOnPin },
      run?.epoch,
    );

    this.notifyCardWaiters(card);
    return card;
  }

  async awaitCard(p: Principal, cardId: string, timeoutMs = 25_000): Promise<Card> {
    const card = await this.store.getCard(cardId);
    if (!card || card.wsId !== p.wsId) throw Errors.notFound('Card', cardId);

    // Await counts as a heartbeat so gated runs never falsely stall
    const run = await this.store.getRun(card.runId);
    if (run && !TERMINAL_RUN_STATUSES.has(run.status)) {
      run.heartbeatAt = new Date().toISOString();
      await this.store.updateRun(run);
    }

    if (card.status !== 'open') return card;

    return new Promise<Card>((resolve) => {
      let set = this.cardWaiters.get(cardId);
      if (!set) {
        set = new Set();
        this.cardWaiters.set(cardId, set);
      }
      const onUpdate = (updated: Card) => {
        clearTimeout(timer);
        set!.delete(onUpdate);
        resolve(updated);
      };
      const timer = setTimeout(async () => {
        set!.delete(onUpdate);
        const latest = (await this.store.getCard(cardId)) ?? card;
        resolve(latest);
      }, Math.min(timeoutMs, 60_000));
      set.add(onUpdate);
    });
  }

  private notifyCardWaiters(card: Card) {
    const set = this.cardWaiters.get(card.id);
    if (!set) return;
    for (const fn of [...set]) fn(card);
  }

  private async detectWaitCycle(wsId: string, askerAgent: string, targetAgent: string): Promise<string[] | null> {
    if (askerAgent === targetAgent) return [askerAgent, targetAgent];
    const openCards = await this.store.listCards(wsId, { status: 'open' });
    const adj = new Map<string, string[]>();
    for (const c of openCards) {
      if (c.blocking && c.assignee.kind === 'agent') {
        const list = adj.get(c.asker) ?? [];
        list.push(c.assignee.id);
        adj.set(c.asker, list);
      }
    }
    // Check if targetAgent can reach askerAgent
    const visited = new Set<string>();
    const stack: Array<{ node: string; path: string[] }> = [{ node: targetAgent, path: [askerAgent, targetAgent] }];
    while (stack.length > 0) {
      const { node, path } = stack.pop()!;
      if (visited.has(node)) continue;
      visited.add(node);
      for (const next of adj.get(node) ?? []) {
        if (next === askerAgent) return [...path, askerAgent];
        stack.push({ node: next, path: [...path, next] });
      }
    }
    return null;
  }

  // ---------- Takeover, Cancel, Resume (Epoch Fencing) ----------
  async takeoverRun(p: Principal, runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    run.epoch += 1;
    run.status = 'overridden';
    run.updatedAt = new Date().toISOString();
    await this.store.updateRun(run);
    await this.withdrawOpenCards(p, run);
    await this.emit(p.wsId, 'run', run.id, 'run.fenced', p.actorId, { reason: 'human_takeover', newEpoch: run.epoch }, run.epoch);
    return run;
  }

  async cancelRun(p: Principal, runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    run.epoch += 1;
    run.status = 'cancelled';
    run.updatedAt = new Date().toISOString();
    await this.store.updateRun(run);
    await this.withdrawOpenCards(p, run);
    await this.emit(p.wsId, 'run', run.id, 'run.fenced', p.actorId, { reason: 'cancelled', newEpoch: run.epoch }, run.epoch);
    return run;
  }

  async resumeRun(p: Principal, runId: string): Promise<Run> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    if (run.status !== 'stalled') {
      throw Errors.badRequest(`Run ${run.id} is ${run.status}, not stalled`);
    }
    const now = new Date().toISOString();
    run.epoch += 1;
    run.status = 'running';
    run.heartbeatAt = now;
    run.updatedAt = now;
    await this.store.updateRun(run);
    await this.emit(
      p.wsId,
      'run',
      run.id,
      'run.resumed',
      p.actorId,
      { fromCheckpointStep: run.lastCheckpointStep, newEpoch: run.epoch },
      run.epoch,
    );
    return run;
  }

  private async withdrawOpenCards(p: Principal, run: Run) {
    const open = await this.store.listCards(p.wsId, { runId: run.id, status: 'open' });
    for (const c of open) {
      c.status = 'withdrawn';
      await this.store.updateCard(c);
      this.notifyCardWaiters(c);
    }
  }

  // ---------- Flows ----------
  async createFlow(
    p: Principal,
    input: {
      name: string;
      triggerKind: 'cron' | 'webhook' | 'manual';
      triggerSpec?: string;
      agentId: string;
      steps: Array<{ title: string; kind?: StepKind }>;
      gates?: Array<{ when: string; prompt: string; options: string[] }>;
      retryMax?: number;
    },
  ): Promise<FlowTemplate> {
    const flow: FlowTemplate = {
      id: uid('flow'),
      wsId: p.wsId,
      name: input.name,
      triggerKind: input.triggerKind,
      triggerSpec: input.triggerSpec ?? '',
      agentId: input.agentId,
      sponsorHuman: p.sponsorHuman ?? p.actorId,
      steps: input.steps,
      gates: input.gates ?? [],
      retryMax: input.retryMax ?? 2,
      createdAt: new Date().toISOString(),
    };
    await this.store.createFlow(flow);
    return flow;
  }

  async triggerFlow(p: Principal, flowId: string): Promise<{ run: Run; steps: Step[] }> {
    const flow = await this.store.getFlow(flowId);
    if (!flow || flow.wsId !== p.wsId) throw Errors.notFound('FlowTemplate', flowId);

    const now = new Date().toISOString();
    const run: Run = {
      id: uid('r'),
      wsId: p.wsId,
      flowTemplateId: flow.id,
      ownerAgent: flow.agentId,
      sponsorHuman: flow.sponsorHuman,
      epoch: 1,
      planVersion: 1,
      status: 'running',
      heartbeatAt: now,
      lastCheckpointStep: 0,
      touches: [],
      subjectPin: { kind: 'plan', value: 'v1' },
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);
    const steps: Step[] = flow.steps.map((s, i) => ({
      id: uid('st'),
      runId: run.id,
      planVersion: 1,
      idx: i + 1,
      title: s.title,
      kind: s.kind ?? 'task',
      status: i === 0 ? 'active' : 'pending',
      note: '',
      startedAt: i === 0 ? now : undefined,
    }));
    await this.store.replaceSteps(run.id, 1, steps);
    await this.emit(p.wsId, 'flow', flow.id, 'flow.triggered', p.actorId, { runId: run.id }, run.epoch);
    return { run, steps };
  }

  // ---------- Scoped Threads ----------
  async postThreadMessage(
    p: Principal,
    input: {
      scopeKind: 'workspace' | 'run' | 'step' | 'card';
      scopeId: string;
      body: string;
      sendToAgent?: boolean;
    },
  ): Promise<{ message: ThreadMessage; steer?: Steer }> {
    let steer: Steer | undefined;
    if (input.sendToAgent && input.scopeKind === 'run') {
      steer = await this.queueSteer(p, input.scopeId, {
        op: 'freeform',
        payload: { text: input.body },
        urgency: 'normal',
      });
    }
    const msg: ThreadMessage = {
      id: uid('msg'),
      wsId: p.wsId,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      author: p.actorName,
      authorKind: p.kind,
      body: input.body,
      steerId: steer?.id,
      createdAt: new Date().toISOString(),
    };
    await this.store.createThreadMessage(msg);
    await this.emit(p.wsId, 'thread', input.scopeId, 'thread.message', p.actorId, {
      scopeKind: input.scopeKind,
      steerId: steer?.id,
    });
    return { message: msg, steer };
  }

  // ---------- Background Sweepers: Liveness & Card Expiry ----------
  async sweepLiveness(wsId: string, nowMs = Date.now()): Promise<Run[]> {
    const runs = await this.store.listRuns(wsId);
    const stalled: Run[] = [];
    for (const run of runs) {
      if (run.status !== 'running' && run.status !== 'gated') continue;
      const elapsed = nowMs - new Date(run.heartbeatAt).getTime();
      if (elapsed >= this.stallTimeoutMs) {
        run.status = 'stalled';
        run.updatedAt = new Date(nowMs).toISOString();
        await this.store.updateRun(run);
        stalled.push(run);
        await this.emit(wsId, 'run', run.id, 'run.heartbeat_lost', 'system', { elapsedMs: elapsed }, run.epoch);

        // Flow auto-retry up to retryMax, then single deduped escalation card
        if (run.flowTemplateId) {
          const flow = await this.store.getFlow(run.flowTemplateId);
          if (flow && run.epoch <= flow.retryMax) {
            run.epoch += 1;
            run.status = 'running';
            run.heartbeatAt = new Date(nowMs).toISOString();
            await this.store.updateRun(run);
            await this.emit(wsId, 'run', run.id, 'run.resumed', 'system', { autoRetry: true, newEpoch: run.epoch }, run.epoch);
          } else if (flow) {
            const sysPrincipal: Principal = {
              wsId,
              actorId: 'system',
              actorName: 'Ripple Scheduler',
              kind: 'human',
              roles: ['lead'],
            };
            await this.askCard(sysPrincipal, run.id, {
              epoch: run.epoch,
              type: 'choose',
              prompt: `Flow "${flow.name}" stalled after ${flow.retryMax} retries. Action?`,
              options: ['retry_now', 'pause_flow', 'dismiss'],
              assignee: { kind: 'user', id: flow.sponsorHuman },
              blocking: false,
              dedupeKey: `flow_escalate:${flow.id}`,
            });
            await this.emit(wsId, 'flow', flow.id, 'flow.escalated', 'system', { runId: run.id }, run.epoch);
          }
        }
      }
    }
    return stalled;
  }

  async sweepExpiredCards(wsId: string, nowMs = Date.now()): Promise<Card[]> {
    const openCards = await this.store.listCards(wsId, { status: 'open' });
    const touched: Card[] = [];
    for (const c of openCards) {
      if (!c.expiresAt) continue;
      if (new Date(c.expiresAt).getTime() > nowMs) continue;
      if (c.onExpire === 'hold') continue;

      if (c.onExpire === 'default_option' && c.defaultOption) {
        c.status = 'answered';
        c.answerOption = c.defaultOption;
        c.answerNote = 'Auto-answered on expiry';
        c.answeredBy = 'system';
        c.decidedOnPin = c.pin.value;
        c.answeredAt = new Date(nowMs).toISOString();
        await this.store.updateCard(c);
        this.notifyCardWaiters(c);
        await this.emit(wsId, 'card', c.id, 'card.expired', 'system', { action: 'default_option', option: c.defaultOption });
        touched.push(c);
      } else if (c.onExpire === 'escalate') {
        c.assignee = { kind: 'role', id: 'lead' };
        c.expiresAt = undefined;
        await this.store.updateCard(c);
        await this.emit(wsId, 'card', c.id, 'card.expired', 'system', { action: 'escalate', newAssignee: c.assignee });
        touched.push(c);
      }
    }
    return touched;
  }

  private async computeOverlaps(run: Run): Promise<OverlapWarning[]> {
    if (run.touches.length === 0) return [];
    const runs = await this.store.listRuns(run.wsId);
    const warnings: OverlapWarning[] = [];
    for (const other of runs) {
      if (other.id === run.id || TERMINAL_RUN_STATUSES.has(other.status)) continue;
      const shared = other.touches.filter((t) => run.touches.includes(t));
      if (shared.length > 0) {
        warnings.push({ runId: other.id, ownerAgent: other.ownerAgent, touches: shared });
      }
    }
    return warnings;
  }
}
