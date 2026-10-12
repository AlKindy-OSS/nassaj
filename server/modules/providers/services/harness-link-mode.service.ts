/**
 * harness-link-mode.service — ADR-200 S4 (in-flag `NASSAJ_UNIFIED_VENDOR_KEYS`):
 * the per-(user, harness) link mode for Claude and Codex, and the structural
 * billing guard (C3, M-3).
 *
 *   - **Single choke point.** `guardKeyWrite` wraps every Claude/Codex key write
 *     made through `providerCredentialsService.setKey` (fan-out, company route,
 *     legacy route). A key write into a `subscription` (or still-unset) harness
 *     is refused with 409 `LINK_MODE_SUBSCRIPTION` (`LINK_MODE_UNSET`), whatever
 *     the caller's options say. The legacy `/:provider/api-key` route is
 *     read-only for keys: 409 `LEGACY_KEY_ROUTE_READ_ONLY` in `api_key` mode.
 *   - **Lock.** One in-process lock per (user, harness) spans "read mode → write
 *     or remove projection → update record", so a mode switch and a key save can
 *     never interleave. The server is one process; the Codex writer keeps its own
 *     cross-process file lock underneath.
 *   - **Mode switch.** Switching to `api_key` is the only way the canonical key
 *     reaches the harness; the subscription is never touched unless the caller
 *     asks (`removeSetupToken`, Claude only, settings.json token only — C2).
 *     Switching to `subscription` removes only the projection nassaj wrote,
 *     matched by fingerprint; a foreign key is removed only on explicit confirm.
 *     A key the migration adopted (ledger `origin: adopted`, ADR-200 S6) is not
 *     foreign: a key save may replace it, but removal still needs the confirm.
 *     Every key a switch writes or removes is mirrored in the vendor ledger
 *     under the same lock (B-1574), so a later vendor delete owns it.
 *   - **Grants (H6, D9).** Grantees run on the grantor's tree, so the grantor's
 *     mode applies to them: the switch reports how many, and grants continue.
 *
 * With the flag off every entry point is a pass-through or refuses, so behaviour
 * is unchanged. No key value is ever logged, returned or put in an error.
 */

import { isClaudeSubscriptionToken } from '@/modules/providers/shared/credentials/subscription-token-guard.js';
import type { ProviderCredentialStatus } from '@/shared/interfaces.js';
import { PROVIDER_SECRETS_STORE_REPAIR_MESSAGE } from '@/services/isolation/provider-secrets-store.codes.js';
import { isProviderSecretsStoreUnreadable } from '@/services/isolation/provider-secrets-store.errors.js';
import { AppError } from '@/shared/utils.js';

import type { HarnessCredentialInventory, LinkHarness } from './harness-credential-inventory.js';
import {
  buildLinkModeStatus,
  classifyKey,
  deriveDefaultLinkMode,
  isAdoptedKey,
  isOwnProjection,
  type AdoptedProjection,
  subscriptionFingerprint,
  type Fingerprint,
  type LinkMode,
  type LinkModeRecord,
  type LinkModeStatus,
} from './harness-link-mode.policy.js';

/** Where a key write came from; only the legacy route is read-only for keys. */
export type KeyWriteOrigin = 'legacy_route' | 'company_route' | 'fanout';

export type KeyWriteOptions = {
  origin: KeyWriteOrigin;
  /** Explicit confirmation to overwrite a key nassaj did not write (G1 M-5). */
  replaceForeignKey?: boolean;
};

export type LinkModeWriter = {
  setApiKey(
    userId: string | number | null | undefined,
    apiKey: string,
    target?: string,
    authenticatedPrincipal?: unknown,
  ): Promise<ProviderCredentialStatus>;
  deleteApiKey(userId: string | number | null | undefined, target?: string): Promise<ProviderCredentialStatus>;
  deleteSubscriptionToken?(userId: string | number | null | undefined): Promise<ProviderCredentialStatus>;
};

