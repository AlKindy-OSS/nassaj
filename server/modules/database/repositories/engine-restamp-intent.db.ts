import crypto from 'node:crypto';

import type Database from 'better-sqlite3';

import { getConnection } from '@/modules/database/connection.js';
import { ENGINE_RESTAMP_INTENT_PREFIX } from '@/modules/database/repositories/app-config-reserved.js';

export { ENGINE_RESTAMP_INTENT_PREFIX };
export const MAX_ENGINE_RESTAMP_INTENTS = 1024;
export const MAX_ENGINE_RESTAMP_INTENT_BYTES = 8192;
export const MAX_ENGINE_RESTAMP_STARTUP_SCAN = 1025;
export const MAX_ENGINE_RESTAMP_STARTUP_ATTEMPTS = 64;
export const MAX_ENGINE_RESTAMP_STARTUP_INTENT_BYTES = 512 * 1024;

type Actor =
  | { kind: 'jwt'; userId: number; authorizationGeneration: number }
  | { kind: 'device'; userId: number; authorizationGeneration: number; deviceSessionId: string; slotId: string; deviceGeneration: number }
  | { kind: 'ck'; userId: number; authorizationGeneration: number; authenticationCredentialId: string };
type ProjectBinding =
  | { kind: 'project'; projectId: string; participantUserId: number; controllerUserId: number; authorityFenceSha256: string }
  | { kind: 'projectless'; workspaceId: string; authorityFenceSha256: string };
type Pin = { engine: string | null; source: string | null };
type Model = { changed: boolean; model: string | null };

export type EngineRestampIntent = {
  schema: 'nassaj-engine-restamp-intent/v1'; operationId: string; sessionId: string;
  ownerProcess: { uid: number; pid: number; bootId: string; startTicks: string };
  actor: Actor; projectBinding: ProjectBinding; fromPin: Pin;
  toPin: { engine: string; source: 'user_switch' }; fromModel: Model;
  toModel: { changed: true; model: string }; turnsExported: number;
  acknowledgedExport: boolean; phase: 'prepared' | 'target_observed' | 'compensating';
  revision: number; requestSha256: string; createdAt: string;
};

declare const engineRestampRecoveryCandidateBrand: unique symbol;
export type EngineRestampRecoveryCandidate = Readonly<{
  readonly [engineRestampRecoveryCandidateBrand]: true;
  intent: EngineRestampIntent;
  canonical: string;
  bytes: number;
}>;
type RecoveryCandidateBinding = Readonly<{
  db: Database.Database;
  sessionId: string;
  operationId: string;
  canonical: string;
  bytes: number;
}>;
const recoveryCandidates = new WeakMap<object, RecoveryCandidateBinding>();

export type EngineRestampRecoveryScan = Readonly<{
  candidates: readonly EngineRestampRecoveryCandidate[];
  observedRows: number;
  canonicalBytesRead: number;
  malformedRows: number;
  overflow: boolean;
  attemptLimitReached: boolean;
  byteLimitReached: boolean;
}>;

export class EngineRestampIntentError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'EngineRestampIntentError'; }
}

const fail = (code: string): never => { throw new EngineRestampIntentError(code); };
const bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
const exactKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const bounded = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && bytes(value) <= max;
const hash = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

export const engineRestampIntentKey = (sessionId: string): string => {
  if (!bounded(sessionId, 256)) fail('ENGINE_RESTAMP_SESSION_INVALID');
  return `${ENGINE_RESTAMP_INTENT_PREFIX}${hash(sessionId)}`;
};

function canonicalActor(actor: Actor): Actor {
  if (!actor || typeof actor !== 'object' || !positiveInteger(actor.userId) || !positiveInteger(actor.authorizationGeneration)) fail('ENGINE_RESTAMP_ACTOR_INVALID');
  if (actor.kind === 'jwt' && exactKeys(actor, ['kind', 'userId', 'authorizationGeneration'])) return { kind: 'jwt', userId: actor.userId, authorizationGeneration: actor.authorizationGeneration };
  if (actor.kind === 'device' && exactKeys(actor, ['kind', 'userId', 'authorizationGeneration', 'deviceSessionId', 'slotId', 'deviceGeneration'])
      && bounded(actor.deviceSessionId, 256) && bounded(actor.slotId, 256) && positiveInteger(actor.deviceGeneration)) {
    return { kind: 'device', userId: actor.userId, authorizationGeneration: actor.authorizationGeneration, deviceSessionId: actor.deviceSessionId, slotId: actor.slotId, deviceGeneration: actor.deviceGeneration };
  }
  if (actor.kind === 'ck' && exactKeys(actor, ['kind', 'userId', 'authorizationGeneration', 'authenticationCredentialId']) && bounded(actor.authenticationCredentialId, 256)) {
    return { kind: 'ck', userId: actor.userId, authorizationGeneration: actor.authorizationGeneration, authenticationCredentialId: actor.authenticationCredentialId };
  }
  return fail('ENGINE_RESTAMP_ACTOR_INVALID');
}

