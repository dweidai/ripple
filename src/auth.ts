import crypto from 'node:crypto';
import { Errors } from './errors.js';
import type { Store, TokenRecord } from './store/interface.js';
import type { Principal, PrincipalKind } from './types.js';

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateToken(prefix: string): string {
  return `rpl_${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
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
  constructor(private readonly store: Store) {}

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
  }): Promise<{ rawToken: string; principal: Principal }> {
    if (params.rotateExisting) {
      await this.store.revokeTokensByActor(params.wsId, params.actorId);
    }
    const rawToken =
      params.rawToken ??
      generateToken(params.actorId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'tok');
    const now = new Date().toISOString();
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
      rawToken,
    });
    return { rawToken, principal };
  }

  async authenticate(authHeader?: string | null): Promise<Principal> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw Errors.unauthorized();
    }
    const raw = authHeader.slice('Bearer '.length).trim();
    if (!raw) throw Errors.unauthorized();
    const rec = await this.store.getTokenByHash(hashToken(raw));
    if (!rec || rec.revokedAt) {
      throw Errors.unauthorized('Token invalid or revoked');
    }
    const now = new Date().toISOString();
    rec.lastSeenAt = now;
    rec.online = true;
    await this.store.updateTokenByActor(rec.wsId, rec.actorId, {
      lastSeenAt: now,
      online: true,
    });
    return recordToPrincipal(rec);
  }

  async touchPresence(wsId: string, actorId: string, statusText?: string): Promise<void> {
    const now = new Date().toISOString();
    await this.store.updateTokenByActor(wsId, actorId, {
      lastSeenAt: now,
      online: true,
      ...(statusText !== undefined ? { statusText } : {}),
    });
  }

  async revokeActor(wsId: string, actorId: string): Promise<void> {
    await this.store.revokeTokensByActor(wsId, actorId);
  }
}

