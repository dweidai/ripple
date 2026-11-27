import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AuthService } from '../src/auth.js';
import { RippleEngine } from '../src/engine.js';
import { PostgresStore } from '../src/store/postgres.js';

describe('PostgresStore schema & integration invariants', () => {
  it('validates 001_init.sql and PostgresStore token persistence columns & migrations', async () => {
    const sql = await fs.readFile(path.resolve('db/migrations/001_init.sql'), 'utf8');
    const pgTs = await fs.readFile(path.resolve('src/store/postgres.ts'), 'utf8');

    // Schema must include observability columns and user_accounts
    assert.match(sql, /\bactivity_state\s+TEXT\b/);
    assert.match(sql, /\berror_detail\s+TEXT\b/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS user_accounts\b/);

    // PostgresStore.init must include idempotent ALTER TABLE migrations for live DBs
    assert.match(pgTs, /ALTER TABLE tokens ADD COLUMN IF NOT EXISTS activity_state TEXT/);
    assert.match(pgTs, /ALTER TABLE tokens ADD COLUMN IF NOT EXISTS error_detail TEXT/);

    // saveToken INSERT column count must match VALUES ($1..$17)
    const insertMatch = pgTs.match(/INSERT INTO tokens \(([^)]+)\)\s+VALUES \(([^)]+)\)/);
    assert.ok(insertMatch, 'Could not find INSERT INTO tokens statement');
    const cols = insertMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    const placeholders = insertMatch[2].split(',').map((s) => s.trim()).filter(Boolean);
    assert.equal(cols.length, placeholders.length, `Column count (${cols.length}) != placeholder count (${placeholders.length})`);
    assert.ok(cols.includes('activity_state'));
    assert.ok(cols.includes('error_detail'));
  });

  const pgUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  it(
    'executes full PostgresStore init, token observability, thread message, and inbox round-trip',
    { skip: !pgUrl ? 'Set TEST_DATABASE_URL to run live Postgres integration test' : false },
    async () => {
      const store = new PostgresStore(pgUrl!);
      await store.init();
      const wsId = `ws_pg_${Date.now()}`;
      try {
        await store.ensureWorkspace(wsId, 'PG Integration');
        const auth = new AuthService(store);
        const engine = new RippleEngine(store);

        const human = await auth.mintToken({
          wsId,
          actorId: 'dweidai',
          actorName: 'David Dai',
          kind: 'human',
          roles: ['lead'],
        });
        const agy = await auth.mintToken({
          wsId,
          actorId: 'agy',
          actorName: 'Antigravity',
          kind: 'agent',
          roles: ['worker'],
        });

        // Persist & reload observability state + errorDetail in real Postgres
        const errP = await engine.updateProfile(agy.principal, {
          activityState: 'quota_exceeded',
          statusText: 'Paused',
          errorDetail: 'Groq 429 TPM limit',
        });
        assert.equal(errP.activityState, 'quota_exceeded');
        assert.equal(errP.errorDetail, 'Groq 429 TPM limit');
        assert.equal(errP.online, false);

        const reloaded = await store.getTokenByActor(wsId, 'agy');
        assert.equal(reloaded?.activityState, 'quota_exceeded');
        assert.equal(reloaded?.errorDetail, 'Groq 429 TPM limit');

        // Recover to working -> clears errorDetail in Postgres
        const recP = await engine.updateProfile(agy.principal, {
          activityState: 'working',
          statusText: 'Running Bench 2',
        });
        assert.equal(recP.activityState, 'working');
        assert.equal(recP.errorDetail, undefined);
        assert.equal(recP.online, true);

        // Post messages & verify delta inbox in Postgres
        const msg = await engine.postThreadMessage(human.principal, {
          scopeKind: 'workspace',
          scopeId: 'main',
          body: 'Hey @agy run tests',
        });
        const inbox = await engine.getInbox(agy.principal);
        assert.equal(inbox.unreadMentions.length, 1);
        assert.equal(inbox.unreadMentions[0].id, msg.message.id);
        assert.equal(inbox.dialogueHealth.maxAgentHops, null);
      } finally {
        await store.close();
      }
    },
  );
});