/**
 * B-1547: a stored record's read state. `unreadable` (tampered envelope, wrong
 * server key, corrupt keys file, invalid payload) is never "absent": the run
 * gate refuses it and no path derives or overwrites it without confirmation.
 * `store: true` = the whole keys file is unreadable, so no switch can repair it
 * (every store write is refused); only an operator can.
 */
export type LinkModeRecordState =
  | { state: 'absent' }
  | { state: 'unreadable'; store?: boolean }
  | { state: 'ok'; record: LinkModeRecord };

export type LinkModeAuditContext = { ipAddress?: string | null; userAgent?: string | null };

export type LinkModeDeps = {
  isEnabled(): boolean;
  readInventory(userId: string | number | null | undefined, harness: LinkHarness): HarnessCredentialInventory;
  readRecordState(userId: string | number | null | undefined, harness: LinkHarness): LinkModeRecordState;
  writeRecord(userId: string | number | null | undefined, harness: LinkHarness, record: LinkModeRecord): void;
  fingerprint: Fingerprint;
  keyVersion: number;
  readCanonicalKey(userId: string | number | null | undefined, harness: LinkHarness): string | null;
  resolveWriter(harness: LinkHarness): LinkModeWriter | null;
  /**
   * Whose credential tree a write by `userId` lands in: the member when the
   * harness is isolated, `null` (the operator) when it is shared (G1 H-1). The
   * record, the lock and the grantee count all follow the TREE, not the caller.
   */
  treeOwner(userId: string | number | null | undefined, harness: LinkHarness): string | number | null;
  countGrantees(ownerId: string | number | null | undefined, harness: LinkHarness): number;
  /**
   * ADR-200 S6 (G2): the vendor ledger's `adopted` entry for this tree's
   * harness file, so a key the migration took over is not reported `foreign`.
   * Optional: absent means no ledger is consulted.
   */
  adoptedProjection?(ownerId: string | number | null | undefined, harness: LinkHarness): AdoptedProjection;
  /**
   * B-1574: the vendor ledger entry of this tree's harness file, kept in step
   * with the key a switch writes or removes, so a later vendor delete owns it.
   * Optional: absent means no ledger is kept (tests with plain fakes).
   */
  projectionLedger?: ProjectionLedgerPort;
  audit(userId: string | number | null | undefined, metadata: Record<string, unknown>, context?: LinkModeAuditContext): void;
  now(): Date;
};

/** B-1574: the ledger side of a switch's own projection writes; fingerprints only. */
export type ProjectionLedgerPort = {
  /** Throws the typed store 409 when the ledger cannot be read; called before any file write. */
  assertWritable(ownerId: string | number | null | undefined, harness: LinkHarness): void;
  /** nassaj wrote the key with this fingerprint into the harness file. */
  recordWritten(
    ownerId: string | number | null | undefined,
    harness: LinkHarness,
    projection: { fp: string; keyVersion: number },
  ): void;
  /**
   * B-1575: nassaj wrote the key but `recordWritten` failed; the entry is kept
   * as `failed` so the sweep re-verifies it (the file already holds the key).
   */
  recordFailed(
    ownerId: string | number | null | undefined,
    harness: LinkHarness,
    projection: { fp: string; keyVersion: number },
  ): void;
  /** nassaj removed the key from the harness file. */
  recordRemoved(ownerId: string | number | null | undefined, harness: LinkHarness): void;
};

export type SwitchLinkModeInput = {
  mode: unknown;
  confirm?: unknown;
  /** Remove a key nassaj did not write (subscription switch only). */
  removeForeignKey?: unknown;
  /** Claude only: also remove the settings.json setup-token (api_key switch only). */
  removeSetupToken?: unknown;
  authenticatedPrincipal?: unknown;
  auditContext?: LinkModeAuditContext;
};

export type SwitchLinkModeOutcome =
  | 'unchanged'
  | 'linked'
  | 'awaiting_key'
  | 'foreign_credential'
  /** ADR-200 §2: an adopted key stays until the user confirms its removal. */
  | 'adopted_credential'
  | 'key_removed'
  | 'foreign_key_removed'
  | 'no_key';

