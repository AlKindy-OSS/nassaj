/**
 * Connectors store — the settings tab's three GETs, hoisted out of the tab.
 *
 * WHY THIS EXISTS. Measured 2026-08-06 with a request log: opening the settings
 * dialog fires one burst of calls (settings, provider auth status, provider
 * sharing…) at the moment the modal mounts, so by the time
 * a member picks a tab its data has already landed. Connectors was the lone tab
 * that started fetching when its own tab was CLICKED — 3635ms in that trace,
 * against 2887ms for everything else — which is why it, and only it, showed a
 * spinner. On a phone over 4G that gap is the difference between "instant" and
 * "loading…" (owner report, with a screenshot of exactly that).
 *
 * So the fetch moves here and `useSettingsController` kicks it off with the rest
 * of the burst. The tab then reads a snapshot that is usually already full.
 *
 * WHY A MODULE-LEVEL STORE AND NOT PROPS. The result must outlive the tab: a
 * member who opens Connectors, switches to Profile and comes back should not
 * watch the same spinner twice. Component state dies with the unmount; this does
 * not. It follows `workflowStatusStore`'s shape — a plain external store read
 * through `useSyncExternalStore` — rather than adding a state library the
 * project does not use.
 *
 * ERRORS ARE CODES, NOT SENTENCES. A store cannot translate, and freezing an
 * English string here would put it on an Arabic page. It records WHAT failed and
 * the tab renders it through i18n. That also keeps the loader free of `t`, so a
 * language change can no longer invalidate the fetch callback.
 */

import { useSyncExternalStore } from 'react';

import { authenticatedFetch } from '../utils/api';

export type ConnectorCredentialMode = 'per_member' | 'org_shared';

export type ConnectorPlacementAggregate =
  | 'not_configured'
  | 'paused'
  | 'untracked'
  | 'pending'
  | 'reconciling'
  | 'partial'
  | 'degraded'
  | 'blocked'
  | 'healthy';

export type ConnectorTargetStatus = {
  provider: 'claude' | 'codex';
  state: 'untracked' | 'pending' | 'applying' | 'healthy' | 'degraded' | 'removing' | 'blocked';
  healthy: boolean;
  desiredGeneration: number;
  appliedGeneration: number;
  attemptCount: number;
  nextRetryAt: string | null;
  lastErrorCode: string | null;
};

export type Connector = {
  id: string;
  service: string;
  displayName: string;
  accountLabel: string;
  enabled: boolean;
  /** Credential/grant existence only; never a live-runtime health claim. */
  configured: boolean;
  degraded: boolean;
  availableNextSession: boolean;
  availability: 'not_configured' | 'degraded' | 'available_next_session';
  placementStatus: ConnectorPlacementAggregate;
  targets: ConnectorTargetStatus[];
  /** Server-owned action gate. Missing means false during mixed-version rollout. */
  retryAvailable?: boolean;
  credentialMode: ConnectorCredentialMode;
  ownerUserId: number | null;
  allowsSharing: boolean;
  authMode?: 'key' | 'oauth';
  /**
   * Where the credential actually comes from. `operator_env` is the case a
   * boolean could not express: nobody pasted anything, the key lives in the
   * install's own environment, and the connector therefore serves every member —
   * which the page used to render as "no key" while the tools worked.
   */
  credentialSource?: 'oauth_grant' | 'stored' | 'operator_env' | null;
};

