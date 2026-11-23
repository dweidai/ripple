export type PrincipalKind = 'human' | 'agent';

export interface Principal {
  wsId: string;
  actorId: string;
  actorName: string;
  kind: PrincipalKind;
  sponsorHuman?: string;
  parentAgentId?: string;
  roles: string[];
  avatarColor?: string;
  bio?: string;
  capabilities?: string[];
  lastSeenAt?: string;
  statusText?: string;
  online?: boolean;
}

export type ItemStatus = 'open' | 'active' | 'done' | 'dropped';

export interface Item {
  id: string;
  wsId: string;
  title: string;
  body: string;
  priority: string;
  version: number;
  status: ItemStatus;
  createdBy: string;
  assigneeId?: string;
  parentItemId?: string;
  tags: string[];
  linkedRunId?: string;
  resultUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export type RunStatus =
  | 'claimed'
  | 'planning'
  | 'running'
  | 'checkpoint'
  | 'gated'
  | 'stalled'
  | 'overridden'
  | 'cancelled'
  | 'failed'
  | 'done';

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'done',
  'failed',
  'cancelled',
  'overridden',
]);

export interface Run {
  id: string;
  wsId: string;
  itemId?: string;
  flowTemplateId?: string;
  ownerAgent: string;
  sponsorHuman: string;
  parentRunId?: string;
  parentStepIdx?: number;
  title?: string;
  goal?: string;
  reportSummary?: string;
  reportData?: Record<string, unknown>;
  depth: number;
  epoch: number;
  planVersion: number;
  status: RunStatus;
  heartbeatAt: string;
  lastCheckpointStep: number;
  touches: string[];
  subjectPin?: Pin;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export type StepKind = 'task' | 'gate';
export type StepStatus = 'pending' | 'active' | 'done' | 'failed' | 'skipped';

export interface Step {
  id: string;
  runId: string;
  planVersion: number;
  idx: number;
  title: string;
  kind: StepKind;
  status: StepStatus;
  note: string;
  startedAt?: string;
  doneAt?: string;
}

export type SteerUrgency = 'normal' | 'now';
export type SteerOp = 'edit' | 'insert' | 'reorder' | 'annotate' | 'freeform';
export type SteerStatus = 'queued' | 'delivered' | 'acked' | 'rejected';

export interface Steer {
  id: string;
  runId: string;
  author: string;
  pinPlanVersion: number;
  urgency: SteerUrgency;
  op: SteerOp;
  payload: Record<string, unknown>;
  status: SteerStatus;
  ackNote: string;
  createdAt: string;
  ackedAt?: string;
}

export interface Pin {
  kind: 'commit' | 'plan' | 'item' | 'artifact';
  value: string;
}

export type CardType = 'approve' | 'choose' | 'provide' | 'review';
export type CardStatus = 'open' | 'answered' | 'stale' | 'expired' | 'withdrawn';
export type CardOnExpire = 'hold' | 'default_option' | 'escalate';

export interface CardAssignee {
  kind: 'user' | 'role' | 'agent';
  id: string;
}

export interface Card {
  id: string;
  wsId: string;
  runId: string;
  asker: string;
  type: CardType;
  prompt: string;
  options: string[];
  diffPreview: string;
  pin: Pin;
  assignee: CardAssignee;
  blocking: boolean;
  status: CardStatus;
  answerOption?: string;
  answerNote?: string;
  answeredBy?: string;
  decidedOnPin?: string;
  replacedBy?: string;
  expiresAt?: string;
  onExpire: CardOnExpire;
  defaultOption?: string;
  dedupeKey?: string;
  createdAt: string;
  answeredAt?: string;
}

export type ArtifactKind = 'commit' | 'pr' | 'file' | 'url' | 'drive' | 'gdoc';

export interface Artifact {
  id: string;
  runId: string;
  stepIdx: number;
  kind: ArtifactKind;
  ref: string;
  label: string;
  url?: string;
  meta?: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
}

export interface FlowTemplate {
  id: string;
  wsId: string;
  name: string;
  triggerKind: 'cron' | 'webhook' | 'manual';
  triggerSpec: string;
  agentId: string;
  sponsorHuman: string;
  steps: Array<{ title: string; kind?: StepKind }>;
  gates: Array<{ when: string; prompt: string; options: string[] }>;
  retryMax: number;
  createdAt: string;
}

export interface MessageReadReceipt {
  actorId: string;
  actorName: string;
  kind: PrincipalKind;
  readAt: string;
  ack?: boolean;
  emoji?: string;
}

export interface ThreadMessage {
  id: string;
  wsId: string;
  scopeKind: 'workspace' | 'run' | 'step' | 'card';
  scopeId: string;
  actorId: string;
  author: string;
  authorKind: PrincipalKind;
  body: string;
  mentions: string[];
  replyToId?: string;
  runId?: string;
  itemId?: string;
  hopCount: number;
  steerId?: string;
  readBy?: MessageReadReceipt[];
  createdAt: string;
}

export interface SubrunTreeNode {
  run: Run;
  steps: Step[];
  artifacts: Artifact[];
  children: SubrunTreeNode[];
}

export interface WorkspaceContext {
  workspaceId: string;
  publicUrl?: string;
  whoami: Principal;
  participants: Principal[];
  recentDialogue: ThreadMessage[];
  items: Item[];
  activeRuns: Run[];
  subrunTree: SubrunTreeNode[];
  openCards: Card[];
  recentArtifacts: Artifact[];
}

export interface RippleEvent {
  seq: number;
  wsId: string;
  entity: string;
  entityId: string;
  type: string;
  actor: string;
  epoch?: number;
  payload: Record<string, unknown>;
  at: string;
}

export interface OverlapWarning {
  runId: string;
  ownerAgent: string;
  touches: string[];
}

export interface CheckpointResponse {
  runId: string;
  epoch: number;
  planVersion: number;
  steers: Steer[];
  directives: string[];
  overlaps: OverlapWarning[];
}

export interface HeartbeatResponse {
  runId: string;
  epoch: number;
  status: RunStatus;
  urgentSteers: Steer[];
  directives: string[];
}