export type SwitchLinkModeResult = {
  provider: LinkHarness;
  previousMode: LinkMode | null;
  mode: LinkMode;
  outcome: SwitchLinkModeOutcome;
  setupTokenRemoved: boolean;
  granteeCount: number;
  status: LinkModeStatus;
};

const LINK_HARNESSES: readonly string[] = ['claude', 'codex'];

/** True for a harness with a subscription/API-key choice (Antigravity and OpenCode have none). */
export function isLinkModeHarness(provider: string): provider is LinkHarness {
  return LINK_HARNESSES.includes(provider);
}

function linkModeError(code: string, message: string, details?: Record<string, unknown>): AppError {
  return new AppError(message, { code, statusCode: 409, details });
}

/** Typed refusal of an unreadable link-mode record (B-1547). */
export const LINK_MODE_RECORD_UNREADABLE = 'LINK_MODE_RECORD_UNREADABLE';

/**
 * Generic, credential-free: details carry the provider only, never the cause.
 * A bad entry is repairable by the user (a confirmed switch replaces it); a
 * corrupt keys file is not (every store write is refused), so that case says
 * so instead of sending the user to a switch that cannot succeed (B-1547 M2).
 */
function recordUnreadableError(harness: LinkHarness, store = false): AppError {
  return store
    ? linkModeError(LINK_MODE_RECORD_UNREADABLE, PROVIDER_SECRETS_STORE_REPAIR_MESSAGE,
      { provider: harness, operatorRepair: true })
    : linkModeError(LINK_MODE_RECORD_UNREADABLE,
      'The saved link mode for this harness cannot be read. Choose the link mode again before running it.',
      { provider: harness });
}

