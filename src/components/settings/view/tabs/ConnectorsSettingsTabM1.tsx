import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertCircle,
  Check,
  ChevronDown,
  KeyRound,
  Link2,
  Loader2,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { cn } from '../../../../lib/utils';
import {
  loadConnectors,
  type Connector,
  type ConnectorCatalogEntry,
  useConnectorsSnapshot,
} from '../../../../stores/connectorsStore';
import { authenticatedFetch } from '../../../../utils/api';
import { Button, Input } from '../../../../shared/view/ui';
import { useOptionalAuth } from '../../../auth/context/AuthContext';
import SettingsSection from '../SettingsSection';
import StatusBadge from '../StatusBadge';

import ConnectorOwnerSetupWizard from './ConnectorOwnerSetupWizard';
import { navigateToConnectorAuthorization } from './connectorNavigation';

type Grant = {
  grantId: string;
  serviceId: string;
  accountLabel: string;
  isDefault: boolean;
  status: 'pending' | 'active' | 'revoked' | 'error';
  bundleState: 'candidate' | 'stored' | 'superseded' | 'deleted' | null;
  verificationState: 'stored_unverified' | 'verified' | 'stale' | 'rejected' | 'unavailable' | 'corrupt' | null;
  operationalState: 'ineligible' | 'eligible' | 'disabled' | 'revoking' | 'deleted' | null;
  eligible: boolean;
  availabilityState: 'stored_only' | 'available_next_session' | 'needs_reconciliation'
    | 'verification_expired' | 'credential_rejected' | 'credential_corrupt'
    | 'temporarily_unavailable' | 'not_available';
  reasonCode: 'not_verified' | 'verification_expired' | 'credential_rejected'
    | 'credential_corrupt' | 'verification_unavailable' | 'operational_ineligible'
    | 'placement_pending' | 'policy_disabled' | 'grant_inactive' | 'no_credential' | null;
  credentialExpiresAt: string | null;
  canRetryVerification: boolean;
  canReconnect: boolean;
  canRemove: boolean;
  grantedServices: string[];
  availableBodies: Array<'claude' | 'codex'>;
  pendingBodies: Array<'claude' | 'codex'>;
};

type KeyDraft = {
  accountLabel: string;
  fields: Record<string, string>;
  acceptStoredUnverified: boolean;
};

type CredentialSchema = NonNullable<NonNullable<ConnectorCatalogEntry['authMetadata']>['credentialInputSchema']>;

const credentialSchemaFor = (entry: ConnectorCatalogEntry): CredentialSchema | null => {
  const metadata = entry.authMetadata;
  const schema = metadata?.credentialInputSchema;
  const semantics = metadata?.submitSemantics;
  if (metadata?.canSubmitCredential !== true || !schema || schema.schemaVersion !== 1
    || semantics?.operation !== 'put_personal_api_key'
    || semantics.credentialPayload !== (schema.shape === 'single_api_key' ? 'apiKey' : 'credentialFields')
    || semantics.requiresExplicitUnverifiedConsent !== (metadata.canStoreUnverified === true)
    || semantics.unverifiedConsentPayload !== (metadata.canStoreUnverified === true
      ? 'acceptStoredUnverified' : 'none')
    || semantics.activation !== (metadata.canStoreUnverified === true ? 'stored_inert' : 'after_verification')
    || !['single_api_key', 'geidea_basic'].includes(schema.shape) || schema.fields.length === 0
    || new Set(schema.fields.map(field => field.id)).size !== schema.fields.length
    || schema.fields.some(field => !['api_key', 'merchant_public_key', 'api_password'].includes(field.id)
      || !['password', 'text'].includes(field.inputType) || field.required !== true)) return null;
  return schema;
};

const canStartOAuthFor = (entry: ConnectorCatalogEntry): boolean => {
  const metadata = entry.authMetadata;
  const semantics = metadata?.submitSemantics;
  return metadata?.canStartOAuth === true && semantics?.operation === 'start_oauth'
    && semantics.credentialPayload === 'none'
    && semantics.activation === 'after_callback_verification'
    && semantics.requiresExplicitUnverifiedConsent === false
    && semantics.unverifiedConsentPayload === 'none';
};

const VERIFICATION_STATES = new Set(['stored_unverified', 'verified', 'stale', 'rejected', 'unavailable', 'corrupt']);
const OPERATIONAL_STATES = new Set(['ineligible', 'eligible', 'disabled', 'revoking', 'deleted']);
const BUNDLE_STATES = new Set(['candidate', 'stored', 'superseded', 'deleted']);
const AVAILABILITY_STATES = new Set(['stored_only', 'available_next_session', 'needs_reconciliation',
  'verification_expired', 'credential_rejected', 'credential_corrupt',
  'temporarily_unavailable', 'not_available']);
const REASON_CODES = new Set(['not_verified', 'verification_expired', 'credential_rejected',
  'credential_corrupt', 'verification_unavailable', 'operational_ineligible',
  'placement_pending', 'policy_disabled', 'grant_inactive', 'no_credential']);

