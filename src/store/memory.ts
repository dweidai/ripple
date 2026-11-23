import fs from 'node:fs/promises';
import path from 'node:path';
import { TERMINAL_RUN_STATUSES } from '../types.js';
import type {
  Artifact,
  Card,
  FlowTemplate,
  Item,
  Run,
  Steer,
  Step,
  RippleEvent,
  ThreadMessage,
  MessageReadReceipt,
} from '../types.js';
import type { EventListener, Store, TokenRecord } from './interface.js';

interface PersistedState {
  workspaces: Array<[string, string]>;
  tokens: Array<[string, TokenRecord]>;
  items: Array<[string, Item]>;
  runs: Array<[string, Run]>;
  steps: Array<[string, Step[]]>;
  steers: Array<[string, Steer]>;
  artifacts: Array<[string, Artifact[]]>;
  cards: Array<[string, Card]>;
  flows: Array<[string, FlowTemplate]>;
  threads: ThreadMessage[];
  events: RippleEvent[];
  seq: number;
}

export class MemoryStore implements Store {
  private workspaces = new Map<string, string>();
  private tokens = new Map<string, TokenRecord>();
  private items = new Map<string, Item>();
  private runs = new Map<string, Run>();
  private steps = new Map<string, Step[]>(); // key: `${runId}:${planVersion}`
  private steers = new Map<string, Steer>();
  private artifacts = new Map<string, Artifact[]>();
  private cards = new Map<string, Card>();
  private flows = new Map<string, FlowTemplate>();
  private threads: ThreadMessage[] = [];
  private events: RippleEvent[] = [];
  private seq = 0;
  private listeners = new Map<string, Set<EventListener>>();
  private idempotency = new Map<string, unknown>();
  private saveTimer?: NodeJS.Timeout;
  private savingPromise: Promise<void> = Promise.resolve();

  constructor(private readonly stateFile?: string) {}

