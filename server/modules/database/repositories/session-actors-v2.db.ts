import { isDeepStrictEqual } from 'node:util';

import type { Database } from 'better-sqlite3';

import { assertActorSnapshot, type ActorRow, type ActorSnapshot, type ActorObservation } from './session-actors-v2.validation.js';

/** Explicit connection only. Callers own source proof and C3 authorization before every operation. */
export class SessionActorsV2Repository {
  constructor(private readonly db: Database) {}

  /** Capture exact cache revision after caller authorization, before any asynchronous parse. */
  captureRevision(sessionId: string): number | null {
    assertSession(sessionId);
    const row = this.db.prepare('SELECT cache_revision FROM session_actors_meta_v2 WHERE session_id=?').get(sessionId) as { cache_revision: number } | undefined;
    if (row && (!Number.isSafeInteger(row.cache_revision) || row.cache_revision < 1)) throw new Error('session_actor_revision_invalid');
    return row?.cache_revision ?? null;
  }

  /** Return only a validated snapshot matching a freshly proved source and compiled parser contract. */
  readMatching(sessionId: string, sourceRevision: string, parserContract: string): ActorSnapshot | null {
    assertSession(sessionId);
    if (typeof sourceRevision !== 'string' || typeof parserContract !== 'string' || !/^[a-f0-9]{64}$/.test(sourceRevision) || !/^[a-f0-9]{64}$/.test(parserContract)) return null;
    return this.db.transaction(() => {
      const snapshot = this.readSnapshot(sessionId);
      return snapshot?.source_revision_sha256 === sourceRevision && snapshot.parser_contract_sha256 === parserContract ? snapshot : null;
    })();
  }

  /** Atomic exact CAS; caller must reverify sources and disclosure fence after return. */
  publish(candidate: ActorSnapshot, expectedRevision: number | null): 'published' | 'lost_race' | 'session_missing' | 'rejected' {
    let snapshot: ActorSnapshot;
    try {
      snapshot = structuredClone(candidate);
      assertActorSnapshot(snapshot);
      for (const actor of snapshot.actors) { actor.observations.forEach(Object.freeze); Object.freeze(actor.observations); Object.freeze(actor); }
      Object.freeze(snapshot.actors); Object.freeze(snapshot);
      if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= Number.MAX_SAFE_INTEGER)) return 'rejected';
      if (snapshot.cache_revision !== (expectedRevision ?? 0) + 1 || this.db.inTransaction) return 'rejected';
    } catch { return 'rejected'; }
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM sessions WHERE session_id=?').get(snapshot.session_id)) return 'session_missing' as const;
      if (this.captureRevision(snapshot.session_id) !== expectedRevision) return 'lost_race' as const;
      this.replaceRows(snapshot);
      // Validate SQL readback in the same transaction; a failure rolls back the publication.
      const written = this.readSnapshot(snapshot.session_id);
      if (!written || !isDeepStrictEqual(written, snapshot)) throw new Error('session_actor_readback_invalid');
      return 'published' as const;
    }).immediate();
  }

  private readSnapshot(sessionId: string): ActorSnapshot | null {
    const meta = this.db.prepare('SELECT * FROM session_actors_meta_v2 WHERE session_id=?').get(sessionId) as Omit<ActorSnapshot, 'actors'> | undefined;
    if (!meta) return null;
    const rows = this.db.prepare('SELECT * FROM session_actors_v2 WHERE session_id=? ORDER BY sort_order,actor_id').all(sessionId) as Array<ActorRow & { session_id: string }>;
    const models = this.db.prepare('SELECT * FROM session_actor_model_observations_v2 WHERE session_id=? ORDER BY actor_id,observation_ordinal').all(sessionId) as Array<ActorObservation & { actor_id: string; session_id: string }>;
    const actors = rows.map(({ session_id: _session, ...actor }) => ({ ...actor,
      observations: models.filter(model => model.actor_id === actor.actor_id).map(({ session_id: _s, actor_id: _a, ...model }) => model) }));
    const snapshot = { ...meta, actors };
    try {
      assertActorSnapshot(snapshot);
      if (models.length !== actors.reduce((count, actor) => count + actor.observations.length, 0)) return null;
      return snapshot;
    } catch { return null; }
  }

  private replaceRows(snapshot: ActorSnapshot): void {
    const session = snapshot.session_id;
    this.db.prepare('DELETE FROM session_actor_model_observations_v2 WHERE session_id=?').run(session);
    this.db.prepare('DELETE FROM session_actors_v2 WHERE session_id=?').run(session);
    const actorInsert = this.db.prepare('INSERT INTO session_actors_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const modelInsert = this.db.prepare('INSERT INTO session_actor_model_observations_v2 VALUES (?,?,?,?,?,?,?)');
    for (const actor of snapshot.actors) {
      actorInsert.run(session, actor.actor_id, actor.launch_link_sha256, actor.launch_evidence_sha256,
        actor.requested_role, actor.requested_model, actor.requested_reasoning_effort, actor.observed_role,
        actor.evidence_status, actor.evidence_code, actor.role_mismatch, actor.model_mismatch, actor.sort_order);
      for (const model of actor.observations) modelInsert.run(session, actor.actor_id, model.observation_ordinal,
        model.source_record_ordinal, model.turn_id_sha256, model.model, model.evidence_sha256);
    }
    this.db.prepare(`INSERT INTO session_actors_meta_v2 VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
      source_revision_sha256=excluded.source_revision_sha256,parser_contract_sha256=excluded.parser_contract_sha256,
      cache_revision=excluded.cache_revision,actors_status=excluded.actors_status,status_reason=excluded.status_reason,
      actor_count=excluded.actor_count,parsed_at_ms=excluded.parsed_at_ms`).run(session, snapshot.source_revision_sha256,
    snapshot.parser_contract_sha256, snapshot.cache_revision, snapshot.actors_status, snapshot.status_reason, snapshot.actor_count, snapshot.parsed_at_ms);
  }
}
function assertSession(value: string): void {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 256 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) || value.normalize('NFC') !== value) throw new Error('session_actor_session_invalid');
}