/** Treats malformed/mixed-version grant truth as visible but never operable or connected. */
const parseGrant = (raw: unknown): Grant | null => {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.grantId !== 'string' || typeof value.serviceId !== 'string'
    || typeof value.accountLabel !== 'string' || !['pending', 'active', 'error', 'revoked'].includes(String(value.status))) return null;
  const stringList = (input: unknown): string[] => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === 'string') : [];
  const bodyList = (input: unknown): Array<'claude' | 'codex'> => stringList(input)
    .filter((item): item is 'claude' | 'codex' => item === 'claude' || item === 'codex');
  const servicesValid = Array.isArray(value.grantedServices) && value.grantedServices.length > 0
    && value.grantedServices.every(service => typeof service === 'string' && service.length > 0);
  const bodiesValid = [value.availableBodies, value.pendingBodies].every(list =>
    Array.isArray(list) && list.every(body => body === 'claude' || body === 'codex'));
  const axesValid = value.eligible === true
    ? value.verificationState === 'verified' && value.operationalState === 'eligible'
      && (value.availabilityState === 'available_next_session' || value.availabilityState === 'needs_reconciliation')
    : value.availabilityState !== 'available_next_session';
  const validTruth = typeof value.eligible === 'boolean'
    && typeof value.availabilityState === 'string' && AVAILABILITY_STATES.has(value.availabilityState)
    && (value.verificationState === null || typeof value.verificationState === 'string' && VERIFICATION_STATES.has(value.verificationState))
    && (value.operationalState === null || typeof value.operationalState === 'string' && OPERATIONAL_STATES.has(value.operationalState))
    && (value.bundleState === null || typeof value.bundleState === 'string' && BUNDLE_STATES.has(value.bundleState))
    && (value.reasonCode === null || typeof value.reasonCode === 'string' && REASON_CODES.has(value.reasonCode))
    && typeof value.canRetryVerification === 'boolean' && typeof value.canReconnect === 'boolean'
    && typeof value.canRemove === 'boolean' && servicesValid && bodiesValid && axesValid;
  return {
    grantId: value.grantId, serviceId: value.serviceId, accountLabel: value.accountLabel,
    isDefault: value.isDefault === true,
    status: value.status as Grant['status'],
    bundleState: validTruth && BUNDLE_STATES.has(String(value.bundleState))
      ? value.bundleState as Grant['bundleState'] : null,
    verificationState: validTruth ? value.verificationState as Grant['verificationState'] : null,
    operationalState: validTruth ? value.operationalState as Grant['operationalState'] : null,
    eligible: validTruth && value.eligible === true,
    availabilityState: validTruth ? value.availabilityState as Grant['availabilityState'] : 'not_available',
    reasonCode: validTruth && (typeof value.reasonCode === 'string' || value.reasonCode === null)
      ? value.reasonCode as Grant['reasonCode'] : 'operational_ineligible',
    credentialExpiresAt: typeof value.credentialExpiresAt === 'string' ? value.credentialExpiresAt : null,
    canRetryVerification: validTruth && value.canRetryVerification === true,
    canReconnect: validTruth && value.canReconnect === true,
    canRemove: validTruth && value.canRemove === true,
    grantedServices: validTruth ? [...new Set(stringList(value.grantedServices))] : [value.serviceId],
    availableBodies: validTruth ? bodyList(value.availableBodies) : [],
    pendingBodies: validTruth ? bodyList(value.pendingBodies) : [],
  };
};

type Profile = {
  providerId: string;
  services: string[];
  authMethod: 'dcr_pkce' | 'byo_app' | 'api_key';
  readiness: 'ready' | 'owner_setup_required' | 'unsupported' | 'temporarily_unavailable';
  configured: boolean;
  status: 'pending' | 'ready' | 'disabled' | 'error' | 'not_configured';
  setup?: { callbackUrl: string; appRegistrationUrl: string };
};

type ReadinessResponse = {
  schemaVersion?: number;
  csrfToken?: string | null;
  recentAuthRequired?: boolean;
  profiles?: Profile[];
};
type View = 'accounts' | 'installation';
const GOOGLE_WORKSPACE_TITLE = 'Google Workspace';

const serviceLogo = (entry: ConnectorCatalogEntry) => entry.logo
  ? `/connector-logos/${entry.logo}.${entry.logoExt ?? 'svg'}`
  : null;

const normalizeAccountLabel = (value: string | undefined): string =>
  (value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');

/** Carries the server-sent `code` field alongside the human-readable message. */
class ConnectorApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ConnectorApiError';
  }
}

const AUTH_CODES = new Set([
  'AUTH_REQUIRED', 'CONNECTOR_RECENT_AUTH_REQUIRED', 'CONNECTOR_CSRF_REJECTED',
]);

/**
 * Portable connector surface. It consumes only the public M1 registry DTOs and
 * the secret-free readiness/grant APIs; provider endpoints and secrets never
 * become client state after a write succeeds.
 */
