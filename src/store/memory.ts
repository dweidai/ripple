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
} from '../types.js';
import type { EventListener, Store, TokenRecord } from './interface.js';

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

  async init(): Promise<void> {}
  async close(): Promise<void> {}

  async ensureWorkspace(id: string, name: string): Promise<void> {
    if (!this.workspaces.has(id)) this.workspaces.set(id, name);
  }

  async saveToken(record: TokenRecord): Promise<void> {
    this.tokens.set(record.tokenHash, { ...record });
  }

  async getTokenByHash(hash: string): Promise<TokenRecord | undefined> {
    const t = this.tokens.get(hash);
    return t ? { ...t } : undefined;
  }

  async listTokens(wsId: string): Promise<TokenRecord[]> {
    return [...this.tokens.values()].filter((t) => t.wsId === wsId && !t.revokedAt);
  }

  async revokeToken(hash: string): Promise<void> {
    const t = this.tokens.get(hash);
    if (t) t.revokedAt = new Date().toISOString();
  }

  async createItem(item: Item): Promise<Item> {
    this.items.set(item.id, { ...item });
    return { ...item };
  }

  async getItem(id: string): Promise<Item | undefined> {
    const i = this.items.get(id);
    return i ? { ...i } : undefined;
  }

  async listItems(wsId: string): Promise<Item[]> {
    return [...this.items.values()]
      .filter((i) => i.wsId === wsId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async updateItem(item: Item): Promise<Item> {
    this.items.set(item.id, { ...item });
    return { ...item };
  }

  async createRun(run: Run): Promise<Run> {
    this.runs.set(run.id, { ...run, touches: [...run.touches] });
    return { ...run };
  }

  async getRun(id: string): Promise<Run | undefined> {
    const r = this.runs.get(id);
    return r ? { ...r, touches: [...r.touches] } : undefined;
  }

  async listRuns(wsId: string): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((r) => r.wsId === wsId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findActiveRunByItem(itemId: string): Promise<Run | undefined> {
    for (const r of this.runs.values()) {
      if (r.itemId === itemId && !TERMINAL_RUN_STATUSES.has(r.status)) {
        return { ...r, touches: [...r.touches] };
      }
    }
    return undefined;
  }

  async updateRun(run: Run): Promise<Run> {
    this.runs.set(run.id, { ...run, touches: [...run.touches] });
    return { ...run };
  }

  async replaceSteps(runId: string, planVersion: number, steps: Step[]): Promise<Step[]> {
    this.steps.set(
      `${runId}:${planVersion}`,
      steps.map((s) => ({ ...s })),
    );
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
    return { ...step };
  }

  async createSteer(steer: Steer): Promise<Steer> {
    this.steers.set(steer.id, { ...steer });
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
    return { ...steer };
  }

  async createArtifact(artifact: Artifact): Promise<Artifact> {
    const arr = this.artifacts.get(artifact.runId) ?? [];
    arr.push({ ...artifact });
    this.artifacts.set(artifact.runId, arr);
    return { ...artifact };
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    return (this.artifacts.get(runId) ?? []).map((a) => ({ ...a }));
  }

  async createCard(card: Card): Promise<Card> {
    this.cards.set(card.id, { ...card, options: [...card.options], pin: { ...card.pin } });
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
    return { ...card };
  }

  async createFlow(flow: FlowTemplate): Promise<FlowTemplate> {
    this.flows.set(flow.id, { ...flow });
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
    this.threads.push({ ...msg });
    return { ...msg };
  }

  async listThreadMessages(wsId: string, scopeKind: string, scopeId: string): Promise<ThreadMessage[]> {
    return this.threads.filter(
      (m) => m.wsId === wsId && m.scopeKind === scopeKind && m.scopeId === scopeId,
    );
  }

  async appendEvent(event: Omit<RippleEvent, 'seq'>): Promise<RippleEvent> {
    this.seq += 1;
    const full: RippleEvent = { ...event, seq: this.seq };
    this.events.push(full);
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
