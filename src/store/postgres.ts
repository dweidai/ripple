import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
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

const { Pool, Client } = pg;

export class PostgresStore implements Store {
  private pool: pg.Pool;
  private notifyClient?: pg.Client;
  private listeners = new Map<string, Set<EventListener>>();

  constructor(private readonly connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const migrationPath = path.resolve(dir, '../../db/migrations/001_init.sql');
    const sql = await fs.readFile(migrationPath, 'utf8');
    await this.pool.query(sql);

    this.notifyClient = new Client({ connectionString: this.connectionString });
    await this.notifyClient.connect();
    await this.notifyClient.query('LISTEN ripple_events');
    this.notifyClient.on('notification', async (msg) => {
      if (!msg.payload) return;
      try {
        const { wsId, seq } = JSON.parse(msg.payload) as { wsId: string; seq: number };
        const set = this.listeners.get(wsId);
        if (!set || set.size === 0) return;
        const { rows } = await this.pool.query('SELECT * FROM events WHERE seq = $1', [seq]);
        if (rows[0]) {
          const ev = mapEvent(rows[0]);
          for (const fn of set) fn(ev);
        }
      } catch {
        // ignore malformed notification
      }
    });
  }

  async close(): Promise<void> {
    if (this.notifyClient) await this.notifyClient.end();
    await this.pool.end();
  }