function canonicalBinding(binding: ProjectBinding): ProjectBinding {
  const digest = binding?.authorityFenceSha256;
  if (!/^[a-f0-9]{64}$/.test(digest ?? '')) fail('ENGINE_RESTAMP_BINDING_INVALID');
  if (binding.kind === 'project' && exactKeys(binding, ['kind', 'projectId', 'participantUserId', 'controllerUserId', 'authorityFenceSha256'])
      && bounded(binding.projectId, 256) && positiveInteger(binding.participantUserId) && positiveInteger(binding.controllerUserId)) {
    return { kind: 'project', projectId: binding.projectId, participantUserId: binding.participantUserId, controllerUserId: binding.controllerUserId, authorityFenceSha256: digest };
  }
  if (binding.kind === 'projectless' && exactKeys(binding, ['kind', 'workspaceId', 'authorityFenceSha256']) && bounded(binding.workspaceId, 256)) {
    return { kind: 'projectless', workspaceId: binding.workspaceId, authorityFenceSha256: digest };
  }
  return fail('ENGINE_RESTAMP_BINDING_INVALID');
}

function canonicalRequest(intent: EngineRestampIntent): string {
  return JSON.stringify({ schema: 'nassaj-engine-restamp-request/v1', sessionId: intent.sessionId,
    actor: canonicalActor(intent.actor), projectBinding: canonicalBinding(intent.projectBinding),
    fromPin: intent.fromPin, toPin: intent.toPin, fromModel: intent.fromModel,
    toModel: intent.toModel, turnsExported: intent.turnsExported,
    acknowledgedExport: intent.acknowledgedExport });
}

export const canonicalizeEngineRestampIntent = (value: EngineRestampIntent): string => {
  const keys = ['schema','operationId','sessionId','ownerProcess','actor','projectBinding','fromPin','toPin','fromModel','toModel','turnsExported','acknowledgedExport','phase','revision','requestSha256','createdAt'];
  if (!value || typeof value !== 'object' || !exactKeys(value, keys) || value.schema !== 'nassaj-engine-restamp-intent/v1'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.operationId)
      || !bounded(value.sessionId, 256)
      || !value.ownerProcess || !exactKeys(value.ownerProcess, ['uid','pid','bootId','startTicks'])
      || !nonNegativeInteger(value.ownerProcess.uid) || !positiveInteger(value.ownerProcess.pid) || !bounded(value.ownerProcess.bootId, 128)
      || !bounded(value.ownerProcess.startTicks, 32) || !/^\d+$/.test(value.ownerProcess.startTicks)
      || BigInt(value.ownerProcess.startTicks) <= 0n
      || !value.fromPin || !exactKeys(value.fromPin, ['engine','source']) || (value.fromPin.engine !== null && !bounded(value.fromPin.engine, 128)) || (value.fromPin.source !== null && !bounded(value.fromPin.source, 64))
      || !value.toPin || !exactKeys(value.toPin, ['engine','source']) || !bounded(value.toPin.engine, 128) || value.toPin.source !== 'user_switch'
      || !value.fromModel || !exactKeys(value.fromModel, ['changed','model']) || typeof value.fromModel.changed !== 'boolean' || (value.fromModel.model !== null && !bounded(value.fromModel.model, 512))
      || !value.toModel || !exactKeys(value.toModel, ['changed','model']) || value.toModel.changed !== true || !bounded(value.toModel.model, 512)
      || !nonNegativeInteger(value.turnsExported) || typeof value.acknowledgedExport !== 'boolean' || (value.turnsExported > 0 && value.acknowledgedExport !== true)
      || !['prepared','target_observed','compensating'].includes(value.phase) || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !/^[a-f0-9]{64}$/.test(value.requestSha256) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt)) fail('ENGINE_RESTAMP_INTENT_INVALID');
  const canonical = JSON.stringify({ schema: value.schema, operationId: value.operationId, sessionId: value.sessionId,
    ownerProcess: value.ownerProcess, actor: canonicalActor(value.actor), projectBinding: canonicalBinding(value.projectBinding),
    fromPin: value.fromPin, toPin: value.toPin, fromModel: value.fromModel, toModel: value.toModel,
    turnsExported: value.turnsExported, acknowledgedExport: value.acknowledgedExport, phase: value.phase,
    revision: value.revision, requestSha256: value.requestSha256, createdAt: value.createdAt });
  if (hash(canonicalRequest(value)) !== value.requestSha256 || bytes(canonical) > MAX_ENGINE_RESTAMP_INTENT_BYTES) fail('ENGINE_RESTAMP_INTENT_INVALID');
  return canonical;
};

