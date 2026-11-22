import crypto from 'node:crypto';
import { Errors } from './errors.js';
import type { Store } from './store/interface.js';
import type { Principal, PrincipalKind } from './types.js';

export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function generateToken(prefix: string): string {
  return `rpl_${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
}

export class AuthService {
  constructor(private readonly store: Store) {}

  async mintToken(params: {
    wsId: string;
    actorId: string;
    actorName: string;
    kind: PrincipalKind;
    sponsorHuman?: string;
    roles?: string[];
    rawToken?: string;
  }): Promise<{ rawToken: string; principal: Principal }> {
    const rawToken = params.rawToken ?? generateToken(params.actorId.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'tok');
    const principal: Principal = {
      wsId: params.wsId,
      actorId: params.actorId,
      actorName: params.actorName,
      kind: params.kind,
      sponsorHuman: params.sponsorHuman,
      roles: params.roles ?? (params.kind === 'human' ? ['lead', 'reviewer'] : []),
    };
    await this.store.saveToken({
      ...principal,
      tokenHash: hashToken(rawToken),
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
    return {
      wsId: rec.wsId,
      actorId: rec.actorId,
      actorName: rec.actorName,
      kind: rec.kind,
      sponsorHuman: rec.sponsorHuman,
      roles: rec.roles,
    };
  }
}
