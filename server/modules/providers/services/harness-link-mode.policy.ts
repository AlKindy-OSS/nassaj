/**
 * harness-link-mode.policy — ADR-200 S4, the pure half of the link-mode model:
 * record shape, the H1 upgrade default, and the M4 / M-3 status (chosen mode
 * beside effective mode, plus drift warnings). No I/O lives here, so every
 * rule is unit-testable on plain objects.
 */

import type {
  EffectiveLinkMode,
  HarnessCredentialInventory,
  LinkHarness,
} from './harness-credential-inventory.js';

export type LinkMode = 'subscription' | 'api_key';

/** Who set the stored mode: the H1 derivation, the user, or a setup-token save. */
export type LinkModeSource = 'derived' | 'user' | 'setup_token';

export type LinkModeRecord = {
  v: 1;
  mode: LinkMode;
  source: LinkModeSource;
  updatedAt: string;
  /** Fingerprint of the key nassaj itself projected into this harness, if any. */
  projection: { fp: string; keyVersion: number } | null;
  /** Fingerprint of the subscription login seen at the last mode or key change. */
  subscriptionFp: string | null;
};

/**
 * `managed` = nassaj's own projection; `adopted` = a key the migration took over
 * (ADR-200 §2: replaceable, removed only on confirm, never `foreign`);
 * `foreign` = any other key nassaj did not write.
 */
export type LinkKeyState = 'none' | 'managed' | 'adopted' | 'foreign';

/** ADR-200 S6: the ledger's `adopted` entry for this harness, as a fingerprint only. */
export type AdoptedProjection = { fp: string; keyVersion: number } | null;

export type LinkModeWarning =
  /** The chosen mode is not what the CLI runs on. */
  | 'effective_mode_mismatch'
  /** A subscription login appeared after the key projection (M-3). */
  | 'fresh_subscription_login'
  /** A foreign key in a subscription-mode harness: «الفوترة الفعلية الآن بالمفتاح». */
  | 'foreign_key_billing'
  /** H1 "both": the default is the key that runs today, and a subscription also exists. */
  | 'subscription_also_present'
  /** No mode chosen yet and nothing to derive one from: the UI asks. */
  | 'mode_unset'
  /** B-1547: the stored record exists but cannot be read; runs are refused until it is re-chosen. */
  | 'record_unreadable';

export type LinkModeStatus = {
  provider: LinkHarness;
  enabled: true;
  chosenMode: LinkMode | null;
  chosenModeSource: LinkModeSource | null;
  effectiveMode: EffectiveLinkMode;
  /** Whether the chosen mode has a credential behind it (D6: a key-mode harness without a key is unlinked). */
  linkState: 'linked' | 'unlinked';
  credentials: { key: LinkKeyState; subscription: boolean };
  warnings: LinkModeWarning[];
  /** Members running on this tree through an accepted grant (H6). */
  granteeCount: number;
};

export type Fingerprint = (value: string, keyVersion?: number) => string;

const LINK_MODES: readonly string[] = ['subscription', 'api_key'];
const SOURCES: readonly string[] = ['derived', 'user', 'setup_token'];

/** Validates a decrypted record; anything malformed reads as "no record". */
export function normalizeLinkModeRecord(raw: unknown): LinkModeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (!LINK_MODES.includes(value.mode as string) || !SOURCES.includes(value.source as string)) return null;
  const projection = value.projection as Record<string, unknown> | null | undefined;
  const validProjection = projection
    && typeof projection.fp === 'string'
    && Number.isInteger(projection.keyVersion)
    ? { fp: projection.fp, keyVersion: projection.keyVersion as number }
    : null;
  return {
    v: 1,
    mode: value.mode as LinkMode,
    source: value.source as LinkModeSource,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    projection: validProjection,
    subscriptionFp: typeof value.subscriptionFp === 'string' ? value.subscriptionFp : null,
  };
}

/**
 * H1: the upgrade default is the EFFECTIVE mode under the CLI's own precedence,
 * so no member's billing changes on upgrade. none → unset; OAuth only →
 * subscription; key only → api_key; both → whatever runs today.
 */