export const engineRestampRequestSha256 = (intent: EngineRestampIntent): string => hash(canonicalRequest(intent));

export function createEngineRestampIntentRepository(db: Database.Database = getConnection()) {
  const read = (sessionId: string): { intent: EngineRestampIntent; canonical: string } | null => {
    const row = db.prepare(`SELECT typeof(value) AS value_type,
      length(CAST(value AS BLOB)) AS byte_length,
      CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ? THEN value ELSE NULL END AS value
      FROM app_config WHERE key = ?`).get(MAX_ENGINE_RESTAMP_INTENT_BYTES, engineRestampIntentKey(sessionId)) as
      { value_type: string; byte_length: number; value: string | null } | undefined;
    if (!row) return null;
    if (row.value_type !== 'text' || !nonNegativeInteger(row.byte_length)) return fail('ENGINE_RESTAMP_INTENT_MALFORMED');
    if (row.byte_length > MAX_ENGINE_RESTAMP_INTENT_BYTES) return fail('ENGINE_RESTAMP_INTENT_TOO_LARGE');
    if (typeof row.value !== 'string') return fail('ENGINE_RESTAMP_INTENT_MALFORMED');
    let intent: EngineRestampIntent; try { intent = JSON.parse(row.value) as EngineRestampIntent; } catch { return fail('ENGINE_RESTAMP_INTENT_MALFORMED'); }
    const canonical = canonicalizeEngineRestampIntent(intent);
    if (canonical !== row.value || intent.sessionId !== sessionId) fail('ENGINE_RESTAMP_INTENT_MALFORMED');
    return { intent, canonical };
  };
  return {
    read,
    has(sessionId: string): boolean { return read(sessionId) !== null; },
    prepare(intent: EngineRestampIntent): string {
      const canonical = canonicalizeEngineRestampIntent(intent);
      return db.transaction(() => {
        const count = (db.prepare('SELECT COUNT(*) AS count FROM app_config WHERE key >= ? AND key < ?').get(ENGINE_RESTAMP_INTENT_PREFIX, `${ENGINE_RESTAMP_INTENT_PREFIX}\uffff`) as { count: number }).count;
        if (count >= MAX_ENGINE_RESTAMP_INTENTS) return fail('ENGINE_RESTAMP_INTENT_LIMIT');
        const inserted = db.prepare('INSERT INTO app_config(key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING').run(engineRestampIntentKey(intent.sessionId), canonical);
        if (inserted.changes !== 1) return fail('ENGINE_RESTAMP_INTENT_CONFLICT');
        if (read(intent.sessionId)?.canonical !== canonical) return fail('ENGINE_RESTAMP_INTENT_READBACK');
        return canonical;
      }).immediate();
    },
    compareAndSet(sessionId: string, expectedCanonical: string, next: EngineRestampIntent): string {
      const canonical = canonicalizeEngineRestampIntent(next);
      if (next.sessionId !== sessionId) return fail('ENGINE_RESTAMP_INTENT_SESSION_MISMATCH');
      const result = db.prepare('UPDATE app_config SET value = ? WHERE key = ? AND value = ?').run(canonical, engineRestampIntentKey(sessionId), expectedCanonical);
      if (result.changes !== 1) return fail('ENGINE_RESTAMP_INTENT_CAS_MISMATCH');
      return canonical;
    },
    deleteExact(sessionId: string, expectedCanonical: string): void {
      const result = db.prepare('DELETE FROM app_config WHERE key = ? AND value = ?').run(engineRestampIntentKey(sessionId), expectedCanonical);
      if (result.changes !== 1) fail('ENGINE_RESTAMP_INTENT_CAS_MISMATCH');
    },
    /** Bounded metadata-first startup scan; it performs no recovery or authority decision. */
    scanRecoveryCandidates(): EngineRestampRecoveryScan {
      return db.transaction(() => {
        const metadata = db.prepare(`SELECT key, typeof(value) AS valueType,
          length(CAST(value AS BLOB)) AS byteLength FROM app_config
          WHERE key >= ? AND key < ? ORDER BY key LIMIT ?`).all(
          ENGINE_RESTAMP_INTENT_PREFIX, `${ENGINE_RESTAMP_INTENT_PREFIX}\uffff`,
          MAX_ENGINE_RESTAMP_STARTUP_SCAN,
        ) as Array<{ key: string; valueType: string; byteLength: number }>;
        if (metadata.length > MAX_ENGINE_RESTAMP_INTENTS) {
          return Object.freeze({ candidates: Object.freeze([]), observedRows: metadata.length,
            canonicalBytesRead: 0, malformedRows: 0, overflow: true,
            attemptLimitReached: true, byteLimitReached: false });
        }
        const selected = metadata.slice(0, MAX_ENGINE_RESTAMP_STARTUP_ATTEMPTS);
        const values = db.prepare(`SELECT key,
          CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ? THEN value ELSE NULL END AS value
          FROM app_config WHERE key >= ? AND key < ? ORDER BY key LIMIT ?`).all(
          MAX_ENGINE_RESTAMP_INTENT_BYTES, ENGINE_RESTAMP_INTENT_PREFIX,
          `${ENGINE_RESTAMP_INTENT_PREFIX}\uffff`, MAX_ENGINE_RESTAMP_STARTUP_ATTEMPTS,
        ) as Array<{ key: string; value: string | null }>;
        const candidates: EngineRestampRecoveryCandidate[] = [];
        let canonicalBytesRead = 0; let malformedRows = 0; let byteLimitReached = false;
        for (let index = 0; index < selected.length; index += 1) {
          const row = selected[index]; const value = values[index];
          if (!value || value.key !== row.key || row.valueType !== 'text'
              || !nonNegativeInteger(row.byteLength) || row.byteLength > MAX_ENGINE_RESTAMP_INTENT_BYTES
              || typeof value.value !== 'string') { malformedRows += 1; continue; }
          if (canonicalBytesRead + row.byteLength > MAX_ENGINE_RESTAMP_STARTUP_INTENT_BYTES) {
            byteLimitReached = true; break;
          }
          canonicalBytesRead += row.byteLength;
          try {
            const intent = JSON.parse(value.value) as EngineRestampIntent;
            const canonical = canonicalizeEngineRestampIntent(intent);
            if (canonical !== value.value || engineRestampIntentKey(intent.sessionId) !== row.key) {
              malformedRows += 1; continue;
            }
            const candidate = Object.freeze({ intent, canonical, bytes: row.byteLength }) as EngineRestampRecoveryCandidate;
            recoveryCandidates.set(candidate, Object.freeze({ db, sessionId: intent.sessionId,
              operationId: intent.operationId, canonical, bytes: row.byteLength }));
            candidates.push(candidate);
          } catch { malformedRows += 1; }
        }
        return Object.freeze({ candidates: Object.freeze(candidates), observedRows: metadata.length,
          canonicalBytesRead, malformedRows, overflow: false,
          attemptLimitReached: metadata.length > MAX_ENGINE_RESTAMP_STARTUP_ATTEMPTS,
          byteLimitReached });
      }).immediate();
    },
    /** Revalidates one exact object emitted by this process's bounded recovery scan. */
    validateRecoveryCandidate(candidate: unknown): Readonly<{
      intent: EngineRestampIntent; canonical: string;
    }> | null {
      if (!candidate || typeof candidate !== 'object') return null;
      const binding = recoveryCandidates.get(candidate);
      if (!binding || binding.db !== db) return null;
      const current = read(binding.sessionId);
      if (!current || current.canonical !== binding.canonical
          || current.intent.operationId !== binding.operationId) return null;
      const duplicates = db.prepare(`SELECT COUNT(*) AS count FROM app_config
        WHERE key >= ? AND key < ? AND CASE
          WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= ? AND json_valid(value)
          THEN json_extract(value, '$.sessionId') ELSE NULL END = ?`).get(
        ENGINE_RESTAMP_INTENT_PREFIX, `${ENGINE_RESTAMP_INTENT_PREFIX}\uffff`,
        MAX_ENGINE_RESTAMP_INTENT_BYTES, binding.sessionId,
      ) as { count: number };
      return duplicates.count === 1 ? Object.freeze(current) : null;
    },
  };
}

export const engineRestampIntentsDb = {
  read: (sessionId: string) => createEngineRestampIntentRepository().read(sessionId),
  has: (sessionId: string) => createEngineRestampIntentRepository().has(sessionId),
  prepare: (intent: EngineRestampIntent) => createEngineRestampIntentRepository().prepare(intent),
  compareAndSet: (sessionId: string, expected: string, next: EngineRestampIntent) =>
    createEngineRestampIntentRepository().compareAndSet(sessionId, expected, next),
  deleteExact: (sessionId: string, expected: string) =>
    createEngineRestampIntentRepository().deleteExact(sessionId, expected),
  scanRecoveryCandidates: () => createEngineRestampIntentRepository().scanRecoveryCandidates(),
  validateRecoveryCandidate: (candidate: unknown) =>
    createEngineRestampIntentRepository().validateRecoveryCandidate(candidate),
};