  async init(): Promise<void> {
    if (!this.stateFile) return;
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (parsed.workspaces) this.workspaces = new Map(parsed.workspaces);
      if (parsed.tokens) this.tokens = new Map(parsed.tokens);
      if (parsed.items) this.items = new Map(parsed.items);
      if (parsed.runs) this.runs = new Map(parsed.runs);
      if (parsed.steps) this.steps = new Map(parsed.steps);
      if (parsed.steers) this.steers = new Map(parsed.steers);
      if (parsed.artifacts) this.artifacts = new Map(parsed.artifacts);
      if (parsed.cards) this.cards = new Map(parsed.cards);
      if (parsed.flows) this.flows = new Map(parsed.flows);
      if (parsed.threads) this.threads = parsed.threads;
      if (parsed.events) this.events = parsed.events;
      if (typeof parsed.seq === 'number') this.seq = parsed.seq;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        console.warn('[ripple] could not load state file, starting fresh:', err?.message);
      }
    }
  }

  async close(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.flushToDisk();
  }

  private schedulePersist(): void {
    if (!this.stateFile) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.flushToDisk();
    }, 30);
  }

  async flushToDisk(): Promise<void> {
    if (!this.stateFile) return;
    const stateFile = this.stateFile;
    this.savingPromise = this.savingPromise
      .then(async () => {
        const snapshot: PersistedState = {
          workspaces: [...this.workspaces.entries()],
          tokens: [...this.tokens.entries()],
          items: [...this.items.entries()],
          runs: [...this.runs.entries()],
          steps: [...this.steps.entries()],
          steers: [...this.steers.entries()],
          artifacts: [...this.artifacts.entries()],
          cards: [...this.cards.entries()],
          flows: [...this.flows.entries()],
          threads: this.threads,
          events: this.events.slice(-500),
          seq: this.seq,
        };
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        const tmpFile = `${stateFile}.tmp`;
        await fs.writeFile(tmpFile, JSON.stringify(snapshot, null, 2), 'utf8');
        await fs.rename(tmpFile, stateFile);
      })
      .catch((err) => {
        console.warn('[ripple] state persist warning:', err?.message);
      });
    return this.savingPromise;
  }

  async ensureWorkspace(id: string, name: string): Promise<void> {
    if (!this.workspaces.has(id)) {
      this.workspaces.set(id, name);
      this.schedulePersist();
    }
  }

  async saveToken(record: TokenRecord): Promise<void> {
    this.tokens.set(record.tokenHash, { ...record });
    this.schedulePersist();
  }

  async getTokenByHash(hash: string): Promise<TokenRecord | undefined> {
    const t = this.tokens.get(hash);
    return t ? { ...t } : undefined;
  }

  async getTokenByActor(wsId: string, actorId: string): Promise<TokenRecord | undefined> {
    for (const t of this.tokens.values()) {
      if (t.wsId === wsId && t.actorId === actorId && !t.revokedAt) {
        return { ...t };
      }
    }
    return undefined;
  }

  async updateTokenByActor(
    wsId: string,
    actorId: string,
    patch: Partial<TokenRecord>,
  ): Promise<TokenRecord | undefined> {
    let updated: TokenRecord | undefined;
    for (const [hash, t] of this.tokens.entries()) {
      if (t.wsId === wsId && t.actorId === actorId && !t.revokedAt) {
        const next: TokenRecord = { ...t, ...patch, tokenHash: hash, wsId, actorId };
        this.tokens.set(hash, next);
        updated = { ...next };
      }
    }
    if (updated) this.schedulePersist();
    return updated;
  }

  async listTokens(wsId: string): Promise<TokenRecord[]> {
    return [...this.tokens.values()].filter((t) => t.wsId === wsId && !t.revokedAt);
  }

  async revokeToken(hash: string): Promise<void> {
    const t = this.tokens.get(hash);
    if (t) {
      t.revokedAt = new Date().toISOString();
      this.schedulePersist();
    }
  }

  async revokeTokensByActor(wsId: string, actorId: string): Promise<void> {
    const now = new Date().toISOString();
    for (const t of this.tokens.values()) {
      if (t.wsId === wsId && t.actorId === actorId && !t.revokedAt) {
        t.revokedAt = now;
      }
    }
    this.schedulePersist();
  }

  async createItem(item: Item): Promise<Item> {
    this.items.set(item.id, { ...item, tags: [...(item.tags ?? [])] });
    this.schedulePersist();
    return { ...item, tags: [...(item.tags ?? [])] };
  }

  async getItem(id: string): Promise<Item | undefined> {
    const i = this.items.get(id);
    return i ? { ...i, tags: [...(i.tags ?? [])] } : undefined;
  }

  async listItems(wsId: string): Promise<Item[]> {
    return [...this.items.values()]
      .filter((i) => i.wsId === wsId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((i) => ({ ...i, tags: [...(i.tags ?? [])] }));
  }

  async updateItem(item: Item): Promise<Item> {
    this.items.set(item.id, { ...item, tags: [...(item.tags ?? [])] });
    this.schedulePersist();
    return { ...item, tags: [...(item.tags ?? [])] };
  }

  async createRun(run: Run): Promise<Run> {
    this.runs.set(run.id, { ...run, touches: [...run.touches] });
    this.schedulePersist();
    return { ...run, touches: [...run.touches] };
  }

  async getRun(id: string): Promise<Run | undefined> {
    const r = this.runs.get(id);
    return r ? { ...r, touches: [...r.touches] } : undefined;
  }

  async listRuns(wsId: string): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((r) => r.wsId === wsId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => ({ ...r, touches: [...r.touches] }));
  }

  async findActiveRunByItem(itemId: string): Promise<Run | undefined> {
    for (const r of this.runs.values()) {
      if (r.itemId === itemId && !TERMINAL_RUN_STATUSES.has(r.status) && !r.parentRunId) {
        return { ...r, touches: [...r.touches] };
      }
    }
    return undefined;
  }

  async updateRun(run: Run): Promise<Run> {
    this.runs.set(run.id, { ...run, touches: [...run.touches] });
    this.schedulePersist();
    return { ...run, touches: [...run.touches] };
  }

  async replaceSteps(runId: string, planVersion: number, steps: Step[]): Promise<Step[]> {
    this.steps.set(
      `${runId}:${planVersion}`,
      steps.map((s) => ({ ...s })),
    );
    this.schedulePersist();
    return steps.map((s) => ({ ...s }));
  }

  async listSteps(runId: string, planVersion?: number): Promise<Step[]> {
    if (planVersion !== undefined) {
      return (this.steps.get(`${runId}:${planVersion}`) ?? []).map((s) => ({ ...s }));
    }
    const run = this.runs.get(runId);
    if (!run || run.planVersion === 0) return [];
    return (this.steps.get(`${runId}:${run.planVersion}`) ?? []).map((s) => ({ ...s }));
  }

  async updateStep(step: Step): Promise<Step> {
    const key = `${step.runId}:${step.planVersion}`;
    const arr = this.steps.get(key) ?? [];
    const idx = arr.findIndex((s) => s.idx === step.idx);
    if (idx >= 0) arr[idx] = { ...step };
    else arr.push({ ...step });
    this.steps.set(key, arr);
    this.schedulePersist();
    return { ...step };
  }

  async createSteer(steer: Steer): Promise<Steer> {
    this.steers.set(steer.id, { ...steer });
    this.schedulePersist();
    return { ...steer };
  }

  async getSteer(id: string): Promise<Steer | undefined> {
    const s = this.steers.get(id);
    return s ? { ...s } : undefined;
  }

  async listSteers(runId: string): Promise<Steer[]> {
    return [...this.steers.values()]
      .filter((s) => s.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateSteer(steer: Steer): Promise<Steer> {
    this.steers.set(steer.id, { ...steer });
    this.schedulePersist();
    return { ...steer };
  }

  async createArtifact(artifact: Artifact): Promise<Artifact> {
    const arr = this.artifacts.get(artifact.runId) ?? [];
    arr.push({ ...artifact });
    this.artifacts.set(artifact.runId, arr);
    this.schedulePersist();
    return { ...artifact };
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    return (this.artifacts.get(runId) ?? []).map((a) => ({ ...a }));
  }

  async createCard(card: Card): Promise<Card> {
    this.cards.set(card.id, { ...card, options: [...card.options], pin: { ...card.pin } });
    this.schedulePersist();
    return { ...card };
  }

  async getCard(id: string): Promise<Card | undefined> {
    const c = this.cards.get(id);
    return c ? { ...c, options: [...c.options], pin: { ...c.pin } } : undefined;
  }

  async listCards(wsId: string, filter?: { runId?: string; status?: string }): Promise<Card[]> {
    return [...this.cards.values()]
      .filter((c) => {
        if (c.wsId !== wsId) return false;
        if (filter?.runId && c.runId !== filter.runId) return false;
        if (filter?.status && c.status !== filter.status) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateCard(card: Card): Promise<Card> {
    this.cards.set(card.id, { ...card, options: [...card.options], pin: { ...card.pin } });
    this.schedulePersist();
    return { ...card };
  }

  async createFlow(flow: FlowTemplate): Promise<FlowTemplate> {
    this.flows.set(flow.id, { ...flow });
    this.schedulePersist();
    return { ...flow };
  }

  async getFlow(id: string): Promise<FlowTemplate | undefined> {
    const f = this.flows.get(id);
    return f ? { ...f } : undefined;
  }

  async listFlows(wsId: string): Promise<FlowTemplate[]> {
    return [...this.flows.values()].filter((f) => f.wsId === wsId);
  }

  async createThreadMessage(msg: ThreadMessage): Promise<ThreadMessage> {
    const copy: ThreadMessage = {
      ...msg,
      mentions: [...(msg.mentions ?? [])],
      readBy: [...(msg.readBy ?? [])],
    };
    this.threads.push(copy);
    this.schedulePersist();
    return { ...copy, mentions: [...copy.mentions], readBy: [...(copy.readBy ?? [])] };
  }

  async listThreadMessages(wsId: string, scopeKind: string, scopeId: string): Promise<ThreadMessage[]> {
    return this.threads
      .filter((m) => m.wsId === wsId && m.scopeKind === scopeKind && m.scopeId === scopeId)
      .map((m) => ({
        ...m,
        mentions: [...(m.mentions ?? [])],
        readBy: (m.readBy ?? []).map((r) => ({ ...r })),
      }));
  }

  async recordMessageRead(wsId: string, msgId: string, receipt: MessageReadReceipt): Promise<ThreadMessage | undefined> {
    const msg = this.threads.find((m) => m.wsId === wsId && m.id === msgId);
    if (!msg) return undefined;
    if (!msg.readBy) msg.readBy = [];
    const idx = msg.readBy.findIndex((r) => r.actorId === receipt.actorId);
    if (idx >= 0) {
      const prev = msg.readBy[idx];
      msg.readBy[idx] = {
        ...prev,
        ...receipt,
        ack: receipt.ack ?? prev.ack,
        emoji: receipt.emoji ?? prev.emoji,
      };
    } else {
      msg.readBy.push({ ...receipt });
    }
    this.schedulePersist();
    return {
      ...msg,
      mentions: [...(msg.mentions ?? [])],
      readBy: msg.readBy.map((r) => ({ ...r })),
    };
  }

  async appendEvent(event: Omit<RippleEvent, 'seq'>): Promise<RippleEvent> {
    this.seq += 1;
    const full: RippleEvent = { ...event, seq: this.seq };
    this.events.push(full);
    this.schedulePersist();
    const set = this.listeners.get(event.wsId);
    if (set) {
      for (const fn of set) {
        try {
          fn(full);
        } catch {
          // ignore listener errors
        }
      }
    }
    return full;
  }

  async listEvents(wsId: string, afterSeq = 0, limit = 100): Promise<RippleEvent[]> {
    return this.events.filter((e) => e.wsId === wsId && e.seq > afterSeq).slice(-limit);
  }

  subscribe(wsId: string, listener: EventListener): () => void {
    let set = this.listeners.get(wsId);
    if (!set) {
      set = new Set();
      this.listeners.set(wsId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  async getIdempotency(key: string): Promise<unknown | undefined> {
    return this.idempotency.get(key);
  }

  async saveIdempotency(key: string, _wsId: string, response: unknown): Promise<void> {
    this.idempotency.set(key, response);
  }
}