  async ensureWorkspace(id: string, name: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [id, name],
    );
  }

  async saveToken(r: TokenRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO tokens (token_hash, ws_id, actor_id, actor_name, kind, sponsor_human, roles)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (token_hash) DO UPDATE SET actor_name = EXCLUDED.actor_name, roles = EXCLUDED.roles`,
      [r.tokenHash, r.wsId, r.actorId, r.actorName, r.kind, r.sponsorHuman ?? null, r.roles],
    );
  }

  async getTokenByHash(hash: string): Promise<TokenRecord | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM tokens WHERE token_hash = $1', [hash]);
    return rows[0] ? mapToken(rows[0]) : undefined;
  }

  async listTokens(wsId: string): Promise<TokenRecord[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM tokens WHERE ws_id = $1 AND revoked_at IS NULL ORDER BY created_at ASC',
      [wsId],
    );
    return rows.map(mapToken);
  }

  async revokeToken(hash: string): Promise<void> {
    await this.pool.query('UPDATE tokens SET revoked_at = NOW() WHERE token_hash = $1', [hash]);
  }

  async createItem(i: Item): Promise<Item> {
    await this.pool.query(
      `INSERT INTO items (id, ws_id, title, body, priority, version, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [i.id, i.wsId, i.title, i.body, i.priority, i.version, i.status, i.createdAt, i.updatedAt],
    );
    return i;
  }

  async getItem(id: string): Promise<Item | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM items WHERE id = $1', [id]);
    return rows[0] ? mapItem(rows[0]) : undefined;
  }

  async listItems(wsId: string): Promise<Item[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM items WHERE ws_id = $1 ORDER BY created_at ASC',
      [wsId],
    );
    return rows.map(mapItem);
  }

  async updateItem(i: Item): Promise<Item> {
    await this.pool.query(
      `UPDATE items SET title=$2, body=$3, priority=$4, version=$5, status=$6, updated_at=$7 WHERE id=$1`,
      [i.id, i.title, i.body, i.priority, i.version, i.status, i.updatedAt],
    );
    return i;
  }

  async createRun(r: Run): Promise<Run> {
    await this.pool.query(
      `INSERT INTO runs (id, ws_id, item_id, flow_template_id, owner_agent, sponsor_human, epoch, plan_version, status, heartbeat_at, last_checkpoint_step, touches, subject_pin_kind, subject_pin_value, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        r.id,
        r.wsId,
        r.itemId ?? null,
        r.flowTemplateId ?? null,
        r.ownerAgent,
        r.sponsorHuman,
        r.epoch,
        r.planVersion,
        r.status,
        r.heartbeatAt,
        r.lastCheckpointStep,
        r.touches,
        r.subjectPin?.kind ?? null,
        r.subjectPin?.value ?? null,
        r.createdAt,
        r.updatedAt,
      ],
    );
    return r;
  }

  async getRun(id: string): Promise<Run | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM runs WHERE id = $1', [id]);
    return rows[0] ? mapRun(rows[0]) : undefined;
  }

  async listRuns(wsId: string): Promise<Run[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM runs WHERE ws_id = $1 ORDER BY created_at DESC',
      [wsId],
    );
    return rows.map(mapRun);
  }

  async findActiveRunByItem(itemId: string): Promise<Run | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM runs WHERE item_id = $1 AND status NOT IN ('done','cancelled','overridden') LIMIT 1`,
      [itemId],
    );
    return rows[0] ? mapRun(rows[0]) : undefined;
  }

  async updateRun(r: Run): Promise<Run> {
    await this.pool.query(
      `UPDATE runs SET epoch=$2, plan_version=$3, status=$4, heartbeat_at=$5, last_checkpoint_step=$6,
       touches=$7, subject_pin_kind=$8, subject_pin_value=$9, updated_at=$10 WHERE id=$1`,
      [
        r.id,
        r.epoch,
        r.planVersion,
        r.status,
        r.heartbeatAt,
        r.lastCheckpointStep,
        r.touches,
        r.subjectPin?.kind ?? null,
        r.subjectPin?.value ?? null,
        r.updatedAt,
      ],
    );
    return r;
  }

  async replaceSteps(runId: string, planVersion: number, steps: Step[]): Promise<Step[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM steps WHERE run_id = $1 AND plan_version = $2', [
        runId,
        planVersion,
      ]);
      for (const s of steps) {
        await client.query(
          `INSERT INTO steps (id, run_id, plan_version, idx, title, kind, status, note, started_at, done_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            s.id,
            s.runId,
            s.planVersion,
            s.idx,
            s.title,
            s.kind,
            s.status,
            s.note,
            s.startedAt ?? null,
            s.doneAt ?? null,
          ],
        );
      }
      await client.query('COMMIT');
      return steps;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listSteps(runId: string, planVersion?: number): Promise<Step[]> {
    let pv = planVersion;
    if (pv === undefined) {
      const run = await this.getRun(runId);
      if (!run || run.planVersion === 0) return [];
      pv = run.planVersion;
    }
    const { rows } = await this.pool.query(
      'SELECT * FROM steps WHERE run_id = $1 AND plan_version = $2 ORDER BY idx ASC',
      [runId, pv],
    );
    return rows.map(mapStep);
  }

  async updateStep(s: Step): Promise<Step> {
    await this.pool.query(
      `UPDATE steps SET title=$2, status=$3, note=$4, started_at=$5, done_at=$6 WHERE id=$1`,
      [s.id, s.title, s.status, s.note, s.startedAt ?? null, s.doneAt ?? null],
    );
    return s;
  }

  async createSteer(s: Steer): Promise<Steer> {
    await this.pool.query(
      `INSERT INTO steers (id, run_id, author, pin_plan_version, urgency, op, payload, status, ack_note, created_at, acked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        s.id,
        s.runId,
        s.author,
        s.pinPlanVersion,
        s.urgency,
        s.op,
        JSON.stringify(s.payload),
        s.status,
        s.ackNote,
        s.createdAt,
        s.ackedAt ?? null,
      ],
    );
    return s;
  }

  async getSteer(id: string): Promise<Steer | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM steers WHERE id = $1', [id]);
    return rows[0] ? mapSteer(rows[0]) : undefined;
  }

  async listSteers(runId: string): Promise<Steer[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM steers WHERE run_id = $1 ORDER BY created_at ASC',
      [runId],
    );
    return rows.map(mapSteer);
  }

  async updateSteer(s: Steer): Promise<Steer> {
    await this.pool.query(
      `UPDATE steers SET status=$2, ack_note=$3, acked_at=$4 WHERE id=$1`,
      [s.id, s.status, s.ackNote, s.ackedAt ?? null],
    );
    return s;
  }

  async createArtifact(a: Artifact): Promise<Artifact> {
    await this.pool.query(
      `INSERT INTO artifacts (id, run_id, step_idx, kind, ref, label, content_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [a.id, a.runId, a.stepIdx, a.kind, a.ref, a.label, a.contentHash, a.createdAt],
    );
    return a;
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC',
      [runId],
    );
    return rows.map(mapArtifact);
  }

  async createCard(c: Card): Promise<Card> {
    await this.pool.query(
      `INSERT INTO cards (id, ws_id, run_id, asker, type, prompt, options, diff_preview, pin_kind, pin_value,
        assignee_kind, assignee_id, blocking, status, answer_option, answer_note, answered_by, decided_on_pin,
        replaced_by, expires_at, on_expire, default_option, dedupe_key, created_at, answered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        c.id,
        c.wsId,
        c.runId,
        c.asker,
        c.type,
        c.prompt,
        c.options,
        c.diffPreview,
        c.pin.kind,
        c.pin.value,
        c.assignee.kind,
        c.assignee.id,
        c.blocking,
        c.status,
        c.answerOption ?? null,
        c.answerNote ?? null,
        c.answeredBy ?? null,
        c.decidedOnPin ?? null,
        c.replacedBy ?? null,
        c.expiresAt ?? null,
        c.onExpire,
        c.defaultOption ?? null,
        c.dedupeKey ?? null,
        c.createdAt,
        c.answeredAt ?? null,
      ],
    );
    return c;
  }

  async getCard(id: string): Promise<Card | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM cards WHERE id = $1', [id]);
    return rows[0] ? mapCard(rows[0]) : undefined;
  }

  async listCards(wsId: string, filter?: { runId?: string; status?: string }): Promise<Card[]> {
    const conds = ['ws_id = $1'];
    const params: unknown[] = [wsId];
    if (filter?.runId) {
      params.push(filter.runId);
      conds.push(`run_id = $${params.length}`);
    }
    if (filter?.status) {
      params.push(filter.status);
      conds.push(`status = $${params.length}`);
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM cards WHERE ${conds.join(' AND ')} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(mapCard);
  }

  async updateCard(c: Card): Promise<Card> {
    await this.pool.query(
      `UPDATE cards SET status=$2, answer_option=$3, answer_note=$4, answered_by=$5, decided_on_pin=$6,
       replaced_by=$7, assignee_kind=$8, assignee_id=$9, answered_at=$10 WHERE id=$1`,
      [
        c.id,
        c.status,
        c.answerOption ?? null,
        c.answerNote ?? null,
        c.answeredBy ?? null,
        c.decidedOnPin ?? null,
        c.replacedBy ?? null,
        c.assignee.kind,
        c.assignee.id,
        c.answeredAt ?? null,
      ],
    );
    return c;
  }

  async createFlow(f: FlowTemplate): Promise<FlowTemplate> {
    await this.pool.query(
      `INSERT INTO flow_templates (id, ws_id, name, trigger_kind, trigger_spec, agent_id, sponsor_human, steps, gates, retry_max, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        f.id,
        f.wsId,
        f.name,
        f.triggerKind,
        f.triggerSpec,
        f.agentId,
        f.sponsorHuman,
        JSON.stringify(f.steps),
        JSON.stringify(f.gates),
        f.retryMax,
        f.createdAt,
      ],
    );
    return f;
  }

  async getFlow(id: string): Promise<FlowTemplate | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM flow_templates WHERE id = $1', [id]);
    return rows[0] ? mapFlow(rows[0]) : undefined;
  }

  async listFlows(wsId: string): Promise<FlowTemplate[]> {
    const { rows } = await this.pool.query(
      'SELECT * FROM flow_templates WHERE ws_id = $1 ORDER BY created_at ASC',
      [wsId],
    );
    return rows.map(mapFlow);
  }

  async createThreadMessage(m: ThreadMessage): Promise<ThreadMessage> {
    await this.pool.query(
      `INSERT INTO thread_messages (id, ws_id, scope_kind, scope_id, author, author_kind, body, steer_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [m.id, m.wsId, m.scopeKind, m.scopeId, m.author, m.authorKind, m.body, m.steerId ?? null, m.createdAt],
    );
    return m;
  }

  async listThreadMessages(wsId: string, scopeKind: string, scopeId: string): Promise<ThreadMessage[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM thread_messages WHERE ws_id = $1 AND scope_kind = $2 AND scope_id = $3 ORDER BY created_at ASC`,
      [wsId, scopeKind, scopeId],
    );
    return rows.map(mapThread);
  }

  async appendEvent(ev: Omit<RippleEvent, 'seq'>): Promise<RippleEvent> {
    const { rows } = await this.pool.query(
      `INSERT INTO events (ws_id, entity, entity_id, type, actor, epoch, payload, at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING seq`,
      [ev.wsId, ev.entity, ev.entityId, ev.type, ev.actor, ev.epoch ?? null, JSON.stringify(ev.payload), ev.at],
    );
    const full: RippleEvent = { ...ev, seq: Number(rows[0].seq) };
    await this.pool.query(`SELECT pg_notify('ripple_events', $1)`, [
      JSON.stringify({ wsId: ev.wsId, seq: full.seq }),
    ]);
    return full;
  }

  async listEvents(wsId: string, afterSeq = 0, limit = 100): Promise<RippleEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM events WHERE ws_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [wsId, afterSeq, limit],
    );
    return rows.map(mapEvent);
  }

  subscribe(wsId: string, listener: EventListener): () => void {
    let set = this.listeners.get(wsId);
    if (!set) {
      set = new Set();
      this.listeners.set(wsId, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  async getIdempotency(key: string): Promise<unknown | undefined> {
    const { rows } = await this.pool.query('SELECT response FROM idempotency_keys WHERE key = $1', [key]);
    return rows[0]?.response;
  }

  async saveIdempotency(key: string, wsId: string, response: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO idempotency_keys (key, ws_id, response) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING`,
      [key, wsId, JSON.stringify(response)],
    );
  }
}

// Row mappers
function mapToken(r: Record<string, any>): TokenRecord {
  return {
    tokenHash: r.token_hash,
    wsId: r.ws_id,
    actorId: r.actor_id,
    actorName: r.actor_name,
    kind: r.kind,
    sponsorHuman: r.sponsor_human ?? undefined,
    roles: r.roles ?? [],
    revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : undefined,
  };
}
function mapItem(r: Record<string, any>): Item {
  return {
    id: r.id,
    wsId: r.ws_id,
    title: r.title,
    body: r.body,
    priority: r.priority,
    version: r.version,
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function mapRun(r: Record<string, any>): Run {
  return {
    id: r.id,
    wsId: r.ws_id,
    itemId: r.item_id ?? undefined,
    flowTemplateId: r.flow_template_id ?? undefined,
    ownerAgent: r.owner_agent,
    sponsorHuman: r.sponsor_human,
    epoch: r.epoch,
    planVersion: r.plan_version,
    status: r.status,
    heartbeatAt: new Date(r.heartbeat_at).toISOString(),
    lastCheckpointStep: r.last_checkpoint_step,
    touches: r.touches ?? [],
    subjectPin: r.subject_pin_kind ? { kind: r.subject_pin_kind, value: r.subject_pin_value } : undefined,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}
function mapStep(r: Record<string, any>): Step {
  return {
    id: r.id,
    runId: r.run_id,
    planVersion: r.plan_version,
    idx: r.idx,
    title: r.title,
    kind: r.kind,
    status: r.status,
    note: r.note,
    startedAt: r.started_at ? new Date(r.started_at).toISOString() : undefined,
    doneAt: r.done_at ? new Date(r.done_at).toISOString() : undefined,
  };
}
function mapSteer(r: Record<string, any>): Steer {
  return {
    id: r.id,
    runId: r.run_id,
    author: r.author,
    pinPlanVersion: r.pin_plan_version,
    urgency: r.urgency,
    op: r.op,
    payload: r.payload ?? {},
    status: r.status,
    ackNote: r.ack_note,
    createdAt: new Date(r.created_at).toISOString(),
    ackedAt: r.acked_at ? new Date(r.acked_at).toISOString() : undefined,
  };
}
function mapArtifact(r: Record<string, any>): Artifact {
  return {
    id: r.id,
    runId: r.run_id,
    stepIdx: r.step_idx,
    kind: r.kind,
    ref: r.ref,
    label: r.label,
    contentHash: r.content_hash,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function mapCard(r: Record<string, any>): Card {
  return {
    id: r.id,
    wsId: r.ws_id,
    runId: r.run_id,
    asker: r.asker,
    type: r.type,
    prompt: r.prompt,
    options: r.options ?? [],
    diffPreview: r.diff_preview,
    pin: { kind: r.pin_kind, value: r.pin_value },
    assignee: { kind: r.assignee_kind, id: r.assignee_id },
    blocking: r.blocking,
    status: r.status,
    answerOption: r.answer_option ?? undefined,
    answerNote: r.answer_note ?? undefined,
    answeredBy: r.answered_by ?? undefined,
    decidedOnPin: r.decided_on_pin ?? undefined,
    replacedBy: r.replaced_by ?? undefined,
    expiresAt: r.expires_at ? new Date(r.expires_at).toISOString() : undefined,
    onExpire: r.on_expire,
    defaultOption: r.default_option ?? undefined,
    dedupeKey: r.dedupe_key ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    answeredAt: r.answered_at ? new Date(r.answered_at).toISOString() : undefined,
  };
}
function mapFlow(r: Record<string, any>): FlowTemplate {
  return {
    id: r.id,
    wsId: r.ws_id,
    name: r.name,
    triggerKind: r.trigger_kind,
    triggerSpec: r.trigger_spec,
    agentId: r.agent_id,
    sponsorHuman: r.sponsor_human,
    steps: r.steps ?? [],
    gates: r.gates ?? [],
    retryMax: r.retry_max,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function mapThread(r: Record<string, any>): ThreadMessage {
  return {
    id: r.id,
    wsId: r.ws_id,
    scopeKind: r.scope_kind,
    scopeId: r.scope_id,
    author: r.author,
    authorKind: r.author_kind,
    body: r.body,
    steerId: r.steer_id ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
  };
}
function mapEvent(r: Record<string, any>): RippleEvent {
  return {
    seq: Number(r.seq),
    wsId: r.ws_id,
    entity: r.entity,
    entityId: r.entity_id,
    type: r.type,
    actor: r.actor,
    epoch: r.epoch ?? undefined,
    payload: r.payload ?? {},
    at: new Date(r.at).toISOString(),
  };
}
