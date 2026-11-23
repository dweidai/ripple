import crypto from 'node:crypto';
import { Errors } from './errors.js';
import type { Store, TokenRecord } from './store/interface.js';
import type { Principal, PrincipalKind } from './types.js';

export const VALID_ACTOR_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const DEFAULT_HUMAN_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_AGENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRESENCE_DEBOUNCE_MS = 30_000;

export function assertValidActorId(actorId: string, field = 'actorId'): void {
  if (typeof actorId !== 'string' || !VALID_ACTOR_ID_RE.test(actorId)) {
    throw Errors.badRequest(
      `Invalid ${field}: must match ${VALID_ACTOR_ID_RE.source}`,
    );
  }
}

export function assertHuman(p: Principal, action: string): void {
  if (p.kind !== 'human') {
    throw Errors.forbidden(`Only humans may ${action}`);
  }
}

export function assertLead(p: Principal, action: string): void {
  if (p.kind !== 'human' || !p.roles.includes('lead')) {
    throw Errors.forbidden(`Only workspace leads may ${action}`);
  }
}

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateToken(prefix: string): string {
  return `rpl_${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function recordToPrincipal(rec: TokenRecord): Principal {
  const now = Date.now();
  const lastSeenMs = rec.lastSeenAt ? new Date(rec.lastSeenAt).getTime() : 0;
  const isOnline = rec.online ?? (lastSeenMs > 0 && now - lastSeenMs < 5 * 60 * 1000);
  return {
    wsId: rec.wsId,
    actorId: rec.actorId,
    actorName: rec.actorName,
    kind: rec.kind,
    sponsorHuman: rec.sponsorHuman,
    parentAgentId: rec.parentAgentId,
    roles: rec.roles,
    avatarColor: rec.avatarColor,
    bio: rec.bio,
    capabilities: rec.capabilities,
    lastSeenAt: rec.lastSeenAt,
    statusText: rec.statusText,
    online: isOnline,
  };
}

export class AuthService {
  private lastPresenceWrite = new Map<string, number>();
  private revokeListeners = new Set<(wsId: string, actorId: string) => void>();

  constructor(private readonly store: Store) {}

  onActorRevoked(fn: (wsId: string, actorId: string) => void): () => void {
    this.revokeListeners.add(fn);
    return () => {
      this.revokeListeners.delete(fn);
    };
  }

  private notifyActorRevoked(wsId: string, actorId: string): void {
    for (const fn of [...this.revokeListeners]) {
      try {
        fn(wsId, actorId);
      } catch {
        // ignore listener errors
      }
    }
  }

  async mintToken(params: {
    wsId: string;
    actorId: string;
    actorName: string;
    kind: PrincipalKind;
    sponsorHuman?: string;
    parentAgentId?: string;
    roles?: string[];
    avatarColor?: string;
    bio?: string;
    capabilities?: string[];
    statusText?: string;
    rawToken?: string;
    rotateExisting?: boolean;
    expiresAt?: string;
    ttlMs?: number;
  }): Promise<{ rawToken: string; principal: Principal }> {
    assertValidActorId(params.actorId, 'actorId');
    if (params.rotateExisting) {
      await this.store.revokeTokensByActor(params.wsId, params.actorId);
      this.lastPresenceWrite.delete(`${params.wsId}:${params.actorId}`);
      this.notifyActorRevoked(params.wsId, params.actorId);
    }
    const rawToken =
      params.rawToken ??
      generateToken(params.actorId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'tok');
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();

    let expiresAt = params.expiresAt;
    if (expiresAt === undefined) {
      const envTtl = process.env.RIPPLE_TOKEN_TTL_MS ? Number(process.env.RIPPLE_TOKEN_TTL_MS) : undefined;
      const defaultTtl = params.kind === 'human' ? DEFAULT_HUMAN_TOKEN_TTL_MS : DEFAULT_AGENT_TOKEN_TTL_MS;
      const ttlMs =
        params.ttlMs ??
        (envTtl !== undefined && Number.isFinite(envTtl) && envTtl > 0 ? envTtl : defaultTtl);
      expiresAt = new Date(nowMs + ttlMs).toISOString();
    }

    const principal: Principal = {
      wsId: params.wsId,
      actorId: params.actorId,
      actorName: params.actorName,
      kind: params.kind,
      sponsorHuman: params.sponsorHuman,
      parentAgentId: params.parentAgentId,
      roles: params.roles ?? (params.kind === 'human' ? ['lead', 'reviewer'] : []),
      avatarColor: params.avatarColor,
      bio: params.bio,
      capabilities: params.capabilities,
      lastSeenAt: now,
      statusText: params.statusText ?? (params.kind === 'human' ? 'Workspace Lead' : 'Ready'),
      online: true,
    };
    await this.store.saveToken({
      ...principal,
      tokenHash: hashToken(rawToken),
      expiresAt,
    });
    return { rawToken, principal };
  }

  async authenticateByHash(tokenHash: string): Promise<Principal> {
    if (!tokenHash) throw Errors.unauthorized();
    const rec = await this.store.getTokenByHash(tokenHash);
    if (!rec || rec.revokedAt) {
      throw Errors.unauthorized('Token invalid or revoked');
    }
    if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= Date.now()) {
      throw Errors.unauthorized('Token expired');
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    rec.lastSeenAt = now;
    rec.online = true;

    const presenceKey = `${rec.wsId}:${rec.actorId}`;
    const lastWrite = this.lastPresenceWrite.get(presenceKey) ?? 0;
    if (nowMs - lastWrite >= PRESENCE_DEBOUNCE_MS) {
      this.lastPresenceWrite.set(presenceKey, nowMs);
      await this.store.updateTokenByActor(rec.wsId, rec.actorId, {
        lastSeenAt: now,
        online: true,
      });
    }
    return recordToPrincipal(rec);
  }

  async authenticate(authHeader?: string | null): Promise<Principal> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw Errors.unauthorized();
    }
    const raw = authHeader.slice('Bearer '.length).trim();
    if (!raw) throw Errors.unauthorized();
    return this.authenticateByHash(hashToken(raw));
  }

  async touchPresence(wsId: string, actorId: string, statusText?: string): Promise<void> {
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    this.lastPresenceWrite.set(`${wsId}:${actorId}`, nowMs);
    await this.store.updateTokenByActor(wsId, actorId, {
      lastSeenAt: now,
      online: true,
      ...(statusText !== undefined ? { statusText } : {}),
    });
  }

  async revokeActor(wsId: string, actorId: string): Promise<void> {
    await this.store.revokeTokensByActor(wsId, actorId);
    this.lastPresenceWrite.delete(`${wsId}:${actorId}`);
    this.notifyActorRevoked(wsId, actorId);
  }
}

