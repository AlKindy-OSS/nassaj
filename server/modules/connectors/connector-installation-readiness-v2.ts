/** M5 origin/readiness substrate; production composition exposes only its inert catalog/setup plane. */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { Database } from 'better-sqlite3';
import express from 'express';

import {
  CONNECTOR_OAUTH_CALLBACK_PATH,
} from './connector-auth-security.js';
import type { SqliteConnectorPolicyV2Store } from './connector-policy-v2-store.js';

export const CONNECTOR_INSTALLATION_READINESS_V2_ENABLED = false as const;
export const CONNECTOR_INSTALLATION_READINESS_V2_CUTOVER_EXIT_CONDITIONS = Object.freeze([
  'add_policy_v2_and_m5_origin_tables_to_the_canonical_M2_fenced_inventory',
  'mount_routes_only_after_the_M2_writer_authority_and_policy_state_are_ready',
  'disable_first_origin_bootstrap_after_pre_activation_setup',
]);

export const CONNECTOR_INSTALLATION_READINESS_V2_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS connector_m5_installation_origin (
  installation_id TEXT PRIMARY KEY,
  canonical_origin TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS connector_m5_profile_readiness (
  installation_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  ready INTEGER NOT NULL CHECK (ready IN (0,1)),
  valid_origin_revision INTEGER,
  PRIMARY KEY (installation_id,provider_id)
);
`;

export type ConnectorCanonicalOrigin = Readonly<{
  installationId: string;
  canonicalOrigin: string;
  callbackUrl: string;
  originRevision: number;
}>;

export type ConnectorReadinessState = 'connect_now' | 'connected' | 'owner_setup_required'
  | 'installation_origin_required' | 'coming_soon_uncertified' | 'temporarily_disabled'
  | 'migration_required' | 'saved_inactive';

export type ConnectorReadinessAction = 'connect_account' | 'configure_provider'
  | 'set_installation_origin' | 'review_migration' | 'remove_saved_credential';

export type ConnectorReadinessFact = Readonly<{
  installationId: string;
  providerId: string;
  serviceId: string;
  authMethod: 'dcr_pkce' | 'byo_app' | 'api_key';
  productionManifestActive: boolean;
  featureEnabled: boolean;
  temporarilyDisabled: boolean;
  migrationRequired: boolean;
  savedInactive: boolean;
  operationalConnected: boolean;
}>;

export type ConnectorReadinessServiceDto = Readonly<{
  providerId: string;
  serviceId: string;
  authMethod: ConnectorReadinessFact['authMethod'];
  state: ConnectorReadinessState;
  actions: readonly ConnectorReadinessAction[];
}>;

export type ConnectorReadinessCatalogDto = Readonly<{
  schemaVersion: 2;
  origin: Readonly<{
    configured: boolean;
    originRevision: number | null;
    canonicalOrigin: string | null;
    callbackUrl: string | null;
  }>;
  services: readonly ConnectorReadinessServiceDto[];
}>;

type OriginRow = { installationId: string; canonicalOrigin: string };

const ownerAuthorities = new WeakMap<ConnectorInstallationOwnerCapability, ConnectorOwnerSetupAuthority>();
const consumedOwnerAuthorities = new WeakSet<ConnectorInstallationOwnerCapability>();

type ConnectorOwnerSetupAuthority = Readonly<{
  installationId: string;
  userId: number;
  role: 'owner';
  recentAuth: true;
  csrfVerified: true;
  requestOrigin: string;
  intent: 'set_installation_origin';
  issuedAtMs: number;
  expiresAtMs: number;
}>;

/** Opaque fixture representing an upstream owner, recent-auth, and CSRF decision. */
export class ConnectorInstallationOwnerCapability {
  private constructor() { Object.freeze(this); }
  static fixture(authority: ConnectorOwnerSetupAuthority): ConnectorInstallationOwnerCapability {
    const capability = new ConnectorInstallationOwnerCapability();
    ownerAuthorities.set(capability, Object.freeze({ ...authority }));
    return capability;
  }
  toJSON(): never { throw new Error('connector_installation_owner_capability_not_serializable'); }
}

const idValid = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
const loopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/** Validates and returns an exact canonical origin; it never consumes request headers. */
export const canonicalizeConnectorInstallationOrigin = (
  raw: string,
  allowLoopbackDevelopment = false,
): string => {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.trim() !== raw) {
    throw new Error('connector_installation_origin_invalid');
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error('connector_installation_origin_invalid'); }
  const onlyOrigin = !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && parsed.pathname === '/' && Boolean(parsed.hostname) && raw === parsed.origin;
  const secure = parsed.protocol === 'https:';
  const explicitDevelopment = allowLoopbackDevelopment && parsed.protocol === 'http:' && loopback(parsed.hostname);
  if (!onlyOrigin || (!secure && !explicitDevelopment)) {
    throw new Error('connector_installation_origin_invalid');
  }
  return parsed.origin;
};

/** Durable installation-owned origin store used only by the inert M5 service. */
export class ConnectorInstallationOriginV2Store {
  readonly #database: Database;
  readonly #policyAuthority: SqliteConnectorPolicyV2Store;
  readonly #allowLoopbackDevelopment: boolean;
  readonly #allowInitialOriginBootstrap: boolean;

  constructor(database: Database, policyAuthority: SqliteConnectorPolicyV2Store, options: Readonly<{
    allowLoopbackDevelopment?: boolean;
    allowInitialOriginBootstrap?: boolean;
    initializeSchema?: boolean;
  }> = {}) {
    this.#database = database; this.#policyAuthority = policyAuthority;
    this.#allowLoopbackDevelopment = options.allowLoopbackDevelopment === true;
    this.#allowInitialOriginBootstrap = options.allowInitialOriginBootstrap === true;
    if (options.initializeSchema !== false) database.exec(CONNECTOR_INSTALLATION_READINESS_V2_SCHEMA_SQL);
  }

  /** Applies this installation's server-owned loopback policy. */
  canonicalizeOrigin(raw: string): string {
    return canonicalizeConnectorInstallationOrigin(raw, this.#allowLoopbackDevelopment);
  }

  /** Returns the exact persisted origin for one installation. */
  read(installationId: string): ConnectorCanonicalOrigin | null {
    if (!idValid(installationId)) throw new Error('connector_installation_id_invalid');
    try {
      const policy = this.#policyAuthority.readCurrent(installationId);
      const row = this.#database.prepare(`SELECT installation_id AS installationId,
        canonical_origin AS canonicalOrigin FROM connector_m5_installation_origin
        WHERE installation_id = ?`).get(installationId) as OriginRow | undefined;
      if (!row) return null;
      const canonicalOrigin = canonicalizeConnectorInstallationOrigin(
        row.canonicalOrigin, this.#allowLoopbackDevelopment,
      );
      if (canonicalOrigin !== row.canonicalOrigin || !Number.isSafeInteger(policy.originRevision)
        || policy.originRevision < 1) throw new Error('connector_installation_origin_tampered');
      return Object.freeze({ ...row, canonicalOrigin, originRevision: policy.originRevision,
        callbackUrl: `${canonicalOrigin}${CONNECTOR_OAUTH_CALLBACK_PATH}` });
    } catch { throw new Error('connector_installation_readiness_unavailable'); }
  }

  /** Records secret-free setup readiness for an inert provider profile. */
  recordProfileReadiness(installationId: string, providerId: string, ready: boolean): void {
    if (!idValid(installationId) || !idValid(providerId)) throw new Error('connector_profile_readiness_invalid');
    const revision = this.read(installationId)?.originRevision ?? null;
    this.#database.prepare(`INSERT INTO connector_m5_profile_readiness
      (installation_id,provider_id,ready,valid_origin_revision) VALUES (?,?,?,?)
      ON CONFLICT(installation_id,provider_id) DO UPDATE SET ready=excluded.ready,
      valid_origin_revision=excluded.valid_origin_revision`).run(installationId, providerId, ready ? 1 : 0, revision);
  }

  /** True only when readiness was recorded against the current origin revision. */
  profileReady(installationId: string, providerId: string): boolean {
    const origin = this.read(installationId);
    const row = this.#database.prepare(`SELECT ready, valid_origin_revision AS validOriginRevision
      FROM connector_m5_profile_readiness WHERE installation_id = ? AND provider_id = ?`)
      .get(installationId, providerId) as { ready: number; validOriginRevision: number | null } | undefined;
    return Boolean(origin && row?.ready === 1 && row.validOriginRevision === origin.originRevision);
  }

  /** Atomically changes origin after all exact owner and pending-transaction gates pass. */
  setOrigin(input: Readonly<{
    installationId: string;
    userId: number;
    proposedOrigin: string;
    expectedOriginRevision: number;
    authority: ConnectorInstallationOwnerCapability;
    nowMs: number;
  }>): ConnectorCanonicalOrigin {
    const origin = this.canonicalizeOrigin(input.proposedOrigin);
    this.#consumeAuthority(input, origin);
    if (!Number.isSafeInteger(input.expectedOriginRevision) || input.expectedOriginRevision < 0
      || !Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error('connector_origin_write_invalid');
    this.#setOriginThroughPolicy(input, origin);
    return this.read(input.installationId)!;
  }

  #consumeAuthority(input: Readonly<{ installationId: string; userId: number; nowMs: number;
    authority: ConnectorInstallationOwnerCapability }>, proposedOrigin: string): void {
    const authority = ownerAuthorities.get(input.authority);
    if (!authority || consumedOwnerAuthorities.has(input.authority)) throw new Error('connector_origin_authority_invalid');
    consumedOwnerAuthorities.add(input.authority);
    const current = this.read(input.installationId);
    const expectedRequestOrigin = current?.canonicalOrigin ?? proposedOrigin;
    if (authority.installationId !== input.installationId || authority.userId !== input.userId
      || authority.role !== 'owner' || !authority.recentAuth || !authority.csrfVerified
      || authority.intent !== 'set_installation_origin' || authority.requestOrigin !== expectedRequestOrigin
      || authority.issuedAtMs > input.nowMs || authority.expiresAtMs <= input.nowMs) {
      throw new Error('connector_origin_authority_invalid');
    }
  }

  #setOriginThroughPolicy(input: Readonly<{ installationId: string; proposedOrigin: string;
    expectedOriginRevision: number; nowMs: number }>, origin: string): void {
    const current = this.read(input.installationId);
    if (!current) { this.#bindInitialOrigin(input, origin); return; }
    if (current.originRevision !== input.expectedOriginRevision) throw new Error('connector_origin_revision_conflict');
    if (current.canonicalOrigin === origin) return;
    this.#policyAuthority.advanceOriginRevision({ installationId: input.installationId,
      expectedOriginRevision: input.expectedOriginRevision, nowMs: input.nowMs,
      persistOrigin: () => this.#persistOrigin(input.installationId, origin, input.nowMs) });
  }

  #bindInitialOrigin(input: Readonly<{ installationId: string; expectedOriginRevision: number;
    nowMs: number }>, origin: string): void {
    if (!this.#allowInitialOriginBootstrap || input.expectedOriginRevision !== 0) {
      throw new Error('connector_origin_bootstrap_unsafe');
    }
    this.#policyAuthority.bindInitialOrigin({ installationId: input.installationId, nowMs: input.nowMs,
      persistOrigin: () => this.#persistOrigin(input.installationId, origin, input.nowMs) });
  }

  #persistOrigin(installationId: string, origin: string, nowMs: number): void {
    this.#database.prepare(`INSERT INTO connector_m5_installation_origin
      (installation_id,canonical_origin,updated_at_ms) VALUES (?,?,?)
      ON CONFLICT(installation_id) DO UPDATE SET canonical_origin=excluded.canonical_origin,
      updated_at_ms=excluded.updated_at_ms`).run(installationId, origin, nowMs);
    this.#database.prepare(`UPDATE connector_m5_profile_readiness SET valid_origin_revision = NULL
      WHERE installation_id = ?`).run(installationId);
  }
}

const stateFor = (fact: ConnectorReadinessFact, originConfigured: boolean,
  profileReady: boolean): ConnectorReadinessState => {
  if (fact.temporarilyDisabled) return 'temporarily_disabled';
  if (fact.migrationRequired) return 'migration_required';
  if (fact.savedInactive) return 'saved_inactive';
  if (fact.authMethod !== 'api_key' && !originConfigured) return 'installation_origin_required';
  if (fact.authMethod === 'byo_app' && !profileReady) return 'owner_setup_required';
  if (!fact.productionManifestActive || !fact.featureEnabled) return 'coming_soon_uncertified';
  if (fact.operationalConnected) return 'connected';
  return 'connect_now';
};

const actionsFor = (state: ConnectorReadinessState, owner: boolean): readonly ConnectorReadinessAction[] => {
  if (state === 'connect_now' || state === 'connected') return Object.freeze(['connect_account']);
  if (state === 'saved_inactive') return Object.freeze(['remove_saved_credential']);
  if (!owner) return Object.freeze([]);
  if (state === 'owner_setup_required') return Object.freeze(['configure_provider']);
  if (state === 'installation_origin_required') return Object.freeze(['set_installation_origin']);
  if (state === 'migration_required') return Object.freeze(['review_migration']);
  return Object.freeze([]);
};

/** Builds a secret-free GET projection; origin and API-key configuration are independent. */
export const connectorInstallationReadinessCatalog = (input: Readonly<{
  installationId: string;
  owner: boolean;
  store: ConnectorInstallationOriginV2Store;
  facts: readonly ConnectorReadinessFact[];
}>): ConnectorReadinessCatalogDto => {
  if (!idValid(input.installationId)) throw new Error('connector_installation_id_invalid');
  const origin = input.store.read(input.installationId);
  const seen = new Set<string>();
  for (const fact of input.facts) {
    const key = `${fact.providerId}\0${fact.serviceId}`;
    if (!validReadinessFact(fact) || fact.installationId !== input.installationId || seen.has(key)) {
      throw new Error('connector_readiness_catalog_invalid');
    }
    seen.add(key);
  }
  const services = input.facts.map(fact => {
    const state = stateFor(fact, origin !== null, input.store.profileReady(input.installationId, fact.providerId));
    return Object.freeze({ providerId: fact.providerId, serviceId: fact.serviceId,
      authMethod: fact.authMethod, state, actions: actionsFor(state, input.owner) });
  });
  return Object.freeze({ schemaVersion: 2 as const,
    origin: Object.freeze({ configured: origin !== null, originRevision: origin?.originRevision ?? null,
      canonicalOrigin: origin?.canonicalOrigin ?? null, callbackUrl: origin?.callbackUrl ?? null }),
    services: Object.freeze(services) });
};

const readinessFactKeys = Object.freeze([
  'authMethod', 'featureEnabled', 'installationId', 'migrationRequired', 'operationalConnected',
  'productionManifestActive', 'providerId', 'savedInactive', 'serviceId', 'temporarilyDisabled',
]);

const validReadinessFact = (fact: ConnectorReadinessFact): boolean => fact !== null
  && typeof fact === 'object' && Object.keys(fact).sort().join(',') === readinessFactKeys.join(',')
  && idValid(fact.installationId) && idValid(fact.providerId) && idValid(fact.serviceId)
  && ['dcr_pkce', 'byo_app', 'api_key'].includes(fact.authMethod)
  && [fact.productionManifestActive, fact.featureEnabled, fact.temporarilyDisabled,
    fact.migrationRequired, fact.savedInactive, fact.operationalConnected]
    .every(value => typeof value === 'boolean');

type ConnectorRecentOwnerSession = Readonly<{
  installationId: string;
  userId: number;
  authTimeMs: number;
  expiresAtMs: number;
  csrfTokenHash: string;
}>;

type ConnectorM5Request = express.Request;
type ConnectorInstallationMember = Readonly<{
  installationId: string;
  userId: number;
  role: 'owner' | 'member';
}>;

const exactBody = (body: unknown): body is { canonicalOrigin: string; expectedOriginRevision: number } => {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  return Object.keys(value).sort().join(',') === 'canonicalOrigin,expectedOriginRevision'
    && typeof value.canonicalOrigin === 'string' && Number.isSafeInteger(value.expectedOriginRevision)
    && Number(value.expectedOriginRevision) >= 0;
};

const csrfMatches = (token: unknown, expectedHash: string): boolean => {
  if (typeof token !== 'string' || token.length < 32 || token.length > 512
    || !/^[a-f0-9]{64}$/iu.test(expectedHash)) return false;
  const actual = createHash('sha256').update(token).digest();
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

/**
 * Creates the unmounted M5 HTTP contract. The caller supplies only a trusted
 * server-side recent-auth session reader and secret-free readiness facts.
 */
export const createConnectorInstallationReadinessV2Routes = (dependencies: Readonly<{
  installationId: string;
  store: ConnectorInstallationOriginV2Store;
  resolveInstallationMember: (req: express.Request, installationId: string) => ConnectorInstallationMember | null
    | Promise<ConnectorInstallationMember | null>;
  readFacts: (installationId: string) => readonly ConnectorReadinessFact[]
    | Promise<readonly ConnectorReadinessFact[]>;
  readRecentOwnerSession: (req: express.Request) => ConnectorRecentOwnerSession | null
    | Promise<ConnectorRecentOwnerSession | null>;
  executeOriginWrite: (advanceWriterEpoch: boolean, effect: () => void) => boolean | Promise<boolean>;
  now?: () => number;
}>): express.Router => {
  if (!idValid(dependencies.installationId)) throw new Error('connector_installation_id_invalid');
  const routes = express.Router();
  routes.get('/catalog', (req, res) => { void getCatalog(req as ConnectorM5Request, res, dependencies); });
  routes.put('/origin', (req, res) => { void putOrigin(req as ConnectorM5Request, res, dependencies); });
  return routes;
};

type RouteDependencies = Parameters<typeof createConnectorInstallationReadinessV2Routes>[0];

const installationCaller = async (req: express.Request, dependencies: RouteDependencies): Promise<Readonly<{
  userId: number; owner: boolean;
}> | null> => {
  const member = await dependencies.resolveInstallationMember(req, dependencies.installationId);
  if (!member || member.installationId !== dependencies.installationId
    || !Number.isSafeInteger(member.userId) || member.userId < 1
    || (member.role !== 'owner' && member.role !== 'member')) return null;
  return Object.freeze({ userId: member.userId, owner: member.role === 'owner' });
};

const getCatalog = async (req: ConnectorM5Request, res: express.Response,
  dependencies: RouteDependencies): Promise<void> => {
  res.set('Cache-Control', 'no-store');
  let identity: Awaited<ReturnType<typeof installationCaller>>;
  try { identity = await installationCaller(req, dependencies); }
  catch { res.status(503).json({ code: 'CONNECTOR_READINESS_UNAVAILABLE' }); return; }
  if (!identity) { res.status(401).json({ code: 'AUTH_REQUIRED' }); return; }
  try {
    const facts = await dependencies.readFacts(dependencies.installationId);
    if (facts.some(fact => fact.installationId !== dependencies.installationId)) {
      throw new Error('connector_readiness_installation_mismatch');
    }
    res.json(connectorInstallationReadinessCatalog({ installationId: dependencies.installationId,
      owner: identity.owner, store: dependencies.store, facts }));
  } catch { res.status(503).json({ code: 'CONNECTOR_READINESS_UNAVAILABLE' }); }
};

const putOrigin = async (req: ConnectorM5Request, res: express.Response,
  dependencies: RouteDependencies): Promise<void> => {
  res.set('Cache-Control', 'no-store');
  let identity: Awaited<ReturnType<typeof installationCaller>>;
  try { identity = await installationCaller(req, dependencies); }
  catch { res.status(503).json({ code: 'CONNECTOR_READINESS_UNAVAILABLE' }); return; }
  if (!identity?.owner) { res.status(403).json({ code: 'CONNECTOR_OWNER_REQUIRED' }); return; }
  if (!exactBody(req.body)) { res.status(400).json({ code: 'CONNECTOR_ORIGIN_INPUT_INVALID' }); return; }
  const nowMs = dependencies.now?.() ?? Date.now();
  let session: ConnectorRecentOwnerSession | null;
  try { session = await dependencies.readRecentOwnerSession(req); }
  catch { res.status(503).json({ code: 'CONNECTOR_READINESS_UNAVAILABLE' }); return; }
  const requestOrigin = req.get('origin');
  let proposedOrigin: string;
  try {
    proposedOrigin = dependencies.store.canonicalizeOrigin(req.body.canonicalOrigin);
  } catch { res.status(400).json({ code: 'CONNECTOR_ORIGIN_INPUT_INVALID' }); return; }
  let current: ConnectorCanonicalOrigin | null;
  try { current = dependencies.store.read(dependencies.installationId); }
  catch { res.status(503).json({ code: 'CONNECTOR_READINESS_UNAVAILABLE' }); return; }
  const trusted = session !== null && session.installationId === dependencies.installationId
    && session.userId === identity.userId && session.authTimeMs <= nowMs
    && nowMs - session.authTimeMs <= 300_000 && session.expiresAtMs > nowMs
    && requestOrigin === (current?.canonicalOrigin ?? proposedOrigin)
    && csrfMatches(req.get('x-csrf-token'), session.csrfTokenHash);
  if (!session || !trusted) {
    res.status(403).json({ code: 'CONNECTOR_RECENT_AUTH_OR_CSRF_REQUIRED' }); return;
  }
  try {
    const authority = ConnectorInstallationOwnerCapability.fixture({ installationId: dependencies.installationId,
      userId: identity.userId, role: 'owner', recentAuth: true, csrfVerified: true,
      requestOrigin, intent: 'set_installation_origin', issuedAtMs: session.authTimeMs,
      expiresAtMs: Math.min(session.expiresAtMs, nowMs + 30_000) });
    let origin: ConnectorCanonicalOrigin | null = null;
    const advanceWriterEpoch = current !== null && current.canonicalOrigin !== proposedOrigin;
    const executed = await dependencies.executeOriginWrite(advanceWriterEpoch, () => {
      origin = dependencies.store.setOrigin({ installationId: dependencies.installationId,
        userId: identity.userId, proposedOrigin, expectedOriginRevision: req.body.expectedOriginRevision,
        authority, nowMs });
    });
    if (!executed || !origin) {
      res.status(503).json({ code: 'CONNECTOR_READINESS_UNAVAILABLE' }); return;
    }
    res.json({ schemaVersion: 2, origin });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'connector_origin_revision_conflict') {
      res.status(409).json({ code: 'CONNECTOR_ORIGIN_REVISION_CONFLICT' }); return;
    }
    if (code === 'connector_origin_oauth_pending') {
      res.status(409).json({ code: 'CONNECTOR_ORIGIN_OAUTH_PENDING' }); return;
    }
    if (code === 'connector_installation_readiness_unavailable'
      || code === 'connector_policy_state_missing' || code === 'connector_policy_state_corrupt') {
      res.status(503).json({ code: 'CONNECTOR_READINESS_UNAVAILABLE' }); return;
    }
    res.status(403).json({ code: 'CONNECTOR_ORIGIN_WRITE_REJECTED' });
  }
};