export type ConnectorCatalogEntry = {
  service: string;
  displayName: string;
  summary: string;
  allowsSharing: boolean;
  keyHelpUrl?: string;
  keyLabel?: string;
  logo?: string;
  logoExt?: 'svg' | 'png';
  official: boolean;
  /** Who publishes the server that will hold the key, when it is not the platform. */
  vendorUrl?: string;
  /** Public, non-secret fields a key connector asks the member to supply. */
  additionalFields?: Array<{ id: string; label: string; hint?: string }>;
  authMode?: 'key' | 'oauth';
  oauthAvailability?: 'ready' | 'server_not_configured';
  /** Portable M1 auth contract. Missing on legacy/mixed-version servers. */
  authMetadata?: {
    profileId: string;
    method: 'dcr_pkce' | 'byo_app' | 'api_key';
    readiness: 'ready' | 'owner_setup_required' | 'unsupported' | 'temporarily_unavailable';
    accountBundle?: { id: string; label: string };
    canSubmitCredential?: boolean;
    canStartOAuth?: boolean;
    canStoreUnverified?: boolean;
    credentialInputSchema?: {
      schemaVersion: 1;
      shape: 'single_api_key' | 'geidea_basic';
      fields: Array<{
        id: 'api_key' | 'merchant_public_key' | 'api_password';
        label: string;
        inputType: 'password' | 'text';
        required: true;
      }>;
    } | null;
    submitSemantics?: {
      operation: 'put_personal_api_key' | 'start_oauth' | 'none';
      credentialPayload: 'apiKey' | 'credentialFields' | 'none';
      activation: 'after_verification' | 'stored_inert' | 'after_callback_verification' | 'unavailable';
      requiresExplicitUnverifiedConsent: boolean;
      unverifiedConsentPayload: 'acceptStoredUnverified' | 'none';
    };
  };
};

type CatalogResponse = {
  schemaVersion?: number;
  catalog?: Array<ConnectorCatalogEntry & {
    extraEnv?: Array<{ envVar: string; label: string; hint?: string }>;
    oauthSetup?: {
      configured: boolean;
      redirectUri?: string;
      registerAppUrl?: string;
      envVars?: string[];
    };
  }>;
};

const legacySubmissionKeys = new WeakMap<ConnectorCatalogEntry, Map<string, string>>();

/**
 * Keeps mixed-version deployments usable without exposing operator OAuth setup.
 * A v2 server is authoritative. A v1 server contributes only the boolean
 * readiness and public key-field metadata; redirect URLs, env names and app
 * registration instructions intentionally stop at this boundary.
 */
export function normalizeConnectorCatalog(payload: CatalogResponse): ConnectorCatalogEntry[] {
  const version = payload.schemaVersion;
  if (version !== undefined && version !== 2) return [];
  return (payload.catalog ?? []).map((raw) => {
    const legacySetup = raw.oauthSetup;
    const legacyKeys = new Map<string, string>();
    const additionalFields = raw.additionalFields ?? raw.extraEnv?.map((field, index) => {
      const id = `field-${index + 1}`;
      legacyKeys.set(id, field.envVar);
      return ({
      id,
      label: field.label,
      hint: field.hint,
    });
    });
    const entry: ConnectorCatalogEntry = {
      service: raw.service,
      displayName: raw.displayName,
      summary: raw.summary,
      allowsSharing: raw.allowsSharing,
      keyHelpUrl: raw.keyHelpUrl,
      keyLabel: raw.keyLabel,
      logo: raw.logo,
      logoExt: raw.logoExt,
      official: raw.official,
      vendorUrl: raw.vendorUrl,
      authMode: raw.authMode,
      additionalFields,
      oauthAvailability: raw.oauthAvailability ??
        (raw.authMode === 'oauth'
          ? (legacySetup?.configured ? 'ready' : 'server_not_configured')
          : undefined),
      ...(raw.authMetadata ? { authMetadata: raw.authMetadata } : {}),
    };
    if (legacyKeys.size > 0) legacySubmissionKeys.set(entry, legacyKeys);
    return entry;
  });
}

/** Builds the version-correct write body without exposing legacy env names to React or the DOM. */
export function connectorAdditionalFieldsPayload(
  entry: ConnectorCatalogEntry,
  values: Record<string, string>,
  schemaVersion: 1 | 2,
): { additionalFields?: Record<string, string>; extraEnv?: Record<string, string> } {
  if (Object.keys(values).length === 0) return {};
  if (schemaVersion === 2) return { additionalFields: values };
  const keys = legacySubmissionKeys.get(entry);
  if (!keys) return {};
  const extraEnv: Record<string, string> = {};
  for (const [id, value] of Object.entries(values)) {
    const legacyKey = keys.get(id);
    if (legacyKey) extraEnv[legacyKey] = value;
  }
  return Object.keys(extraEnv).length > 0 ? { extraEnv } : {};
}

