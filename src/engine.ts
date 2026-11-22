import crypto from 'node:crypto';
import { generateToken, hashToken, recordToPrincipal } from './auth.js';
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
  type ItemStatus,
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
  type SubrunTreeNode,
  type ThreadMessage,
  type WorkspaceContext,
} from './types.js';

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

export function extractMentions(body: string): string[] {
  const matches = body.match(/@([a-zA-Z0-9_-]+)/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1).toLowerCase()))];
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

  // ---------- Profile & Identity ----------
  async updateProfile(
    p: Principal,
    patch: { actorName?: string; statusText?: string; bio?: string; avatarColor?: string },
  ): Promise<Principal> {
    const now = new Date().toISOString();
    const updated = await this.store.updateTokenByActor(p.wsId, p.actorId, {
      ...(patch.actorName !== undefined ? { actorName: patch.actorName.trim() || p.actorName } : {}),
      ...(patch.statusText !== undefined ? { statusText: patch.statusText } : {}),
      ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
      ...(patch.avatarColor !== undefined ? { avatarColor: patch.avatarColor } : {}),
      lastSeenAt: now,
      online: true,
    });
    const result: Principal = updated
      ? recordToPrincipal(updated)
      : {
          ...p,
          ...(patch.actorName ? { actorName: patch.actorName } : {}),
          ...(patch.statusText !== undefined ? { statusText: patch.statusText } : {}),
          ...(patch.bio !== undefined ? { bio: patch.bio } : {}),
          ...(patch.avatarColor !== undefined ? { avatarColor: patch.avatarColor } : {}),
          lastSeenAt: now,
          online: true,
        };
    await this.emit(p.wsId, 'principal', p.actorId, 'principal.updated', p.actorId, {
      actorName: result.actorName,
      statusText: result.statusText,
    });
    return result;
  }

  // ---------- Items (Backlog & Tasks) ----------
  async createItem(
    p: Principal,
    input: {
      title: string;
      body?: string;
      priority?: string | number;
      assigneeId?: string;
      parentItemId?: string;
      tags?: string[];
      createdBy?: string;
    },
  ): Promise<Item> {
    if (!input.title || !String(input.title).trim()) {
      throw Errors.badRequest('Item title is required');
    }
    const now = new Date().toISOString();
    const rawPriority = input.priority ?? 'P1';
    const priority = typeof rawPriority === 'number' ? `P${rawPriority}` : String(rawPriority);
    const item: Item = {
      id: uid('item'),
      wsId: p.wsId,
      title: String(input.title).trim(),
      body: input.body ?? '',
      priority,
      version: 1,
      status: 'open',
      createdBy: input.createdBy ?? p.actorId,
      assigneeId: input.assigneeId || undefined,
      parentItemId: input.parentItemId || undefined,
      tags: Array.isArray(input.tags) ? [...new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))] : [],
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createItem(item);
    await this.emit(p.wsId, 'item', item.id, 'item.created', p.actorId, {
      title: item.title,
      priority: item.priority,
      assigneeId: item.assigneeId,
      parentItemId: item.parentItemId,
      tags: item.tags,
      createdBy: item.createdBy,
    });
    return item;
  }

  async updateItem(
    p: Principal,
    itemId: string,
    patch: {
      title?: string;
      body?: string;
      priority?: string | number;
      status?: ItemStatus;
      assigneeId?: string;
      parentItemId?: string;
      tags?: string[];
      linkedRunId?: string;
      resultUrl?: string;
    },
  ): Promise<Item> {
    const item = await this.store.getItem(itemId);
    if (!item || item.wsId !== p.wsId) throw Errors.notFound('Item', itemId);

    const now = new Date().toISOString();
    if (patch.title !== undefined) item.title = String(patch.title).trim() || item.title;
    if (patch.body !== undefined) item.body = patch.body;
    if (patch.priority !== undefined) {
      item.priority = typeof patch.priority === 'number' ? `P${patch.priority}` : String(patch.priority);
    }
    if (patch.status !== undefined) item.status = patch.status;
    if (patch.assigneeId !== undefined) item.assigneeId = patch.assigneeId || undefined;
    if (patch.parentItemId !== undefined) item.parentItemId = patch.parentItemId || undefined;
    if (patch.tags !== undefined) {
      item.tags = [...new Set(patch.tags.map((t) => String(t).trim()).filter(Boolean))];
    }
    if (patch.linkedRunId !== undefined) item.linkedRunId = patch.linkedRunId || undefined;
    if (patch.resultUrl !== undefined) item.resultUrl = patch.resultUrl || undefined;
    item.version += 1;
    item.updatedAt = now;

    await this.store.updateItem(item);
    await this.emit(p.wsId, 'item', item.id, 'item.updated', p.actorId, {
      title: item.title,
      status: item.status,
      priority: item.priority,
      assigneeId: item.assigneeId,
      version: item.version,
      resultUrl: item.resultUrl,
    });
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
      title: item.title,
      goal: item.body,
      ownerAgent: p.actorId,
      sponsorHuman: p.sponsorHuman ?? p.actorId,
      depth: 0,
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
    item.assigneeId = item.assigneeId ?? p.actorId;
    item.linkedRunId = run.id;
    item.updatedAt = now;
    await this.store.updateItem(item);
    await this.emit(p.wsId, 'run', run.id, 'run.claimed', p.actorId, { itemId: item.id, title: item.title }, run.epoch);
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
      run.endedAt = now;
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
      url?: string;
      meta?: Record<string, unknown>;
      contentHash?: string;
    },
  ): Promise<{ artifact: Artifact; staledCards: Card[]; replacementCards: Card[] }> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    this.assertEpoch(run, input.epoch);

    const now = new Date().toISOString();
    const hash = input.contentHash ?? input.ref;
    const inferredUrl =
      input.url ??
      (input.ref.startsWith('http://') || input.ref.startsWith('https://') ? input.ref : undefined);
    const artifact: Artifact = {
      id: uid('art'),
      runId: run.id,
      stepIdx: input.stepIdx,
      kind: input.kind,
      ref: input.ref,
      label: input.label ?? `${input.kind} ${input.ref}`,
      url: inferredUrl,
      meta: input.meta,
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
      title: flow.name,
      ownerAgent: flow.agentId,
      sponsorHuman: flow.sponsorHuman,
      depth: 0,
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

  // ---------- Sub-Agents & Hierarchical Runs ----------
  async spawnSubrun(
    p: Principal,
    parentRunId: string,
    input: {
      title: string;
      goal?: string;
      subagentId?: string;
      subagentName?: string;
      itemId?: string;
      parentStepIdx?: number;
      steps?: Array<{ title: string; kind?: StepKind; status?: StepStatus; note?: string }>;
      touches?: string[];
      capabilities?: string[];
    },
  ): Promise<{ run: Run; steps: Step[]; subagent: Principal }> {
    const parent = await this.store.getRun(parentRunId);
    if (!parent || parent.wsId !== p.wsId) throw Errors.notFound('Run', parentRunId);
    if (TERMINAL_RUN_STATUSES.has(parent.status)) {
      throw Errors.fenced(parent.epoch, parent.epoch);
    }

    const parentDepth = parent.depth ?? 0;
    if (parentDepth >= 3) {
      throw Errors.badRequest('Maximum sub-run depth (3) reached');
    }

    const subagentId =
      input.subagentId ||
      `${parent.ownerAgent}-sub-${crypto.randomBytes(2).toString('hex')}`;
    const subagentName =
      input.subagentName ||
      `${subagentId} (Sub-Agent of ${parent.ownerAgent})`;

    const now = new Date().toISOString();
    let existingSub = await this.store.getTokenByActor(p.wsId, subagentId);
    if (!existingSub) {
      const rawToken = generateToken(subagentId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'sub');
      await this.store.saveToken({
        tokenHash: hashToken(rawToken),
        wsId: p.wsId,
        actorId: subagentId,
        actorName: subagentName,
        kind: 'agent',
        sponsorHuman: parent.sponsorHuman,
        parentAgentId: parent.ownerAgent,
        roles: ['subagent'],
        capabilities: input.capabilities ?? ['github', 'gdrive', 'gdocs'],
        lastSeenAt: now,
        statusText: `Working on: ${input.title}`,
        online: true,
      });
      existingSub = await this.store.getTokenByActor(p.wsId, subagentId);
    } else {
      existingSub =
        (await this.store.updateTokenByActor(p.wsId, subagentId, {
          actorName: input.subagentName || existingSub.actorName,
          parentAgentId: existingSub.parentAgentId ?? parent.ownerAgent,
          lastSeenAt: now,
          statusText: `Working on: ${input.title}`,
          online: true,
        })) ?? existingSub;
    }

    const subagent: Principal = existingSub
      ? recordToPrincipal(existingSub)
      : {
          wsId: p.wsId,
          actorId: subagentId,
          actorName: subagentName,
          kind: 'agent',
          sponsorHuman: parent.sponsorHuman,
          parentAgentId: parent.ownerAgent,
          roles: ['subagent'],
          capabilities: input.capabilities ?? ['github', 'gdrive', 'gdocs'],
          lastSeenAt: now,
          statusText: `Working on: ${input.title}`,
          online: true,
        };

    const initialStepsInput =
      input.steps && input.steps.length > 0
        ? input.steps
        : [{ title: input.title, kind: 'task' as StepKind }];

    const run: Run = {
      id: uid('sub'),
      wsId: p.wsId,
      itemId: input.itemId ?? parent.itemId,
      parentRunId: parent.id,
      parentStepIdx: input.parentStepIdx,
      title: input.title,
      goal: input.goal ?? '',
      depth: parentDepth + 1,
      ownerAgent: subagent.actorId,
      sponsorHuman: parent.sponsorHuman,
      epoch: 1,
      planVersion: 1,
      status: 'running',
      heartbeatAt: now,
      lastCheckpointStep: 0,
      touches: input.touches ? [...new Set(input.touches)] : [],
      subjectPin: { kind: 'plan', value: 'v1' },
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createRun(run);

    if (input.itemId) {
      const item = await this.store.getItem(input.itemId);
      if (item && item.wsId === p.wsId) {
        item.status = 'active';
        item.assigneeId = item.assigneeId ?? subagent.actorId;
        item.linkedRunId = run.id;
        item.updatedAt = now;
        await this.store.updateItem(item);
      }
    }

    const steps: Step[] = initialStepsInput.map((s, i) => ({
      id: uid('st'),
      runId: run.id,
      planVersion: 1,
      idx: i + 1,
      title: s.title,
      kind: s.kind ?? 'task',
      status: s.status ?? (i === 0 ? 'active' : 'pending'),
      note: s.note ?? '',
      startedAt: (s.status ?? (i === 0 ? 'active' : 'pending')) === 'active' ? now : undefined,
    }));
    await this.store.replaceSteps(run.id, 1, steps);

    await this.emit(
      p.wsId,
      'run',
      run.id,
      'run.subrun_spawned',
      p.actorId,
      {
        parentRunId: parent.id,
        subrunId: run.id,
        subagentId: subagent.actorId,
        title: run.title,
        depth: run.depth,
      },
      run.epoch,
    );

    // Post notice in parent run thread
    const noticeMsg: ThreadMessage = {
      id: uid('msg'),
      wsId: p.wsId,
      scopeKind: 'run',
      scopeId: parent.id,
      actorId: p.actorId,
      author: p.actorName,
      authorKind: p.kind,
      body: `Spawned sub-agent **${subagent.actorName}** (\`@${subagent.actorId}\`) on sub-run \`${run.id}\`: *${run.title}*`,
      mentions: [subagent.actorId],
      runId: run.id,
      itemId: run.itemId,
      hopCount: 0,
      createdAt: now,
    };
    await this.store.createThreadMessage(noticeMsg);

    return { run, steps, subagent };
  }

  async reportRun(
    p: Principal,
    runId: string,
    input: {
      epoch?: number;
      summary: string;
      status?: 'done' | 'failed';
      reportData?: Record<string, unknown>;
      artifacts?: Array<{
        kind: ArtifactKind;
        ref: string;
        title?: string;
        label?: string;
        url?: string;
        contentHash?: string;
        meta?: Record<string, unknown>;
      }>;
    },
  ): Promise<{ run: Run; parentMessage?: ThreadMessage; workspaceMessage?: ThreadMessage; artifacts: Artifact[] }> {
    const run = await this.store.getRun(runId);
    if (!run || run.wsId !== p.wsId) throw Errors.notFound('Run', runId);
    if (input.epoch !== undefined) {
      this.assertEpoch(run, input.epoch);
    }

    const now = new Date().toISOString();
    const attachedArtifacts: Artifact[] = [];
    const steps = await this.store.listSteps(run.id, run.planVersion);
    const lastStepIdx = steps.length > 0 ? steps[steps.length - 1].idx : 1;

    if (input.artifacts && input.artifacts.length > 0) {
      for (const art of input.artifacts) {
        const res = await this.addArtifact(p, run.id, {
          epoch: run.epoch,
          stepIdx: lastStepIdx,
          kind: art.kind,
          ref: art.ref,
          label: art.title ?? art.label ?? `${art.kind}: ${art.ref}`,
          url: art.url ?? (art.ref.startsWith('http') ? art.ref : undefined),
          meta: art.meta,
          contentHash: art.contentHash ?? art.ref,
        });
        attachedArtifacts.push(res.artifact);
      }
    }

    const finalStatus = input.status ?? 'done';
    for (const s of steps) {
      if (s.status !== 'done' && s.status !== 'skipped') {
        s.status = finalStatus === 'failed' ? 'failed' : 'done';
        s.doneAt = now;
        if (!s.note) s.note = input.summary;
        await this.store.updateStep(s);
      }
    }

    run.reportSummary = input.summary;
    if (input.reportData) run.reportData = input.reportData;
    run.status = finalStatus;
    run.heartbeatAt = now;
    run.updatedAt = now;
    run.endedAt = now;
    await this.store.updateRun(run);

    // Update sub-agent presence status
    await this.store.updateTokenByActor(p.wsId, run.ownerAgent, {
      lastSeenAt: now,
      statusText: finalStatus === 'done' ? `Completed: ${run.title ?? run.id}` : `Failed: ${run.title ?? run.id}`,
      online: true,
    });

    // Update linked item if applicable
    const primaryUrl =
      attachedArtifacts.find((a) => a.url)?.url ??
      attachedArtifacts.find((a) => a.ref.startsWith('http'))?.ref;
    if (run.itemId) {
      const item = await this.store.getItem(run.itemId);
      if (item && (!run.parentRunId || item.linkedRunId === run.id)) {
        item.status = finalStatus === 'done' ? 'done' : item.status;
        if (primaryUrl) item.resultUrl = primaryUrl;
        item.version += 1;
        item.updatedAt = now;
        await this.store.updateItem(item);
      } else if (item && primaryUrl && !item.resultUrl) {
        item.resultUrl = primaryUrl;
        item.version += 1;
        item.updatedAt = now;
        await this.store.updateItem(item);
      }
    }

    const artifactLines =
      attachedArtifacts.length > 0
        ? '\n' +
          attachedArtifacts
            .map((a) => `• [${a.kind.toUpperCase()}] ${a.label}: ${a.url ?? a.ref}`)
            .join('\n')
        : '';

    let parentMessage: ThreadMessage | undefined;
    if (run.parentRunId) {
      const parentRun = await this.store.getRun(run.parentRunId);
      if (parentRun) {
        parentMessage = {
          id: uid('msg'),
          wsId: p.wsId,
          scopeKind: 'run',
          scopeId: parentRun.id,
          actorId: p.actorId,
          author: p.actorName,
          authorKind: p.kind,
          body: `**Sub-Agent Report (\`${run.id}\` — ${run.title ?? 'subtask'})**: ${input.summary}${artifactLines}`,
          mentions: [parentRun.ownerAgent],
          runId: run.id,
          itemId: run.itemId,
          hopCount: 0,
          createdAt: now,
        };
        await this.store.createThreadMessage(parentMessage);
      }
    }

    const parentTag = run.parentRunId
      ? await this.store.getRun(run.parentRunId).then((pr) => (pr ? `@${pr.ownerAgent} ` : ''))
      : '';
    const workspaceMessage: ThreadMessage = {
      id: uid('msg'),
      wsId: p.wsId,
      scopeKind: 'workspace',
      scopeId: 'main',
      actorId: p.actorId,
      author: p.actorName,
      authorKind: p.kind,
      body: `${parentTag}📋 **Report from \`${run.ownerAgent}\`** (${run.title ?? run.id}): ${input.summary}${artifactLines}`,
      mentions: extractMentions(parentTag),
      runId: run.id,
      itemId: run.itemId,
      hopCount: 1,
      createdAt: now,
    };
    await this.store.createThreadMessage(workspaceMessage);

    await this.emit(
      p.wsId,
      'run',
      run.id,
      'run.reported',
      p.actorId,
      {
        runId: run.id,
        parentRunId: run.parentRunId,
        status: run.status,
        summary: input.summary,
        artifacts: attachedArtifacts.map((a) => ({ id: a.id, kind: a.kind, ref: a.ref, url: a.url })),
      },
      run.epoch,
    );

    return { run, parentMessage, workspaceMessage, artifacts: attachedArtifacts };
  }

  // ---------- Scoped Threads & Workspace Dialogue ----------
  async postThreadMessage(
    p: Principal,
    input: {
      scopeKind?: 'workspace' | 'run' | 'step' | 'card';
      scopeId?: string;
      body: string;
      replyToId?: string;
      runId?: string;
      itemId?: string;
      sendToAgent?: boolean;
      urgency?: SteerUrgency;
    },
  ): Promise<{ message: ThreadMessage; steer?: Steer }> {
    if (!input.body || !String(input.body).trim()) {
      throw Errors.badRequest('Message body cannot be empty');
    }
    const scopeKind = input.scopeKind ?? 'workspace';
    const scopeId = input.scopeId ?? 'main';
    const body = String(input.body).trim();
    const mentions = extractMentions(body);

    const existingMsgs = await this.store.listThreadMessages(p.wsId, scopeKind, scopeId);
    let hopCount = 0;
    if (p.kind === 'agent') {
      const prev = existingMsgs[existingMsgs.length - 1];
      hopCount = prev && prev.authorKind === 'agent' ? (prev.hopCount ?? 1) + 1 : 1;
      if (hopCount > 6) {
        throw Errors.badRequest(
          `Anti-loop guard triggered: hopCount (${hopCount}) exceeds max consecutive agent turns (6) without human input.`,
        );
      }
    }

    let steer: Steer | undefined;
    const steerRunId = scopeKind === 'run' ? scopeId : input.runId;
    if (input.sendToAgent && steerRunId) {
      steer = await this.queueSteer(p, steerRunId, {
        op: 'freeform',
        payload: { text: body, from: p.actorId },
        urgency: input.urgency ?? 'normal',
      });
    }

    const now = new Date().toISOString();
    const msg: ThreadMessage = {
      id: uid('msg'),
      wsId: p.wsId,
      scopeKind,
      scopeId,
      actorId: p.actorId,
      author: p.actorName,
      authorKind: p.kind,
      body,
      mentions,
      replyToId: input.replyToId,
      runId: input.runId ?? (scopeKind === 'run' ? scopeId : undefined),
      itemId: input.itemId,
      hopCount,
      steerId: steer?.id,
      createdAt: now,
    };
    await this.store.createThreadMessage(msg);
    await this.emit(p.wsId, 'thread', scopeId, 'thread.message', p.actorId, {
      messageId: msg.id,
      scopeKind,
      scopeId,
      actorId: p.actorId,
      authorKind: p.kind,
      body: msg.body,
      mentions: msg.mentions,
      hopCount: msg.hopCount,
      runId: msg.runId,
      itemId: msg.itemId,
      steerId: steer?.id,
    });
    return { message: msg, steer };
  }

  // ---------- Unified Workspace Context ----------
  async getContext(
    p: Principal,
    opts?: { runId?: string; limit?: number; publicUrl?: string },
  ): Promise<WorkspaceContext> {
    const limit = opts?.limit ?? 30;
    const [tokens, items, allRuns, openCards, workspaceMsgs] = await Promise.all([
      this.store.listTokens(p.wsId),
      this.store.listItems(p.wsId),
      this.store.listRuns(p.wsId),
      this.store.listCards(p.wsId, { status: 'open' }),
      this.store.listThreadMessages(p.wsId, 'workspace', 'main'),
    ]);

    const participants = tokens.map(recordToPrincipal);
    const activeRuns = allRuns.filter((r) => !TERMINAL_RUN_STATUSES.has(r.status));

    const stepsMap = new Map<string, Step[]>();
    const artifactsMap = new Map<string, Artifact[]>();
    const recentArtifacts: Artifact[] = [];

    for (const r of allRuns) {
      const [st, arts] = await Promise.all([
        this.store.listSteps(r.id),
        this.store.listArtifacts(r.id),
      ]);
      stepsMap.set(r.id, st);
      artifactsMap.set(r.id, arts);
      recentArtifacts.push(...arts);
    }
    recentArtifacts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const buildNode = (run: Run): SubrunTreeNode => {
      const children = allRuns
        .filter((c) => c.parentRunId === run.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(buildNode);
      return {
        run,
        steps: stepsMap.get(run.id) ?? [],
        artifacts: artifactsMap.get(run.id) ?? [],
        children,
      };
    };

    const rootRuns = opts?.runId
      ? allRuns.filter((r) => r.id === opts.runId)
      : allRuns.filter((r) => !r.parentRunId);
    const subrunTree = rootRuns.map(buildNode);

    return {
      workspaceId: p.wsId,
      publicUrl: opts?.publicUrl,
      whoami: p,
      participants,
      recentDialogue: workspaceMsgs.slice(-limit),
      items,
      activeRuns,
      subrunTree,
      openCards,
      recentArtifacts: recentArtifacts.slice(0, 25),
    };
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
