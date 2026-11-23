import type {
  Artifact,
  Card,
  FlowTemplate,
  Item,
  Principal,
  Run,
  Steer,
  Step,
  RippleEvent,
  ThreadMessage,
  MessageReadReceipt,
} from '../types.js';

export interface TokenRecord extends Principal {
  tokenHash: string;
  rawToken?: string;
  revokedAt?: string;
}

export type EventListener = (event: RippleEvent) => void;

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  // Workspaces & Auth
  ensureWorkspace(id: string, name: string): Promise<void>;
  saveToken(record: TokenRecord): Promise<void>;
  getTokenByHash(hash: string): Promise<TokenRecord | undefined>;
  getTokenByActor(wsId: string, actorId: string): Promise<TokenRecord | undefined>;
  updateTokenByActor(wsId: string, actorId: string, patch: Partial<TokenRecord>): Promise<TokenRecord | undefined>;
  listTokens(wsId: string): Promise<TokenRecord[]>;
  revokeToken(hash: string): Promise<void>;
  revokeTokensByActor(wsId: string, actorId: string): Promise<void>;


  // Items
  createItem(item: Item): Promise<Item>;
  getItem(id: string): Promise<Item | undefined>;
  listItems(wsId: string): Promise<Item[]>;
  updateItem(item: Item): Promise<Item>;

  // Runs
  createRun(run: Run): Promise<Run>;
  getRun(id: string): Promise<Run | undefined>;
  listRuns(wsId: string): Promise<Run[]>;
  findActiveRunByItem(itemId: string): Promise<Run | undefined>;
  updateRun(run: Run): Promise<Run>;

  // Steps
  replaceSteps(runId: string, planVersion: number, steps: Step[]): Promise<Step[]>;
  listSteps(runId: string, planVersion?: number): Promise<Step[]>;
  updateStep(step: Step): Promise<Step>;

  // Steers
  createSteer(steer: Steer): Promise<Steer>;
  getSteer(id: string): Promise<Steer | undefined>;
  listSteers(runId: string): Promise<Steer[]>;
  updateSteer(steer: Steer): Promise<Steer>;

  // Artifacts
  createArtifact(artifact: Artifact): Promise<Artifact>;
  listArtifacts(runId: string): Promise<Artifact[]>;

  // Cards
  createCard(card: Card): Promise<Card>;
  getCard(id: string): Promise<Card | undefined>;
  listCards(wsId: string, filter?: { runId?: string; status?: string }): Promise<Card[]>;
  updateCard(card: Card): Promise<Card>;

  // Flows
  createFlow(flow: FlowTemplate): Promise<FlowTemplate>;
  getFlow(id: string): Promise<FlowTemplate | undefined>;
  listFlows(wsId: string): Promise<FlowTemplate[]>;

  // Scoped Threads
  createThreadMessage(msg: ThreadMessage): Promise<ThreadMessage>;
  listThreadMessages(wsId: string, scopeKind: string, scopeId: string): Promise<ThreadMessage[]>;
  recordMessageRead(wsId: string, msgId: string, receipt: MessageReadReceipt): Promise<ThreadMessage | undefined>;

  // Append-only Event Log & Fan-out
  appendEvent(event: Omit<RippleEvent, 'seq'>): Promise<RippleEvent>;
  listEvents(wsId: string, afterSeq?: number, limit?: number): Promise<RippleEvent[]>;
  subscribe(wsId: string, listener: EventListener): () => void;

  // Idempotency
  getIdempotency(key: string): Promise<unknown | undefined>;
  saveIdempotency(key: string, wsId: string, response: unknown): Promise<void>;
}