export default function ConnectorsSettingsTabM1() {
  const { t, i18n } = useTranslation('settings');
  const auth = useOptionalAuth();
  const isOwner = auth?.user?.role === 'owner';
  const { catalog, connectors, loading, error: loadError } = useConnectorsSnapshot();
  const [view, setView] = useState<View>('accounts');
  const [grants, setGrants] = useState<Grant[]>([]);
  const [grantsKnown, setGrantsKnown] = useState(false);
  const [grantsLoadFailed, setGrantsLoadFailed] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profilesKnown, setProfilesKnown] = useState(false);
  const [readinessSchemaVersion, setReadinessSchemaVersion] = useState<1 | 2 | null>(null);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [recentAuthRequired, setRecentAuthRequired] = useState(false);
  const [readinessErrorCode, setReadinessErrorCode] = useState<string | null>(null);
  const [grantsErrorCode, setGrantsErrorCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [keyService, setKeyService] = useState<string | null>(null);
  const [oauthService, setOAuthService] = useState<string | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, KeyDraft>>({});
  const [oauthLabels, setOauthLabels] = useState<Record<string, string>>({});
  const [localDrafts, setLocalDrafts] = useState<Record<string, Connector>>({});
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  const initialRefreshStarted = useRef(false);
  const writesAllowed = profilesKnown && csrfToken !== null && !recentAuthRequired;
  const actionsAllowed = writesAllowed && grantsKnown && !grantsLoadFailed
    && readinessSchemaVersion !== null;

  const copy = useCallback((key: string, en: string, ar: string) => t(
    `connectorsSettings.m1.${key}`,
    { defaultValue: i18n.language.startsWith('ar') ? ar : en },
  ), [i18n.language, t]);

  const platformName = useCallback((entry: ConnectorCatalogEntry): string => t(
    `connectorsSettings.platforms.${entry.service}.displayName`,
    { defaultValue: entry.displayName },
  ), [t]);

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && !writesAllowed) {
      setRecentAuthRequired(true);
      throw new ConnectorApiError('CONNECTOR_RECENT_AUTH_REQUIRED', 'connector_recent_auth_required');
    }
    const response = await authenticatedFetch(path, {
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.method && init.method !== 'GET' && csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        ...init?.headers,
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code: string = payload.code ?? 'UNKNOWN';
      if (code === 'CONNECTOR_RECENT_AUTH_REQUIRED' || code === 'CONNECTOR_CSRF_REJECTED') {
        setCsrfToken(null);
        setRecentAuthRequired(true);
        throw new ConnectorApiError(code, 'connector_recent_auth_required');
      }
      const reason = payload.error
        || copy('requestFailed', 'The request could not be completed.', 'تعذر إكمال الطلب.');
      throw new ConnectorApiError(code, reason);
    }
    return payload;
  }, [copy, csrfToken, writesAllowed]);

  const handleWriteError = (scope: string, reason: unknown) => {
    if (reason instanceof ConnectorApiError && AUTH_CODES.has(reason.code)) return;
    setActionErrors(current => ({
      ...current,
      [scope]: copy('actionFailed', 'This action could not be completed. Try again.', 'تعذر إكمال هذا الإجراء. حاول مرة أخرى.'),
    }));
  };

  const clearActionError = (scope: string) => setActionErrors(current => {
    if (!(scope in current)) return current;
    const next = { ...current };
    delete next[scope];
    return next;
  });

  const refresh = useCallback(async () => {
    setError(null);
    setReadinessErrorCode(null);
    setGrantsErrorCode(null);
    const [grantResult, readinessResult] = await Promise.allSettled([
      request('/api/connectors/grants'),
      request('/api/connectors/auth-readiness'),
    ]);
    if (grantResult.status === 'fulfilled') {
      const rawGrants: unknown = grantResult.value.grants;
      const parsedGrants = Array.isArray(rawGrants)
        ? rawGrants.map((raw: unknown) => parseGrant(raw))
        : null;
      if (parsedGrants !== null && parsedGrants.every((grant): grant is Grant => grant !== null)) {
        setGrants(parsedGrants);
        setGrantsKnown(true);
        setGrantsLoadFailed(false);
      } else {
        setGrantsLoadFailed(true);
        setError(copy('accountsLoadFailed', 'Connector accounts could not be loaded.', 'تعذر تحميل حسابات الموصلات.'));
      }
    } else {
      const grantErr = grantResult.reason;
      const grantCode = grantErr instanceof ConnectorApiError ? grantErr.code : 'UNKNOWN';
      setGrantsErrorCode(grantCode);
      setGrantsLoadFailed(true);
      // Auth-level grant errors propagate to recentAuthRequired; structural ones
      // surface via the diagnostic panel without a sign-in CTA.
      if (AUTH_CODES.has(grantCode)) {
        setRecentAuthRequired(true);
      }
      if (grantCode !== 'CONNECTOR_GRANTS_DISABLED') {
        setError(copy('accountsLoadFailed', 'Connector accounts could not be loaded.', 'تعذر تحميل حسابات الموصلات.'));
      }
    }
    if (readinessResult.status === 'fulfilled') {
      const readiness = readinessResult.value as ReadinessResponse;
      const schemaVersion = readiness.schemaVersion === 1 || readiness.schemaVersion === 2
        ? readiness.schemaVersion : null;
      const validCsrf = typeof readiness.csrfToken === 'string' && /^[a-f0-9]{64}$/u.test(readiness.csrfToken);
      const validProfiles = Array.isArray(readiness.profiles);
      setProfiles(schemaVersion !== null && validProfiles ? readiness.profiles! : []);
      setCsrfToken(schemaVersion !== null && validCsrf ? readiness.csrfToken! : null);
      setProfilesKnown(schemaVersion !== null && validProfiles);
      setReadinessSchemaVersion(schemaVersion);
      setRecentAuthRequired(schemaVersion !== null
        && (readiness.recentAuthRequired === true || !validCsrf));
    } else {
      // Mixed-version and flag-off servers fail closed: no OAuth action is
      // inferred from catalog metadata alone. Only session-level errors trigger
      // the re-login CTA; structural/config errors get the diagnostic panel.
      const readinessErr = readinessResult.reason;
      const readinessCode = readinessErr instanceof ConnectorApiError
        ? readinessErr.code : 'UNKNOWN';
      setReadinessErrorCode(readinessCode);
      setProfiles([]);
      setCsrfToken(null);
      setProfilesKnown(false);
      setReadinessSchemaVersion(null);
      setRecentAuthRequired(AUTH_CODES.has(readinessCode));
    }
    await loadConnectors(true);
  }, [copy, request]);

  // A live role downgrade must remove owner-only navigation and every setup
  // draft before the browser paints the next frame. Secrets never linger in a
  // hidden owner panel, and a stale installation deep-link lands on Accounts.
  useLayoutEffect(() => {
    if (isOwner) return;
    setView('accounts');
  }, [isOwner]);

  useEffect(() => {
    if (initialRefreshStarted.current) return;
    initialRefreshStarted.current = true;
    void refresh();
  }, [refresh]);

  const profileById = useMemo(
    () => new Map(profiles.map(profile => [profile.providerId, profile])),
    [profiles],
  );
  const grantsByService = useMemo(() => {
    const result = new Map<string, Grant[]>();
    for (const grant of grants.filter(item => item.status !== 'revoked')) {
      for (const serviceId of grant.grantedServices) {
        result.set(serviceId, [...(result.get(serviceId) ?? []), grant]);
      }
    }
    return result;
  }, [grants]);
  const isConnected = useCallback((grant: Grant): boolean =>
    grant.eligible === true
      && grant.availabilityState === 'available_next_session', []);

  const grouped = useMemo(() => {
    const result = new Map<string, ConnectorCatalogEntry[]>();
    for (const entry of catalog.filter(item => item.authMetadata)) {
      const id = entry.authMetadata?.accountBundle?.id ?? entry.authMetadata!.profileId;
      result.set(id, [...(result.get(id) ?? []), entry]);
    }
    return [...result.entries()].sort(([left], [right]) => {
      if (left === 'google-workspace') return -1;
      if (right === 'google-workspace') return 1;
      return left.localeCompare(right);
    });
  }, [catalog]);

  const connectedGroups = useMemo(() => grouped.filter(([, entries]) =>
    entries.some(entry => (grantsByService.get(entry.service) ?? [])
      .some(isConnected))),
  [grantsByService, grouped, isConnected]);
  const availableGroups = useMemo(() => grouped.filter(([, entries]) =>
    !entries.some(entry => (grantsByService.get(entry.service) ?? [])
      .some(isConnected))),
  [grantsByService, grouped, isConnected]);

  const profileReady = (entry: ConnectorCatalogEntry): boolean => {
    const profile = profileById.get(entry.authMetadata?.profileId ?? '');
    if (profile?.readiness !== 'ready') return false;
    return entry.authMetadata?.method === 'api_key'
      ? credentialSchemaFor(entry) !== null
      : canStartOAuthFor(entry);
  };

  const moveViewFocus = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const next: View = event.key === 'Home' ? 'accounts'
      : event.key === 'End' ? 'installation'
        : event.key === (rtl ? 'ArrowLeft' : 'ArrowRight') ? 'installation' : 'accounts';
    setView(next);
    document.getElementById(`connector-view-${next}`)?.focus();
  };

  const createOrRecoverDraft = async (
    entry: ConnectorCatalogEntry,
    authMode: 'key' | 'oauth',
    normalizedLabel: string,
  ): Promise<Connector> => {
    const draftKey = `${entry.service}\0${normalizedLabel}`;
    const userId = Number(auth?.user?.id);
    const exact = (candidates: Connector[]) => candidates.find(connector =>
      connector.service === entry.service
        && connector.authMode === authMode
        && connector.credentialMode === 'per_member'
        && connector.ownerUserId === userId
        && normalizeAccountLabel(connector.accountLabel) === normalizedLabel);
    let draft: Connector | undefined = localDrafts[draftKey] ?? exact(connectors);
    if (!draft) {
      try {
        draft = (await request('/api/connectors', {
          method: 'POST', body: JSON.stringify({ service: entry.service, accountLabel: normalizedLabel }),
        })).connector as Connector | undefined;
      } catch (creationError) {
        // A connector row may have committed while its response was lost. Read
        // the caller-visible rows and recover only the exact personal draft.
        const snapshot = await request('/api/connectors');
        draft = exact(Array.isArray(snapshot.connectors) ? snapshot.connectors : []);
        if (!draft) throw creationError;
      }
    }
    if (!draft?.id) throw new Error(`connector_${authMode}_draft_missing`);
    setLocalDrafts(current => ({ ...current, [draftKey]: draft! }));
    return draft;
  };

  const beginOAuth = async (entry: ConnectorCatalogEntry) => {
    const normalizedLabel = normalizeAccountLabel(oauthLabels[entry.service]);
    if (!actionsAllowed || !profileReady(entry)
      || !canStartOAuthFor(entry) || !normalizedLabel) return;
    setBusy(`oauth:${entry.service}`);
    clearActionError(entry.service);
    try {
      const draft = await createOrRecoverDraft(entry, 'oauth', normalizedLabel);
      const connectorId = draft.id;
      const payload = await request(`/api/connectors/oauth-v2/${encodeURIComponent(entry.service)}/start`, {
        method: 'POST', body: JSON.stringify({ connectorId }),
      });
      navigateToConnectorAuthorization(payload.authorizeUrl);
    } catch (reason) {
      handleWriteError(entry.service, reason);
      setBusy(null);
    }
  };

  const savePersonalKey = async (entry: ConnectorCatalogEntry) => {
    const draftState = keyDrafts[entry.service];
    const normalizedLabel = normalizeAccountLabel(draftState?.accountLabel);
    const schema = credentialSchemaFor(entry);
    const fields = Object.fromEntries((schema?.fields ?? []).map(field => [
      field.id, draftState?.fields[field.id] ?? '',
    ]));
    const fieldsComplete = Boolean(schema && schema.fields.every(field => fields[field.id]?.length > 0));
    if (!actionsAllowed || !fieldsComplete || !normalizedLabel) return;
    setBusy(`key:${entry.service}`);
    clearActionError(entry.service);
    try {
      const draft = await createOrRecoverDraft(entry, 'key', normalizedLabel);
      const response = await request(`/api/connectors/grants/${encodeURIComponent(entry.service)}/api-key`, {
        method: 'PUT',
        body: JSON.stringify({
          connectorId: draft.id, ownership: 'personal',
          ...(entry.authMetadata?.submitSemantics?.credentialPayload === 'apiKey'
            ? { apiKey: fields.api_key }
            : entry.authMetadata?.submitSemantics?.credentialPayload === 'credentialFields'
              ? { credentialFields: fields } : {}),
          ...(draftState.acceptStoredUnverified
            && entry.authMetadata?.submitSemantics?.unverifiedConsentPayload !== 'none'
            ? { [entry.authMetadata!.submitSemantics!.unverifiedConsentPayload]: true } : {}),
          accountLabel: normalizedLabel,
        }),
      });
      setKeyDrafts(current => ({ ...current, [entry.service]: {
        accountLabel: '', fields: {}, acceptStoredUnverified: false,
      } }));
      setKeyService(null);
      const savedGrant = response.grant as Grant | undefined;
      const parsedGrant = parseGrant(savedGrant);
      if (parsedGrant?.verificationState === 'stored_unverified') {
        setNotice(copy('storedOnlyNotice', '{{name}} was encrypted but remains disabled until verification succeeds.', 'شُفّرت بيانات {{name}}، لكنها تظل معطلة حتى ينجح التحقق.').replace('{{name}}', platformName(entry)));
        await refresh();
        return;
      }
      if (!parsedGrant?.eligible
        || !['needs_reconciliation', 'available_next_session'].includes(parsedGrant.availabilityState)) {
        throw new Error('connector_grant_runtime_truth_invalid');
      }
      const placement = await request(`/api/connectors/${encodeURIComponent(draft.id)}/reconcile`, {
        method: 'POST', body: '{}',
      });
      if (placement.result?.state !== 'verified'
        || placement.connector?.availableNextSession !== true) {
        throw new Error('connector_distribution_not_verified');
      }
      setNotice(copy('linkedNotice', '{{name}} is linked for your eligible model bodies.', 'تم ربط {{name}} بكل أجسادك المؤهلة.').replace('{{name}}', platformName(entry)));
      await refresh();
    } catch (reason) {
      handleWriteError(entry.service, reason);
    } finally {
      setBusy(null);
    }
  };

  const reverifyGrant = async (grant: Grant) => {
    if (!actionsAllowed || !grant.canRetryVerification) return;
    setBusy(`verify:${grant.grantId}`);
    clearActionError(grant.grantId);
    try {
      await request(`/api/connectors/grants/${encodeURIComponent(grant.grantId)}/reverify`, {
        method: 'POST', body: '{}',
      });
      setNotice(copy('verificationRetried', 'Verification completed. Availability is shown from the server.', 'اكتمل التحقق، وتظهر الإتاحة كما يقررها الخادم.'));
      await refresh();
    } catch (reason) {
      handleWriteError(grant.grantId, reason);
    } finally {
      setBusy(null);
    }
  };

  const revokeGrant = async (grant: Grant) => {
    if (!actionsAllowed) return;
    setBusy(`revoke:${grant.grantId}`);
    clearActionError(grant.grantId);
    try {
      await request(`/api/connectors/grants/${encodeURIComponent(grant.grantId)}`, { method: 'DELETE' });
      setNotice(copy('removedNotice', 'The account was removed from future sessions.', 'أزيل الحساب من الجلسات القادمة.'));
      await refresh();
    } catch (reason) {
      handleWriteError(grant.grantId, reason);
    } finally {
      setBusy(null);
    }
  };

  const renderAccountAction = (entry: ConnectorCatalogEntry, oauthActionLabel?: string) => {
    if (!actionsAllowed) return null;
    const metadata = entry.authMetadata!;
    const ready = profileReady(entry);
    if (metadata.readiness === 'unsupported' || metadata.readiness === 'temporarily_unavailable') return null;
    if (metadata.method === 'api_key') {
      if (!ready) return null;
      const schema = credentialSchemaFor(entry);
      if (!schema) return null;
      if (keyService === entry.service) {
        const actionError = actionErrors[entry.service];
        const actionErrorId = `connector-action-error-${entry.service}`;
        const draft = keyDrafts[entry.service] ?? {
          accountLabel: '', fields: {}, acceptStoredUnverified: false,
        };
        const updateDraft = (change: Partial<KeyDraft>) => setKeyDrafts(current => ({
          ...current, [entry.service]: { ...draft, ...change },
        }));
        const updateField = (field: string, value: string) => updateDraft({
          fields: { ...draft.fields, [field]: value },
        });
        const storesWithoutVerification = metadata.canStoreUnverified === true;
        const fieldsComplete = schema.fields.every(field => (draft.fields[field.id] ?? '').length > 0);
        return (
          <div className="mt-3 space-y-3 border-t border-border pt-3" role="group" aria-label={copy('keyForm', 'Connect with an API key', 'الربط بمفتاح API')}>
            <label className="block text-sm font-medium" htmlFor={`connector-label-${entry.service}`}>{t('connectorsSettings.accountLabel')}</label>
            <Input id={`connector-label-${entry.service}`} value={draft.accountLabel} maxLength={128} aria-invalid={Boolean(actionError)} aria-describedby={actionError ? actionErrorId : undefined} onChange={event => updateDraft({ accountLabel: event.target.value })} />
            {schema.fields.map((field, index) => <div key={field.id} className="space-y-1.5">
              <label className="block text-sm font-medium" htmlFor={`connector-credential-${entry.service}-${field.id}`}>{field.label}</label>
              <Input ref={index === 0 ? keyInputRef : undefined} id={`connector-credential-${entry.service}-${field.id}`} dir="ltr" type={field.inputType} autoComplete={field.inputType === 'password' ? 'new-password' : 'off'} value={draft.fields[field.id] ?? ''} aria-invalid={Boolean(actionError)} aria-describedby={actionError ? actionErrorId : undefined} onChange={event => updateField(field.id, event.target.value)} />
            </div>)}
            <p className="text-[13px] text-muted-foreground">{t('connectorsSettings.keyStoredNote')}</p>
            {storesWithoutVerification && <label className="flex items-start gap-3 rounded-md bg-warning/5 p-3 text-sm">
              <input type="checkbox" className="mt-1 h-4 w-4" checked={draft.acceptStoredUnverified} onChange={event => updateDraft({ acceptStoredUnverified: event.target.checked })} />
              <span><strong className="block">{copy('storeWithoutEnabling', 'Save encrypted without enabling', 'حفظ مشفّر دون تفعيل')}</strong>{copy('storeWithoutEnablingHelp', 'This provider cannot be verified yet. The credential will not reach any model body until verification succeeds.', 'لا يمكن التحقق من هذه الخدمة بعد. لن تصل بيانات الاعتماد إلى أي جسد نموذج حتى ينجح التحقق.')}</span>
            </label>}
            <p className="text-[13px] text-muted-foreground">
              {copy('sessionNextNote', 'After linking, the tool reaches your next session, not the current one.', 'بعد الربط تصل الأداة إلى جلستك القادمة لا الحالية.')}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={!actionsAllowed || !fieldsComplete || !draft.accountLabel.trim() || (storesWithoutVerification && !draft.acceptStoredUnverified) || busy !== null} onClick={() => void savePersonalKey(entry)}>
                {busy === `key:${entry.service}` && <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />}
                {storesWithoutVerification ? copy('saveDisabled', 'Save without enabling', 'حفظ دون تفعيل') : t('connectorsSettings.connect')}
              </Button>
              <Button variant="ghost" onClick={() => {
                setKeyDrafts(current => ({ ...current, [entry.service]: {
                  accountLabel: '', fields: {}, acceptStoredUnverified: false,
                } }));
                setKeyService(null);
              }}>{t('connectorsSettings.cancel')}</Button>
            </div>
          </div>
        );
      }
      return (
        <Button variant="outline" onClick={() => {
          setKeyService(entry.service);
          requestAnimationFrame(() => keyInputRef.current?.focus());
        }}>
          <KeyRound className="me-2 h-4 w-4" aria-hidden="true" />{copy('addKey', 'Connect with key', 'ربط بمفتاح')}
        </Button>
      );
    }
    if (!ready) return null;
    if (oauthService === entry.service) {
      const actionError = actionErrors[entry.service];
      const actionErrorId = `connector-action-error-${entry.service}`;
      return (
        <div className="mt-3 space-y-3 border-t border-border pt-3" role="group" aria-label={copy('oauthForm', 'Name and link this account', 'سمّ هذا الحساب واربطه')}>
          <label className="block text-sm font-medium" htmlFor={`connector-oauth-label-${entry.service}`}>{t('connectorsSettings.accountLabel')}</label>
          <Input
            id={`connector-oauth-label-${entry.service}`}
            value={oauthLabels[entry.service] ?? ''}
            maxLength={128}
            aria-invalid={Boolean(actionError)}
            aria-describedby={actionError ? actionErrorId : undefined}
            onChange={event => setOauthLabels(current => ({ ...current, [entry.service]: event.target.value }))}
          />
          <p className="text-[13px] text-muted-foreground">
            {copy('sessionNextNote', 'After linking, the tool reaches your next session, not the current one.', 'بعد الربط تصل الأداة إلى جلستك القادمة لا الحالية.')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!oauthLabels[entry.service]?.trim() || busy !== null} onClick={() => void beginOAuth(entry)}>
              {busy === `oauth:${entry.service}` ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Link2 className="me-2 h-4 w-4" aria-hidden="true" />}
              {copy('continueSignIn', 'Continue to sign in', 'متابعة تسجيل الدخول')}
            </Button>
            <Button variant="ghost" onClick={() => {
              setOauthLabels(current => ({ ...current, [entry.service]: '' }));
              setOAuthService(null);
            }}>{t('connectorsSettings.cancel')}</Button>
          </div>
        </div>
      );
    }
    return (
      <Button variant="outline" disabled={!actionsAllowed || busy !== null} onClick={() => {
        setOauthLabels(current => ({ ...current, [entry.service]: '' }));
        setOAuthService(entry.service);
      }}>
        {busy === `oauth:${entry.service}` ? <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <Link2 className="me-2 h-4 w-4" aria-hidden="true" />}
        {oauthActionLabel ?? copy('signIn', 'Sign in', 'تسجيل الدخول')}
      </Button>
    );
  };

  const renderGroup = ([groupId, entries]: [string, ConnectorCatalogEntry[]]) => {
    const google = groupId === 'google-workspace';
    const title = google ? GOOGLE_WORKSPACE_TITLE : platformName(entries[0]);
    const groupGrants = [...new Map(entries.flatMap(entry => grantsByService.get(entry.service) ?? [])
      .map(grant => [grant.grantId, grant])).values()];
    return (
      <article key={groupId} className="py-4 first:pt-0 last:pb-0">
        <div className="flex min-w-0 items-start gap-3">
          {serviceLogo(entries[0]) ? <img src={serviceLogo(entries[0])!} alt="" className="h-10 w-10 rounded-lg object-contain" /> : <div className="grid h-10 w-10 place-items-center rounded-lg bg-muted"><Link2 className="h-5 w-5" aria-hidden="true" /></div>}
          <div className="min-w-0 flex-1">
            <h4 className="font-semibold text-foreground">{title}</h4>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {google
                ? copy('googleSummary', 'One Google account, with each Workspace service granted only when you choose it.', 'حساب Google واحد، ولا تُمنح كل خدمة في Workspace إلا عندما تختارها.')
                : t(`connectorsSettings.platforms.${entries[0].service}.summary`, { defaultValue: entries[0].summary })}
            </p>
          </div>
        </div>
        <div className={cn('mt-4', google ? 'space-y-2' : '')}>
          {entries.map(entry => {
            // Google is one account bundle, not three provider cards. The
            // services remain explicit scopes inside that single row.
            if (google && entry !== entries[0]) return null;
            const serviceGrants = google ? groupGrants : grantsByService.get(entry.service) ?? [];
            const linked = serviceGrants.filter(isConnected);
            const accountGrants = serviceGrants;
            const statusLabel = (grant: Grant): string => {
              if (isConnected(grant)) return copy('availableNextSession', 'Connected · available next session', 'متصل · متاح في الجلسة القادمة');
              switch (grant.availabilityState) {
                case 'stored_only': return copy('storedOnly', 'Saved encrypted · not enabled', 'محفوظ مشفّرًا · غير مفعّل');
                case 'needs_reconciliation': return copy('needsReconciliation', 'Verified · preparing model bodies', 'تم التحقق · جارٍ تجهيز أجساد النماذج');
                case 'verification_expired': return copy('verificationExpired', 'Verification expired · not enabled', 'انتهت صلاحية التحقق · غير مفعّل');
                case 'credential_rejected': return copy('credentialRejected', 'Credential rejected · not enabled', 'رُفضت بيانات الاعتماد · غير مفعّل');
                case 'credential_corrupt': return copy('credentialCorrupt', 'Stored credential is unreadable · remove it', 'بيانات الاعتماد المخزنة غير قابلة للقراءة · أزلها');
                case 'temporarily_unavailable': return copy('verificationUnavailable', 'Verification temporarily unavailable · not enabled', 'التحقق غير متاح مؤقتًا · غير مفعّل');
                default:
                  if (grant.reasonCode === 'policy_disabled') return copy('policyDisabled', 'Disabled by this installation’s connector policy', 'معطّل وفق سياسة الموصلات في هذا التثبيت');
                  if (grant.reasonCode === 'grant_inactive') return copy('grantInactive', 'Account is inactive', 'الحساب غير نشط');
                  if (grant.reasonCode === 'no_credential') return copy('credentialMissing', 'Credential is missing · reconnect required', 'بيانات الاعتماد مفقودة · يلزم إعادة الربط');
                  return copy('notAvailable', 'Not available to models', 'غير متاح للنماذج المتصلة');
              }
            };
            return (
              <div key={entry.service} className={cn('border-t border-border py-3 first:border-t-0', google && 'ps-2')}>
                {google && <div className="mb-3 flex min-h-11 flex-wrap items-center justify-between gap-3"><ul className="flex flex-wrap gap-2" aria-label={copy('googleServices', 'Google Workspace services', 'خدمات Google Workspace')}>{entries.map(service => <li key={service.service} className="rounded-full bg-muted px-2.5 py-1 text-[13px] font-medium">{platformName(service)}</li>)}</ul>{serviceGrants.length > 0 && <span className="inline-flex items-center gap-1 text-[13px] text-success"><Check className="h-4 w-4" aria-hidden="true" />{linked.length > 0 ? copy('ready', 'Ready', 'جاهز') : copy('linked', 'Linked', 'مربوط')}</span>}</div>}
                {accountGrants.map(grant => (
                  <div key={grant.grantId} className="mb-2 flex flex-wrap items-center justify-between gap-3 bg-muted px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{grant.accountLabel}</div>
                      {google && <div className="text-[13px] text-muted-foreground">{grant.grantedServices.map(serviceId => {
                        const serviceEntry = entries.find(item => item.service === serviceId);
                        return serviceEntry ? platformName(serviceEntry) : serviceId;
                      }).join(' · ')}</div>}
                      {grant.verificationState === 'stored_unverified'
                        ? <StatusBadge tone="warning" className="mt-1"><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />{statusLabel(grant)}</StatusBadge>
                        : <div className={cn('text-[13px]', isConnected(grant) ? 'text-success' : grant.verificationState === 'corrupt' || grant.verificationState === 'rejected' ? 'text-danger' : 'text-muted-foreground')}>{statusLabel(grant)}</div>}
                      {grant.availableBodies.length > 0 && <div className="mt-1 text-[13px] text-muted-foreground">{copy('availableBodies', 'Available models:', 'النماذج المتاحة:')} {grant.availableBodies.join(', ')}</div>}
                      {grant.pendingBodies.length > 0 && <div className="mt-1 text-[13px] text-muted-foreground">{copy('pendingBodies', 'Pending models:', 'النماذج قيد التجهيز:')} {grant.pendingBodies.join(', ')}</div>}
                      {actionErrors[grant.grantId] && <p role="alert" className="mt-1 text-[13px] text-danger"><AlertCircle className="me-1 inline h-3.5 w-3.5" aria-hidden="true" />{actionErrors[grant.grantId]}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1">
                      {grant.canRetryVerification && <Button variant="ghost" aria-label={`${copy('reverify', 'Verify again', 'إعادة التحقق')}: ${grant.accountLabel} — ${title}`} disabled={!actionsAllowed || busy !== null} onClick={() => void reverifyGrant(grant)}>{busy === `verify:${grant.grantId}` && <Loader2 className="me-2 h-4 w-4 animate-spin" />}{copy('reverify', 'Verify again', 'إعادة التحقق')}</Button>}
                      {grant.canReconnect && <Button variant="ghost" aria-label={`${copy('reconnect', 'Reconnect', 'إعادة الربط')}: ${grant.accountLabel} — ${title}`} disabled={!actionsAllowed || busy !== null} onClick={() => {
                        const reconnectEntry = entries.find(item => item.service === grant.serviceId) ?? entry;
                        if (reconnectEntry.authMetadata?.method === 'api_key') {
                          setKeyDrafts(current => ({ ...current, [reconnectEntry.service]: {
                            accountLabel: grant.accountLabel, fields: {}, acceptStoredUnverified: false,
                          } }));
                          setKeyService(reconnectEntry.service);
                        } else {
                          setOauthLabels(current => ({ ...current, [reconnectEntry.service]: grant.accountLabel }));
                          setOAuthService(reconnectEntry.service);
                        }
                      }}>{copy('reconnect', 'Reconnect', 'إعادة الربط')}</Button>}
                      {grant.canRemove && <Button variant="ghost" size="icon" aria-label={`${copy('removeAccount', 'Remove account', 'إزالة الحساب')}: ${grant.accountLabel} — ${title}`} disabled={!actionsAllowed || busy !== null} onClick={() => void revokeGrant(grant)}>
                        {busy === `revoke:${grant.grantId}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                      </Button>}
                    </div>
                  </div>
                ))}
                {!google && renderAccountAction(entry)}
                {google && renderAccountAction(entry, copy('addAccount', 'Add account', 'إضافة حساب'))}
                {actionErrors[entry.service] && <p id={`connector-action-error-${entry.service}`} role="alert" className="mt-2 text-sm text-danger"><AlertCircle className="me-1 inline h-4 w-4" aria-hidden="true" />{actionErrors[entry.service]}</p>}
              </div>
            );
          })}
        </div>
      </article>
    );
  };

  const groupHasVisibleAccount = (entries: ConnectorCatalogEntry[]): boolean =>
    entries.some(entry => (grantsByService.get(entry.service) ?? []).length > 0);
  const unavailable = grouped.filter(([, entries]) =>
    entries.every(entry => !profileReady(entry)) && !groupHasVisibleAccount(entries));

  return (
    <SettingsSection
      title={t('connectorsSettings.title')}
      description={copy('description', 'Connect each account once. Every eligible model body in your sessions receives the same tools.', 'اربط كل حساب مرة واحدة، فتستفيد منه جميع أجساد النماذج المؤهلة في جلساتك.')}
      icon={Link2}
      tone="info"
      level="section"
    >
      {/* Screen-reader-only live region for operation confirmations */}
      <div aria-live="polite" className="sr-only">{notice}</div>

      {/* Visible operation confirmation — shown alongside the sr-only region */}
      {notice && (
        <div role="status" className="flex items-start gap-2 rounded-lg border border-success/30 bg-success/5 p-3 text-sm text-success">
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{notice}</span>
        </div>
      )}

      {/* ── Diagnostic panel — visible to all (owner sees actions, member sees read-only reason) ── */}
      {(() => {
        const effectiveGrantsDisabled =
          grantsErrorCode === 'CONNECTOR_GRANTS_DISABLED'
          || readinessErrorCode === 'CONNECTOR_GRANTS_DISABLED';
        const authExpired =
          readinessErrorCode === 'AUTH_REQUIRED' || grantsErrorCode === 'AUTH_REQUIRED';

        if (effectiveGrantsDisabled) {
          return (
            <div role="status" className="rounded-lg border border-border bg-muted p-4 text-sm">
              <p className="font-medium text-foreground">
                {isOwner
                  ? copy('grantDisabledOwner', 'Connectors are not enabled on this installation. Use the "Installation setup" tab below to configure.', 'ميزة الموصلات غير مُفعَّلة على هذا التثبيت. استخدم تبويب «تهيئة المشغّل» أدناه للإعداد.')
                  : copy('grantDisabledMember', 'Connectors are not available — contact your platform operator.', 'الموصلات غير متاحة على هذا التثبيت — تواصل مع مشغّل المنصّة.')}
              </p>
            </div>
          );
        }

        if (readinessErrorCode === 'CONNECTOR_AUTH_NOT_CONFIGURED'
          || readinessErrorCode === 'CONNECTOR_AUTH_BOOTSTRAP_UNAVAILABLE') {
          return (
            <div role="status" className="rounded-lg border border-border bg-muted p-4 text-sm">
              <p className="font-medium text-foreground">
                {isOwner
                  ? copy('notConfiguredOwner', 'Connector authentication isn\'t configured on the server yet. Use the "Installation setup" tab below to configure.', 'لم تُضبط مصادقة الموصلات بعد على الخادم. استخدم تبويب «تهيئة المشغّل» أدناه للإعداد.')
                  : copy('notConfiguredMember', 'Connectors are not available yet — awaiting operator setup.', 'الموصلات غير متاحة بعد — بانتظار تهيئة المشغّل.')}
              </p>
            </div>
          );
        }

        if (readinessErrorCode === 'CONNECTOR_ORIGIN_REJECTED') {
          return (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{copy('originRejected', "This access origin doesn't match the installation's canonical origin.", 'عنوان الوصول الحالي لا يطابق العنوان المعتمد لهذا التثبيت.')}</span>
            </div>
          );
        }

        if (recentAuthRequired) {
          return (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 text-sm text-warning">
              <span>
                {authExpired
                  ? copy('sessionExpired', 'Your session has ended. Sign in to continue.', 'انتهت جلستك. سجّل الدخول للمتابعة.')
                  : copy('reauthRequired', 'Sign in again before linking or changing connector accounts.', 'مضى وقت على دخولك؛ سجّل الدخول مجدداً قبل ربط حسابات الموصلات أو تغييرها.')}
              </span>
              <Button variant="outline" onClick={() => auth?.logout()}>
                {copy('signInAgain', 'Sign in again', 'تسجيل الدخول مجددًا')}
              </Button>
            </div>
          );
        }

        if (error || loadError || grantsLoadFailed) {
          return (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
              <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{error ?? copy('loadFailed', 'Connector data could not be loaded.', 'تعذر تحميل بيانات الموصلات.')}</span>
              {grantsLoadFailed && (
                <Button variant="outline" onClick={() => void refresh()}>
                  {copy('retryAccounts', 'Retry', 'إعادة المحاولة')}
                </Button>
              )}
            </div>
          );
        }

        if (readinessErrorCode) {
          return (
            <div role="status" className="rounded-lg border border-border bg-muted p-3 text-sm text-muted-foreground">
              {copy('unexpectedError', 'An unexpected server response was received', 'استجابة غير متوقعة من الخادم')}
              {' '}(<code dir="ltr" className="font-mono text-sm">{readinessErrorCode}</code>)
            </div>
          );
        }

        return null;
      })()}

      {isOwner && (
        <div className="grid grid-cols-2 rounded-lg border border-primary/20 bg-primary/5 p-1" role="tablist" aria-label={copy('viewLabel', 'Connector view', 'عرض الموصلات')}>
          <button id="connector-view-accounts" type="button" role="tab" aria-controls="connector-view-panel" aria-selected={view === 'accounts'} tabIndex={view === 'accounts' ? 0 : -1} className={cn('min-h-11 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', view === 'accounts' && 'bg-background shadow-sm')} onKeyDown={moveViewFocus} onClick={() => setView('accounts')}>{copy('myAccounts', 'My accounts', 'حساباتي')}</button>
          <button id="connector-view-installation" type="button" role="tab" aria-controls="connector-view-panel" aria-selected={view === 'installation'} tabIndex={view === 'installation' ? 0 : -1} className={cn('inline-flex min-h-11 items-center justify-center rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', view === 'installation' && 'bg-background shadow-sm')} onKeyDown={moveViewFocus} onClick={() => setView('installation')}><ShieldCheck className="me-2 h-4 w-4 text-primary" aria-hidden="true" />{copy('installation', 'Installation setup', 'تهيئة المشغّل')}</button>
        </div>
      )}

      {view === 'accounts' ? (
        <div id="connector-view-panel" role={isOwner ? 'tabpanel' : undefined} aria-labelledby={isOwner ? 'connector-view-accounts' : undefined} className="space-y-6">
          {(!grantsKnown && !grantsLoadFailed) || (loading && grants.length === 0) ? <div className="flex min-h-24 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" aria-label={t('connectorsSettings.loading')} /></div> : grantsLoadFailed ? null : (
            <>
              {connectedGroups.length > 0 && <section aria-labelledby="connector-linked-heading"><h3 id="connector-linked-heading" className="mb-3 text-lg font-semibold">{t('connectorsSettings.connected')}</h3><div className="space-y-4">{connectedGroups.map(renderGroup)}</div></section>}
              {availableGroups.some(([, entries]) => entries.some(profileReady) || groupHasVisibleAccount(entries)) && <section aria-labelledby="connector-add-heading"><h3 id="connector-add-heading" className="mb-3 text-lg font-semibold">{t('connectorsSettings.addPlatform')}</h3><div className="space-y-4">{availableGroups.filter(([, entries]) => entries.some(profileReady) || groupHasVisibleAccount(entries)).map(renderGroup)}</div></section>}
              {isOwner && unavailable.length > 0 && (() => {
                const count = unavailable.reduce((sum, [, entries]) => sum + entries.length, 0);
                const summary = count === 1
                  ? copy('unavailableSummaryOne', '1 service is not ready on this installation', 'خدمة واحدة غير جاهزة في هذا التثبيت')
                  : copy('unavailableSummaryMany', '{{count}} services are not ready on this installation', '{{count}} خدمة غير جاهزة في هذا التثبيت').replace('{{count}}', String(count));
                return <details className="rounded-lg border border-border bg-muted"><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{summary}<ChevronDown className="h-4 w-4" aria-hidden="true" /></summary><ul className="space-y-1 border-t border-border px-4 py-3 text-sm text-muted-foreground">{unavailable.flatMap(([, entries]) => entries).map(entry => <li key={entry.service}>{platformName(entry)}{entry.authMetadata?.readiness === 'unsupported' ? ` — ${copy('unsupported', 'Not supported', 'غير مدعوم')}` : ''}</li>)}</ul></details>;
              })()}
            </>
          )}
        </div>
      ) : isOwner ? (
        <div id="connector-view-panel" role="tabpanel" aria-labelledby="connector-view-installation">
          <ConnectorOwnerSetupWizard owner={isOwner} csrfToken={csrfToken}
            language={i18n.language} onReadyChange={() => void refresh()} />
        </div>
      ) : null}
    </SettingsSection>
  );
}