/** Serialises async work per key; a failed operation releases the key too. */
export function createKeyedLock(): <T>(key: string, operation: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

function lockKey(userId: string | number | null | undefined, harness: LinkHarness): string {
  return `${userId === null || userId === undefined || userId === '' ? '__operator__' : String(userId)}:${harness}`;
}

function parseLinkMode(value: unknown): LinkMode {
  if (value === 'subscription' || value === 'api_key') return value;
  throw new AppError('`mode` must be "subscription" or "api_key".', {
    code: 'INVALID_LINK_MODE', statusCode: 400,
  });
}

/** Refuses an API-key write that the stored mode does not allow (C3). */
function assertKeyWritable(record: LinkModeRecord | null, origin: KeyWriteOrigin): void {
  if (record?.mode === 'subscription') {
    throw linkModeError('LINK_MODE_SUBSCRIPTION',
      'This harness is linked by subscription. Switch it to API-key mode before a key can reach it.');
  }
  if (!record) {
    throw linkModeError('LINK_MODE_UNSET', 'Choose a link mode for this harness before saving a key.');
  }
  if (origin === 'legacy_route') {
    throw linkModeError('LEGACY_KEY_ROUTE_READ_ONLY',
      'Keys for this harness are managed from the vendor key and the link mode.');
  }
}

type SwitchContext = {
  userId: string | number | null | undefined;
  harness: LinkHarness;
  inventory: HarnessCredentialInventory;
  record: LinkModeRecord | null;
  /** The stored record could not be read; the switch replaces it only on confirm (B-1547). */
  recordUnreadable: boolean;
  input: SwitchLinkModeInput;
  writer: LinkModeWriter;
  /** The ledger's adopted fingerprint for this harness (ADR-200 S6, G2). */
  adopted: AdoptedProjection;
};

/**
 * B-1575: the key is already in the file, so a failed ledger write is retried
 * once and then recorded as a `failed` entry the sweep heals; the switch is not
 * rolled back (a rollback could not restore a value nassaj never held). When
 * even that mark fails, the original error is thrown.
 */
function recordProjectionWritten(
  ledger: ProjectionLedgerPort,
  owner: string | number | null,
  harness: LinkHarness,
  projection: { fp: string; keyVersion: number },
): void {
  try {
    ledger.recordWritten(owner, harness, projection);
    return;
  } catch {
    // One retry below; a transient lock or write error usually clears.
  }
  try {
    ledger.recordWritten(owner, harness, projection);
  } catch (error) {
    try {
      ledger.recordFailed(owner, harness, projection);
    } catch {
      throw error;
    }
  }
}

export class HarnessLinkModeService {
  private readonly withLock = createKeyedLock();

  constructor(private readonly deps: LinkModeDeps) {}

  /** Whether the unified vendor-key flag is armed. */
  isEnabled(): boolean {
    return this.deps.isEnabled();
  }

  private owner(userId: string | number | null | undefined, harness: LinkHarness): string | number | null {
    return this.deps.treeOwner(userId, harness);
  }

  private readState(userId: string | number | null | undefined, harness: LinkHarness): LinkModeRecordState {
    return this.deps.readRecordState(this.owner(userId, harness), harness);
  }

  /** The readable record, else null (absent and unreadable alike; display and delete paths only). */
  private readRec(userId: string | number | null | undefined, harness: LinkHarness): LinkModeRecord | null {
    const read = this.readState(userId, harness);
    return read.state === 'ok' ? read.record : null;
  }

  /** A store refusal to rewrite a corrupt keys file surfaces as the typed 409 (B-1547). */
  private writeRec(userId: string | number | null | undefined, harness: LinkHarness, record: LinkModeRecord): void {
    try {
      this.deps.writeRecord(this.owner(userId, harness), harness, record);
    } catch (error) {
      if (isProviderSecretsStoreUnreadable(error)) throw recordUnreadableError(harness, true);
      throw error;
    }
  }

  private lock<T>(userId: string | number | null | undefined, harness: LinkHarness, op: () => Promise<T>): Promise<T> {
    return this.withLock(lockKey(this.owner(userId, harness), harness), op);
  }

  /** The adopted ledger entry of the tree `userId` writes to; null when none or unreadable. */
  private adoptedFor(userId: string | number | null | undefined, harness: LinkHarness): AdoptedProjection {
    try {
      return this.deps.adoptedProjection?.(this.owner(userId, harness), harness) ?? null;
    } catch {
      return null;
    }
  }

  /** Accepted grants from active members on the tree `userId` writes to (H6). */
  granteeCount(userId: string | number | null | undefined, harness: LinkHarness): number {
    return this.deps.countGrantees(this.owner(userId, harness), harness);
  }

  /**
   * Runs an explicit credential act (e.g. removing a setup token) under the same
   * (tree, harness) lock as mode switches and key saves; flag off → no lock.
   */
  async withHarnessLock<T>(userId: string | number | null | undefined, harness: LinkHarness, op: () => Promise<T>): Promise<T> {
    return this.deps.isEnabled() ? this.lock(userId, harness, op) : op();
  }

  private freshRecord(
    base: LinkModeRecord | null,
    patch: Partial<LinkModeRecord> & Pick<LinkModeRecord, 'mode'>,
  ): LinkModeRecord {
    return {
      v: 1,
      source: base?.source ?? 'user',
      projection: base?.projection ?? null,
      subscriptionFp: base?.subscriptionFp ?? null,
      ...patch,
      updatedAt: this.deps.now().toISOString(),
    };
  }

  /**
   * The stored record, or the H1 default persisted on first in-flag touch. An
   * unreadable record is reported, never derived over or persisted (B-1547).
   */
  private ensureRecord(
    userId: string | number | null | undefined,
    harness: LinkHarness,
    inventory: HarnessCredentialInventory,
  ): { record: LinkModeRecord | null; unreadable: boolean; storeUnreadable: boolean } {
    const stored = this.readState(userId, harness);
    if (stored.state === 'ok') return { record: stored.record, unreadable: false, storeUnreadable: false };
    if (stored.state === 'unreadable') return { record: null, unreadable: true, storeUnreadable: stored.store === true };
    return { record: this.deriveAndPersist(userId, harness, inventory), unreadable: false, storeUnreadable: false };
  }

  private deriveAndPersist(
    userId: string | number | null | undefined,
    harness: LinkHarness,
    inventory: HarnessCredentialInventory,
  ): LinkModeRecord | null {
    const derived = deriveDefaultLinkMode(inventory);
    if (!derived) return null;
    const record = this.freshRecord(null, {
      mode: derived,
      source: 'derived',
      subscriptionFp: subscriptionFingerprint(inventory, this.deps.fingerprint),
    });
    this.writeRec(userId, harness, record);
    return record;
  }

  private statusFor(
    userId: string | number | null | undefined,
    harness: LinkHarness,
    record: LinkModeRecord | null,
  ): LinkModeStatus {
    const inventory = this.deps.readInventory(userId, harness);
    return buildLinkModeStatus(
      inventory, record, this.granteeCount(userId, harness), this.deps.fingerprint, this.adoptedFor(userId, harness),
    );
  }

  /**
   * G1 M-5: a key nassaj did not write is overwritten only on explicit
   * confirmation. An adopted key may be replaced (ADR-200 §2: only its deletion
   * needs a confirm).
   */
  private assertNoForeignOverwrite(
    inventory: HarnessCredentialInventory,
    record: LinkModeRecord | null,
    confirmed: boolean,
    adopted: AdoptedProjection,
  ): void {
    if (confirmed || !inventory.managedKey || isOwnProjection(inventory, record, this.deps.fingerprint)) return;
    if (isAdoptedKey(inventory, adopted, this.deps.fingerprint)) return;
    throw linkModeError('FOREIGN_CREDENTIAL_PRESENT',
      'An API key nassaj did not write is stored for this harness. Confirm to replace it.');
  }

  /** A `claude setup-token` save is a subscription act; it never lands in key mode. */
  private async writeSetupToken<T>(
    userId: string | number | null | undefined,
    token: string,
    inventory: HarnessCredentialInventory,
    record: LinkModeRecord | null,
    write: () => Promise<T>,
  ): Promise<T> {
    if (record?.mode === 'api_key') {
      throw linkModeError('LINK_MODE_API_KEY',
        'This harness is in API-key mode. Switch it to subscription before saving a setup token.');
    }
    // The writer drops ANTHROPIC_API_KEY with a setup token; never a foreign one unasked.
    if (inventory.managedKey && !isOwnProjection(inventory, record, this.deps.fingerprint)) {
      throw linkModeError('FOREIGN_CREDENTIAL_PRESENT',
        'An API key nassaj did not write is stored for this harness. Remove it from the link mode first.');
    }
    const result = await write();
    this.writeRec(userId, 'claude', this.freshRecord(record, {
      mode: 'subscription',
      source: record?.source ?? 'setup_token',
      projection: null,
      subscriptionFp: this.deps.fingerprint(token.trim()),
    }));
    return result;
  }

  /**
   * The C3 choke point for one Claude/Codex key write. Flag off → `write()`
   * unchanged. Flag on → under the lock: resolve the mode, refuse, or write and
   * record the projection fingerprint.
   */
  async guardKeyWrite<T>(
    userId: string | number | null | undefined,
    harness: LinkHarness,
    value: string,
    options: KeyWriteOptions,
    write: () => Promise<T>,
  ): Promise<T> {
    if (!this.deps.isEnabled()) return write();
    return this.lock(userId, harness, async () => {
      const inventory = this.deps.readInventory(userId, harness);
      const { record, unreadable, storeUnreadable } = this.ensureRecord(userId, harness, inventory);
      // B-1547: no key or setup-token save silently replaces an unreadable record.
      if (unreadable) throw recordUnreadableError(harness, storeUnreadable);
      if (harness === 'claude' && isClaudeSubscriptionToken(value)) {
        return this.writeSetupToken(userId, value, inventory, record, write);
      }
      assertKeyWritable(record, options.origin);
      const adopted = this.adoptedFor(userId, harness);
      this.assertNoForeignOverwrite(inventory, record, options.replaceForeignKey === true, adopted);
      const result = await write();
      this.writeRec(userId, harness, this.freshRecord(record, {
        mode: 'api_key',
        projection: { fp: this.deps.fingerprint(value.trim(), this.deps.keyVersion), keyVersion: this.deps.keyVersion },
        subscriptionFp: subscriptionFingerprint(inventory, this.deps.fingerprint),
      }));
      return result;
    });
  }

  /** A key delete keeps the mode (D6: a key-mode harness stays unlinked) and forgets the projection. */
  async guardKeyDelete<T>(
    userId: string | number | null | undefined,
    harness: LinkHarness,
    remove: () => Promise<T>,
  ): Promise<T> {
    if (!this.deps.isEnabled()) return remove();
    return this.lock(userId, harness, async () => {
      const result = await remove();
      const record = this.readRec(userId, harness);
      if (record?.projection) {
        this.writeRec(userId, harness, this.freshRecord(record, { mode: record.mode, projection: null }));
      }
      return result;
    });
  }

  /** api_key: project the canonical key unless a foreign key holds the slot. */
  private async switchToKey(ctx: SwitchContext): Promise<{
    outcome: SwitchLinkModeOutcome; projection: LinkModeRecord['projection'];
  }> {
    const canonical = this.deps.readCanonicalKey(ctx.userId, ctx.harness);
    const keyState = classifyKey(ctx.inventory, ctx.record, this.deps.fingerprint, ctx.adopted);
    if (!canonical) {
      const outcome = keyState === 'none' ? 'awaiting_key' : keyState === 'foreign' ? 'foreign_credential' : 'linked';
      return { outcome, projection: null };
    }
    if (keyState === 'foreign' && ctx.input.removeForeignKey !== true) {
      return { outcome: 'foreign_credential', projection: null };
    }
    const ledger = this.deps.projectionLedger;
    const owner = this.owner(ctx.userId, ctx.harness);
    // B-1574: refuse before the write, so no projection is ever left unledgered.
    ledger?.assertWritable(owner, ctx.harness);
    await ctx.writer.setApiKey(ctx.userId, canonical, undefined, ctx.input.authenticatedPrincipal);
    const keyVersion = this.deps.keyVersion;
    const projection = { fp: this.deps.fingerprint(canonical, keyVersion), keyVersion };
    if (ledger) recordProjectionWritten(ledger, owner, ctx.harness, projection);
    return { outcome: 'linked', projection };
  }

  /** B-1574: the file no longer holds a key; a stale ledger entry is harmless, so this is best effort. */
  private forgetProjection(ctx: SwitchContext): void {
    try {
      this.deps.projectionLedger?.recordRemoved(this.owner(ctx.userId, ctx.harness), ctx.harness);
    } catch {
      // An unreadable ledger keeps its entry; the delete then finds the file empty ("absent").
    }
  }

  /** subscription: remove nassaj's own projection; a foreign key only on confirm. */
  private async switchToSubscription(ctx: SwitchContext): Promise<SwitchLinkModeOutcome> {
    const keyState = classifyKey(ctx.inventory, ctx.record, this.deps.fingerprint, ctx.adopted);
    if (keyState === 'none') return 'no_key';
    if (keyState === 'adopted' && ctx.input.removeForeignKey !== true) return 'adopted_credential';
    const own = isOwnProjection(ctx.inventory, ctx.record, this.deps.fingerprint);
    const removable = Boolean(ctx.inventory.managedKey) && (own || ctx.input.removeForeignKey === true);
    if (!removable) return 'foreign_credential';
    await ctx.writer.deleteApiKey(ctx.userId);
    this.forgetProjection(ctx);
    if (ctx.inventory.unmanagedKeySource) return 'foreign_credential';
    return own ? 'key_removed' : 'foreign_key_removed';
  }

  private async removeSetupTokenIfAsked(ctx: SwitchContext, mode: LinkMode): Promise<boolean> {
    if (ctx.input.removeSetupToken !== true) return false;
    if (ctx.harness !== 'claude' || mode !== 'api_key' || !ctx.writer.deleteSubscriptionToken) {
      throw new AppError('`removeSetupToken` applies only to a Claude switch to API-key mode.', {
        code: 'INVALID_LINK_MODE_OPTION', statusCode: 400,
      });
    }
    await ctx.writer.deleteSubscriptionToken(ctx.userId);
    return true;
  }

  private assertConfirmed(ctx: SwitchContext, mode: LinkMode, granteeCount: number): void {
    if (ctx.input.confirm === true) return;
    throw linkModeError('LINK_MODE_CONFIRM_REQUIRED', 'Confirm the link-mode change.', {
      from: ctx.record?.mode ?? null, to: mode, granteeCount,
      ...(ctx.recordUnreadable ? { recordUnreadable: true } : {}),
    });
  }

  private async applySwitch(ctx: SwitchContext, mode: LinkMode): Promise<SwitchLinkModeResult> {
    const granteeCount = this.granteeCount(ctx.userId, ctx.harness);
    this.assertConfirmed(ctx, mode, granteeCount);
    const setupTokenRemoved = await this.removeSetupTokenIfAsked(ctx, mode);
    let outcome: SwitchLinkModeOutcome;
    let projection: LinkModeRecord['projection'] = null;
    if (mode === 'api_key') {
      ({ outcome, projection } = await this.switchToKey(ctx));
      if (projection === null && isOwnProjection(ctx.inventory, ctx.record, this.deps.fingerprint)) {
        projection = ctx.record?.projection ?? null;
      }
    } else {
      outcome = await this.switchToSubscription(ctx);
    }
    const after = this.deps.readInventory(ctx.userId, ctx.harness);
    const record = this.freshRecord(ctx.record, {
      mode, source: 'user', projection, subscriptionFp: subscriptionFingerprint(after, this.deps.fingerprint),
    });
    this.writeRec(ctx.userId, ctx.harness, record);
    this.deps.audit(ctx.userId, {
      provider: ctx.harness, from: ctx.record?.mode ?? null, to: mode, outcome, granteeCount, setupTokenRemoved,
      ...(ctx.recordUnreadable ? { replacedUnreadableRecord: true } : {}),
    }, ctx.input.auditContext);
    return {
      provider: ctx.harness, previousMode: ctx.record?.mode ?? null, mode, outcome, setupTokenRemoved,
      granteeCount, status: buildLinkModeStatus(after, record, granteeCount, this.deps.fingerprint, ctx.adopted),
    };
  }

  /** The user's explicit mode switch (one confirm line; H6 grantee count in the refusal). */
  async switchMode(
    userId: string | number | null | undefined,
    harness: LinkHarness,
    input: SwitchLinkModeInput,
  ): Promise<SwitchLinkModeResult> {
    if (!this.deps.isEnabled()) {
      throw linkModeError('LINK_MODE_DISABLED', 'Link modes are not enabled on this server.');
    }
    const mode = parseLinkMode(input.mode);
    const writer = this.deps.resolveWriter(harness);
    if (!writer) throw new AppError('This harness has no credential writer.', { code: 'TERMINAL_ONLY', statusCode: 400 });
    return this.lock(userId, harness, async () => {
      const inventory = this.deps.readInventory(userId, harness);
      const { record, unreadable, storeUnreadable } = this.ensureRecord(userId, harness, inventory);
      // B-1547: a corrupt keys file refuses the record write, so refuse before
      // any projection side effect instead of after it.
      if (storeUnreadable) throw recordUnreadableError(harness, true);
      const adopted = this.adoptedFor(userId, harness);
      const ctx: SwitchContext = { userId, harness, inventory, record, recordUnreadable: unreadable, input, writer, adopted };
      const optionsAsked = input.removeForeignKey === true || input.removeSetupToken === true;
      if (record?.mode === mode && record.source === 'user' && !optionsAsked) {
        const granteeCount = this.granteeCount(userId, harness);
        const status = buildLinkModeStatus(inventory, record, granteeCount, this.deps.fingerprint, adopted);
        return {
          provider: harness, previousMode: mode, mode, outcome: 'unchanged', setupTokenRemoved: false, granteeCount, status,
        };
      }
      return this.applySwitch(ctx, mode);
    });
  }

  /** Chosen mode beside effective mode, with drift warnings (M4). Flag off → `{ enabled: false }`. */
  async getStatus(
    userId: string | number | null | undefined,
    harness: LinkHarness,
  ): Promise<LinkModeStatus | { provider: LinkHarness; enabled: false }> {
    if (!this.deps.isEnabled()) return { provider: harness, enabled: false };
    return this.lock(userId, harness, async () => {
      const { record, unreadable } = this.ensureRecord(userId, harness, this.deps.readInventory(userId, harness));
      const status = this.statusFor(userId, harness, record);
      if (!unreadable) return status;
      const warnings = [...status.warnings.filter((w) => w !== 'mode_unset'), 'record_unreadable' as const];
      return { ...status, linkState: 'unlinked', warnings };
    });
  }

  /**
   * The stored (or derived) mode only, for the grant overview. Never writes.
   * Null with the flag off, and for an unreadable record (B-1547: never derive
   * over it; ADR-200 S9).
   */
  peekMode(userId: string | number | null | undefined, harness: LinkHarness): LinkMode | null {
    if (!this.deps.isEnabled()) return null;
    const read = this.readState(userId, harness);
    if (read.state === 'unreadable') return null;
    return read.state === 'ok' ? read.record.mode : deriveDefaultLinkMode(this.deps.readInventory(userId, harness));
  }
}

/** Typed refusal of a run whose chosen `api_key` mode has no key behind it (B-1546). */
export const LINK_MODE_KEY_MISSING = 'LINK_MODE_KEY_MISSING';

/** True for a link-mode run refusal whose message is credential-free and meant for the user. */
export function isLinkModeRunRefusal(
  code: unknown,
): code is typeof LINK_MODE_KEY_MISSING | typeof LINK_MODE_RECORD_UNREADABLE {
  return code === LINK_MODE_KEY_MISSING || code === LINK_MODE_RECORD_UNREADABLE;
}

/** What the run gate reads; a strict subset of {@link LinkModeDeps} plus the grant resolver. */
export type LinkModeRunDeps = Pick<LinkModeDeps, 'isEnabled' | 'readInventory' | 'readRecordState' | 'treeOwner'> & {
  /**
   * Whose tree a RUN by `userId` lands in: the grantor under an accepted
   * credential grant, else `userId` itself. `treeOwner` then maps a shared
   * harness to the operator, exactly as on the write path (G1 H-1).
   */
  runPrincipal(userId: string | number | null | undefined, harness: LinkHarness): string | number | null | undefined;
};

/** `honorGrants: false` for a spawn that runs on the caller's OWN tree (PTY terminals). */
export type LinkModeRunOptions = { honorGrants?: boolean };

/**
 * B-1546 run gate (C2 + D6): refuses a Claude/Codex run when the effective
 * link mode of the tree it would run on is `api_key` but the CLI would not run
 * on a key, so a deleted key can never fall back to the subscription (for a
 * grantee, the grantor's subscription). Read-only: a missing record is derived
 * in memory (H1) and never persisted from the run path. Flag off → no-op.
 * Throws 409 `LINK_MODE_KEY_MISSING`, or 409 `LINK_MODE_RECORD_UNREADABLE`
 * when the record exists but cannot be read (B-1547: fail closed, never derive
 * over it); neither message carries a credential or the read cause.
 */
export function assertLinkModeRunAllowed(
  deps: LinkModeRunDeps,
  userId: string | number | null | undefined,
  harness: LinkHarness,
  options: LinkModeRunOptions = {},
): void {
  if (!deps.isEnabled()) return;
  const principal = options.honorGrants === false ? userId : deps.runPrincipal(userId, harness);
  const stored = deps.readRecordState(deps.treeOwner(principal, harness), harness);
  if (stored.state === 'unreadable') throw recordUnreadableError(harness, stored.store === true);
  const inventory = deps.readInventory(principal, harness);
  const mode = stored.state === 'ok' ? stored.record.mode : deriveDefaultLinkMode(inventory);
  if (mode !== 'api_key' || inventory.effective === 'api_key') return;
  throw linkModeError(LINK_MODE_KEY_MISSING,
    'This harness is linked by API key, but no key is stored. Add the key or switch the link mode to subscription.',
    { provider: harness });
}

/** Builds a link-mode service over explicit dependencies (DI; tests pass fakes). */
export function createHarnessLinkModeService(deps: LinkModeDeps): HarnessLinkModeService {
  return new HarnessLinkModeService(deps);
}