export type ConnectorTarget = { provider: string; writesPerUserConfig: boolean };

/** What went wrong, in a form the tab can translate. */
export type ConnectorsError =
  | { kind: 'timeout' }
  | { kind: 'http'; status: number }
  | { kind: 'unknown'; message: string };

export type ConnectorsSnapshot = {
  connectors: Connector[];
  catalog: ConnectorCatalogEntry[];
  targets: ConnectorTarget[];
  catalogSchemaVersion: 1 | 2;
  /** `ready` means the lists below are real, even while a refresh is in flight. */
  ready: boolean;
  loading: boolean;
  error: ConnectorsError | null;
};

const EMPTY_CONNECTORS: Connector[] = [];
const EMPTY_CATALOG: ConnectorCatalogEntry[] = [];
const EMPTY_TARGETS: ConnectorTarget[] = [];

let snapshot: ConnectorsSnapshot = {
  connectors: EMPTY_CONNECTORS,
  catalog: EMPTY_CATALOG,
  targets: EMPTY_TARGETS,
  catalogSchemaVersion: 1,
  ready: false,
  loading: false,
  error: null,
};

const listeners = new Set<() => void>();

function emit(next: ConnectorsSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A request that never settles would leave the tab on its spinner forever. */
const DEADLINE_MS = 15000;

/**
 * In-flight guard. The modal's open effect and the tab's own mount effect both
 * ask to load — deliberately, so the tab still works if it is ever rendered
 * outside the dialog — and without this they would fire the same three GETs
 * twice within a frame of each other.
 */
let inFlight: Promise<void> | null = null;

/**
 * Loads the three lists.
 *
 * Returns immediately when the data is already present, because the common call
 * is "the modal opened again". Pass `force` after a mutation, where the point is
 * precisely to discard what we hold.
 */
export function loadConnectors(force = false): Promise<void> {
  if (inFlight) return inFlight;
  if (snapshot.ready && !force) return Promise.resolve();

  emit({ ...snapshot, loading: true, error: null });

  const run = (async () => {
    try {
      const deadline = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('__timeout__')), DEADLINE_MS),
      );
      const [listRes, catalogRes, targetRes] = await Promise.race([
        Promise.all([
          authenticatedFetch('/api/connectors'),
          authenticatedFetch('/api/connectors/catalog'),
          authenticatedFetch('/api/connectors/targets'),
        ]),
        deadline,
      ]);
      if (!listRes.ok) {
        emit({ ...snapshot, loading: false, error: { kind: 'http', status: listRes.status } });
        return;
      }
      const connectors = ((await listRes.json()).connectors ?? []) as Connector[];
      const catalogPayload = catalogRes.ok ? (await catalogRes.json()) as CatalogResponse : null;
      const catalog = catalogPayload ? normalizeConnectorCatalog(catalogPayload) : snapshot.catalog;
      const catalogSchemaVersion = catalogPayload?.schemaVersion === 2 ? 2 : 1;
      const targets = targetRes.ok
        ? (((await targetRes.json()).targets ?? []) as ConnectorTarget[])
        : snapshot.targets;
      emit({ connectors, catalog, targets, catalogSchemaVersion, ready: true, loading: false, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({
        ...snapshot,
        loading: false,
        error: message === '__timeout__' ? { kind: 'timeout' } : { kind: 'unknown', message },
      });
    } finally {
      inFlight = null;
    }
  })();

  inFlight = run;
  return run;
}

export function useConnectorsSnapshot(): ConnectorsSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** Test seam: reads the snapshot without mounting a component. */
export function __snapshotForTest(): ConnectorsSnapshot {
  return snapshot;
}

/** Test seam: drops everything so one test's fetch cannot leak into the next. */
export function resetConnectorsStore(): void {
  inFlight = null;
  emit({
    connectors: EMPTY_CONNECTORS,
    catalog: EMPTY_CATALOG,
    targets: EMPTY_TARGETS,
    catalogSchemaVersion: 1,
    ready: false,
    loading: false,
    error: null,
  });
}