export function deriveDefaultLinkMode(inventory: HarnessCredentialInventory): LinkMode | null {
  if (inventory.effective !== 'none') return inventory.effective;
  if (inventory.hasSubscription) return 'subscription';
  if (inventory.managedKey || inventory.unmanagedKeySource) return 'api_key';
  return null;
}

/** Whether the on-disk managed key is the one nassaj projected. */
export function isOwnProjection(
  inventory: HarnessCredentialInventory,
  record: LinkModeRecord | null,
  fingerprint: Fingerprint,
): boolean {
  if (!inventory.managedKey || !record?.projection) return false;
  return fingerprint(inventory.managedKey, record.projection.keyVersion) === record.projection.fp;
}

/** Whether the on-disk managed key is the one the migration adopted (ADR-200 S6, G2). */
export function isAdoptedKey(
  inventory: HarnessCredentialInventory,
  adopted: AdoptedProjection,
  fingerprint: Fingerprint,
): boolean {
  if (!inventory.managedKey || !adopted) return false;
  return fingerprint(inventory.managedKey, adopted.keyVersion) === adopted.fp;
}

/** Who owns the on-disk key; an adopted key is checked first, so it is never `managed`. */
export function classifyKey(
  inventory: HarnessCredentialInventory,
  record: LinkModeRecord | null,
  fingerprint: Fingerprint,
  adopted: AdoptedProjection = null,
): LinkKeyState {
  if (inventory.unmanagedKeySource) return 'foreign';
  if (!inventory.managedKey) return 'none';
  if (isAdoptedKey(inventory, adopted, fingerprint)) return 'adopted';
  return isOwnProjection(inventory, record, fingerprint) ? 'managed' : 'foreign';
}

/** Fingerprint of the current subscription login, or null when none exists. */
export function subscriptionFingerprint(
  inventory: HarnessCredentialInventory,
  fingerprint: Fingerprint,
): string | null {
  return inventory.subscriptionIdentity ? fingerprint(inventory.subscriptionIdentity) : null;
}

function isFreshLogin(
  inventory: HarnessCredentialInventory,
  record: LinkModeRecord,
  fingerprint: Fingerprint,
): boolean {
  const current = subscriptionFingerprint(inventory, fingerprint);
  return current !== null && current !== record.subscriptionFp;
}

/** M4 / M-3 drift warnings for one harness. */
export function buildLinkModeWarnings(
  inventory: HarnessCredentialInventory,
  record: LinkModeRecord | null,
  keyState: LinkKeyState,
  fingerprint: Fingerprint,
): LinkModeWarning[] {
  if (!record) return ['mode_unset'];
  const warnings: LinkModeWarning[] = [];
  if (inventory.effective !== 'none' && inventory.effective !== record.mode) {
    warnings.push('effective_mode_mismatch');
  }
  // An adopted key bills exactly like a foreign one; only its ownership differs.
  const notOwn = keyState === 'foreign' || keyState === 'adopted';
  if (record.mode === 'subscription' && notOwn && inventory.effective === 'api_key') {
    warnings.push('foreign_key_billing');
  }
  if (record.mode === 'api_key' && keyState !== 'none' && isFreshLogin(inventory, record, fingerprint)) {
    warnings.push('fresh_subscription_login');
  }
  if (record.mode === 'api_key' && record.source === 'derived' && inventory.hasSubscription) {
    warnings.push('subscription_also_present');
  }
  return warnings;
}

/** Composes the status the link-mode API returns. */
export function buildLinkModeStatus(
  inventory: HarnessCredentialInventory,
  record: LinkModeRecord | null,
  granteeCount: number,
  fingerprint: Fingerprint,
  adopted: AdoptedProjection = null,
): LinkModeStatus {
  const keyState = classifyKey(inventory, record, fingerprint, adopted);
  const linked = record?.mode === 'api_key' ? keyState !== 'none' : record?.mode === 'subscription'
    ? inventory.hasSubscription
    : false;
  return {
    provider: inventory.harness,
    enabled: true,
    chosenMode: record?.mode ?? null,
    chosenModeSource: record?.source ?? null,
    effectiveMode: inventory.effective,
    linkState: linked ? 'linked' : 'unlinked',
    credentials: { key: keyState, subscription: inventory.hasSubscription },
    warnings: buildLinkModeWarnings(inventory, record, keyState, fingerprint),
    granteeCount,
  };
}
