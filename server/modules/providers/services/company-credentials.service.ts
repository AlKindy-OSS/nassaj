/**
 * company-credentials.service — ONE key per company, delivered by nassaj to
 * every harness in the shape that harness expects (T-1159).
 *
 * WHY. `shared/vendors.ts` already says a company can own several credential
 * SLOTS — Anthropic issues one key that `claude` keeps in its settings and
 * `opencode` keeps in its `auth.json`. Grouping those slots under one company
 * heading (T-1151) explained the layout but left the work: the operator still
 * pasted the same key once per slot. That is not a duplicated secret, it is a
 * duplicated CHORE, and nassaj already owns everything needed to remove it —
 * `providerCredentialsService.setKey` is a dispatcher that knows each harness's
 * native surface (writer facet for claude/codex/opencode, encrypted store for
 * kimi/deepseek/glm). This service is the missing loop over that dispatcher:
 * one paste in, a fan-out to every slot of the company, one honest report back.
 *
 * WHAT IT DELIBERATELY WILL NOT DO — overwrite a live subscription. A slot whose
 * harness is currently authenticated by the vendor's own browser login is
 * SKIPPED, not written. This is not caution for its own sake: Claude Code reads
 * `settings.json` BEFORE the OAuth record (`claude-auth.provider.ts:174`), so a
 * key written into a subscribed harness silently flips a Max subscription onto
 * metered API billing — a money-shaped side effect from a convenience feature.
 * "Deliver it the way the harness wants it" means the subscribed harness keeps
 * its subscription. `includeSubscription: true` overrides this, per call, only
 * when the caller says so explicitly.
 *
 * WHICH SLOTS — `vendorIds` (T-1201). The surface is now one field plus a
 * checkbox per slot, so the call names the slots it ticked. That list can only
 * NARROW the company's own catalog set (see `selectVendors`), and it is applied
 * BEFORE nothing else: the role gate and the subscription skip still run per
 * surviving slot, so a client that ticks a shared slot it may not write still
 * gets `forbidden`, and one that ticks a subscribed slot without asking for the
 * override still gets `skipped_subscription`. The checkbox chooses among the
 * writes the caller was already allowed; it never authorizes one.
 *
 * The per-slot outcome is REPORTED rather than collapsed into a boolean: a
 * fan-out that half-succeeds and says "saved" is the failure mode this file
 * exists to avoid. Every slot returns why it ended up as it did, and one slot's
 * error never cancels the others.
 *
 * ADR-200 S6 (in-flag `NASSAJ_UNIFIED_VENDOR_KEYS`, a signed-in member): Save
 * and Delete go through the unified fan-out (`vendor-key-fanout.service`): one
 * AES record per vendor, projections owned by fingerprint, tombstones for a
 * removal that fails. With the flag off this file keeps the T-1201 behaviour,
 * except that a company delete also removes the member's `vendor:*` record
 * (§3 legacy delete path) so the two models cannot diverge.
 *
 * Never returns, logs, or echoes a key value — same contract as the per-slot
 * routes it delegates to.
 */

import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerCredentialsService } from '@/modules/providers/services/provider-credentials.service.js';
import {
  providerSecretsService,
  type QwenCredentialAuditContext,
} from '@/modules/providers/services/provider-secrets.service.js';
import { isLinkModeHarness } from '@/modules/providers/services/harness-link-mode.service.js';
import {
  deriveCompanyProjections,
  projectionReadDeps,
  type CompanyProjection,
} from '@/modules/providers/services/company-credentials.projections.js';
import { QWEN_PLAN_REFUSAL, qwenPlanProfileVerdict } from '@/services/isolation/opencode-qwen-plan.js';
import {
  deleteCanonicalVendorKey,
  isUnifiedVendorKeysEnabled,
} from '@/services/isolation/provider-secrets-store.js';
// Relative, like every other shared/ import on the server side (claude-sdk.js,
// engine-pin.js): the `@/*` alias maps to server/ only.
import { AppError } from '@/shared/utils.js';

import { CANONICAL_VENDOR_IDS, COMPANY_NAME, VENDORS, type Vendor } from '../../../../shared/vendors.js';

import type { FanoutSlot } from './vendor-key-fanout.service.js';


/** What happened to one slot of the company during a fan-out. */
export type CompanySlotOutcome =
  /** The key was written into this harness's own credential surface. */
  | 'written'
  /** Skipped: the harness is signed in by subscription and would be downgraded. */
  | 'skipped_subscription'
  /** Skipped: writing this slot touches the operator's shared credentials. */
  | 'forbidden'
  /**
   * ADR-200 S4 (in-flag): the link-mode choke point refused the key because the
   * harness is in subscription mode (or no mode is chosen yet). Nothing written.
   */
  | 'kept_on_subscription'
  /** ADR-200 S4 (in-flag): no link mode chosen and nothing to derive one from. Nothing written. */
  | 'mode_unset'
  /** The write was attempted and the harness's own writer refused it. */
  | 'failed'
  // ADR-200 S6 (in-flag) Save outcomes:
  /** The key is in the AES record, or projected into this harness and re-read. */
  | 'linked'
  /** OpenCode: the target holds a login, which nassaj never overwrites. */
  | 'login_present'
  /** The harness uses a shared tree; a member's key is never written there (D6). */
  | 'shared_scope_refused'
  /** A value nassaj does not own sits there; untouched without explicit confirm. */
  | 'foreign_credential'
  // ADR-200 S6 (in-flag) Delete outcomes:
  /** nassaj's own projection (or the AES record) was removed. */
  | 'removed'
  /** Nothing was there to remove. */
  | 'absent'
  /** A key the migration adopted; removed only with explicit confirm. */
  | 'adopted_credential';

export type CompanySlotResult = {
  vendorId: string;
  provider: string;
  target?: string;
  outcome: CompanySlotOutcome;
  /** Present only for 'failed' — the writer's message, never the key. */
  error?: string;
  /** ADR-200 S4: the refusal code behind 'kept_on_subscription' or a link-mode 'failed'. */
  code?: string;
};

/** Link-mode refusals that are a decision, not a broken write. */
const LINK_MODE_OUTCOMES: Record<string, CompanySlotOutcome> = {
  LINK_MODE_SUBSCRIPTION: 'kept_on_subscription',
  // UNSET means no key and no subscription exist (H1), so nothing was "kept".
  LINK_MODE_UNSET: 'mode_unset',
};

/** Maps a dispatcher refusal to a slot outcome, keeping the code but never a key. */
function failedSlot(base: Omit<CompanySlotResult, 'outcome'>, error: unknown, fallback: string): CompanySlotResult {
  const code = error instanceof AppError ? error.code : undefined;
  const decided = code ? LINK_MODE_OUTCOMES[code] : undefined;
  if (decided) return { ...base, outcome: decided, code };
  const surfaced = code?.startsWith('LINK_MODE_') || code === 'FOREIGN_CREDENTIAL_PRESENT';
  return {
    ...base,
    outcome: 'failed',
    error: error instanceof Error ? error.message : fallback,
    ...(surfaced ? { code } : {}),
  };
}

/**
 * Whether the live-login skip applies. In-flag, Claude and Codex are decided by
 * the stored link mode at the choke point instead (ADR-200 S4): a key-mode
 * harness with a login is written, and `includeSubscription` cannot force a
 * subscription-mode one.
 */
function usesLiveSubscriptionSkip(provider: string): boolean {
  return !(isUnifiedVendorKeysEnabled() && isLinkModeHarness(provider));
}

export type CompanyKeyResult = {
  companyId: string;
  /** True when at least one slot now holds the key. */
  configured: boolean;
  slots: CompanySlotResult[];
};

export type CompanySlotStatus = {
  vendorId: string;
  provider: string;
  target?: string;
  configured: boolean;
  /** True when this slot is currently held by a subscription login. */
  subscription: boolean;
  /**
   * ADR-200 S7: present only on a configured qwen slot holding a legacy
   * profile (a Coding Plan record, or a non-international Token Plan record).
   * It is shown with a working Delete; it is never deleted silently.
   */
  status?: typeof QWEN_PLAN_REFUSAL.LEGACY_PROFILE;
};

/** ADR-200 S7: the qwen slot's legacy marker, or nothing. Never the key. */
function qwenSlotStatus(
  userId: string | number | null | undefined,
  provider: string,
  configured: boolean,
): Pick<CompanySlotStatus, 'status'> {
  if (provider !== 'qwen' || !configured) return {};
  try {
    const profile = providerSecretsService.getQwenProfile(userId);
    return qwenPlanProfileVerdict(profile) === QWEN_PLAN_REFUSAL.LEGACY_PROFILE
      ? { status: QWEN_PLAN_REFUSAL.LEGACY_PROFILE }
      : {};
  } catch {
    return {};
  }
}

export type CompanyKeyStatus = {
  companyId: string;
  name: string;
  slots: CompanySlotStatus[];
  /**
   * ADR-200 S5 (in-flag), D9: the company's existing keys disagree, so the
   * migration wrote nothing for it. `sources` say where each key sits and which
   * of them match (`group`); never a value. The user chooses one.
   */
  migrationConflict?: { sources: Array<{ harness: string; target: string | null; group: number | null }> };
  /**
   * ADR-200 S9 (in-flag only; absent with the flag off): the caller's state per
   * harness projection, from their own ledger and link mode. Never a key or a
   * fingerprint.
   */
  projections?: CompanyProjection[];
};

/** ADR-200 S5, D9: the company's unresolved migration conflict, if any. Read-only. */
async function migrationConflictFor(
  userId: string | number | null | undefined,
  companyId: string,
): Promise<Pick<CompanyKeyStatus, 'migrationConflict'>> {
  if (!isUnifiedVendorKeysEnabled()) return {};
  try {
    // Loaded at call time, in-flag only (the routes import the runtime statically anyway).
    const { vendorKeyMigrationService } = await import('./vendor-key-migration.runtime.js');
    const inventory = vendorKeyMigrationService.inventory(userId);
    const vendor = inventory.vendors.find((entry) => entry.vendorId === companyId && entry.outcome === 'conflict');
    if (!vendor) return {};
    const sources = vendor.sources.map(({ harness, target, group }) => ({ harness, target, group }));
    return { migrationConflict: { sources } };
  } catch {
    return {};
  }
}

/** ADR-200 S6: the unified fan-out applies in-flag, to a signed-in member only. */
function usesUnifiedFanout(userId: string | number | null | undefined): userId is string | number {
  return isUnifiedVendorKeysEnabled() && userId !== null && userId !== undefined && userId !== '';
}

function toFanoutSlot(vendor: Vendor): FanoutSlot {
  const slot = vendor.slot!;
  return { vendorId: vendor.id, provider: slot.provider, ...(slot.target ? { target: slot.target } : {}) };
}

/** G2 (B-1570): an in-flag delete takes every slot of the vendor or none; a strict subset is a 409. */
function assertVendorWideDelete(selected: readonly Vendor[], all: readonly Vendor[]): void {
  if (selected.length === all.length) return;
  throw new AppError('Deleting this key removes it from every harness; select all of its slots.', {
    code: 'VENDOR_DELETE_IS_VENDOR_WIDE',
    statusCode: 409,
  });
}

/**
 * Loaded at call time, in-flag only, so the flag-off delete path never runs it.
 * (The routes already import the migration runtime statically, so this is not
 * an import-graph guarantee.)
 */
async function loadFanout() {
  return (await import('./vendor-key-fanout.runtime.js')).vendorKeyFanoutService;
}

/** ADR-200 S6 Save through the fan-out; `includeSubscription` is moot, the link mode decides. */
async function fanoutSave(
  userId: string | number,
  companyId: string,
  key: string,
  vendors: Vendor[],
  options: {
    isElevated: boolean;
    replaceForeignKey?: boolean;
    authenticatedPrincipal?: unknown;
    auditContext?: QwenCredentialAuditContext;
  },
): Promise<CompanyKeyResult> {
  const results = await (await loadFanout()).save(userId, companyId, key, {
    isElevated: options.isElevated,
    replaceForeignKey: options.replaceForeignKey === true,
    authenticatedPrincipal: options.authenticatedPrincipal,
    auditContext: options.auditContext,
    slots: vendors.map(toFanoutSlot),
  });
  return { companyId, configured: results.some((entry) => entry.outcome === 'linked'), slots: results };
}

/**
 * §3 legacy delete path (flag off): the member's `vendor:*` record goes with the
 * company's slots. A failure is reported as a slot, never silently dropped.
 */
function deleteLegacyCanonical(
  userId: string | number | null | undefined,
  companyId: string,
): CompanySlotResult[] {
  if (!CANONICAL_VENDOR_IDS.includes(companyId) || userId === null || userId === undefined || userId === '') return [];
  try {
    deleteCanonicalVendorKey(userId, companyId);
    return [];
  } catch {
    return [{
      vendorId: companyId, provider: 'vendor', outcome: 'failed',
      error: 'The unified vendor record could not be removed.',
    }];
  }
}

/** The writable slots of a company, in catalog order. Throws 404 when unknown. */
function companyVendors(companyId: string): Vendor[] {
  const vendors = VENDORS.filter((vendor) => vendor.companyId === companyId && vendor.slot !== null);
  if (vendors.length === 0) {
    throw new AppError(`Unknown company "${companyId}".`, {
      code: 'UNKNOWN_COMPANY',
      statusCode: 404,
    });
  }
  return vendors;
}

/**
 * Narrows a fan-out to the slots the caller SELECTED — the checkbox list under
 * the single key field (T-1201).
 *
 * **The selection may only ever SHRINK the set, never grow it.** The candidate
 * set is computed here from the catalog, keyed by `companyId` from the PATH; the
 * body then acts as a filter over it. So a request naming `anthropic-opencode`
 * while posting to `/company/moonshot/key` selects nothing from Anthropic — the
 * id is simply absent from Moonshot's candidates. This is the whole reason the
 * filter is an intersection and not a lookup by id: a `vendorById` walk over the
 * body would let the body decide which company it is writing, and the path's
 * authorization context would be describing a different company than the write.
 *
 * `undefined` = no selection expressed = every slot, which is exactly the old
 * behaviour, so a client that predates the checkboxes is unaffected.
 *
 * An explicit selection that matches nothing is a 400, not a silent empty
 * success: the caller asked for a write and received none, and a `configured:
 * false` with an empty slot list is indistinguishable from "the company has no
 * slots" at the surface that must report the outcome.
 */
function selectVendors(vendors: Vendor[], vendorIds: readonly string[] | undefined): Vendor[] {
  if (vendorIds === undefined) {
    return vendors;
  }
  const wanted = new Set(vendorIds);
  const selected = vendors.filter((vendor) => wanted.has(vendor.id));
  if (selected.length === 0) {
    throw new AppError('No credential slot of this company was selected.', {
      code: 'NO_SLOTS_SELECTED',
      statusCode: 400,
    });
  }
  return selected;
}

/**
 * True when this slot's harness is signed in through the vendor's own login
 * right now. Read from the live auth facet, never inferred from the catalog:
 * `credential: 'both'` only says a subscription is POSSIBLE for that slot, and
 * skipping on the possibility would refuse to configure a harness the operator
 * never logged into. A probe failure answers `false` — an unreachable status
 * check must not become a silent refusal to write.
 */
async function isHeldBySubscription(
  provider: string,
  userId: string | number | null | undefined,
): Promise<boolean> {
  try {
    const status = await providerAuthService.getProviderAuthStatus(provider, userId);
    if (!status.authenticated) {
      return false;
    }
    if (status.authMode === 'subscription_oauth' || status.authMode === 'both') {
      return true;
    }
    // Providers predating authMode report the same fact through `method`.
    return status.method === 'oauth_token' || status.method === 'subscription';
  } catch {
    return false;
  }
}

export const companyCredentialsService = {
  /** The companies that own at least one writable slot. */
  companies(): { id: string; name: string }[] {
    const seen: { id: string; name: string }[] = [];
    for (const vendor of VENDORS) {
      if (vendor.slot === null || seen.some((entry) => entry.id === vendor.companyId)) {
        continue;
      }
      seen.push({ id: vendor.companyId, name: COMPANY_NAME[vendor.companyId] ?? vendor.name });
    }
    return seen;
  },

  /**
   * Writes one key into every slot of `companyId`.
   *
   * `isElevated` is the caller's owner/admin standing, resolved by the route
   * from the token. It is passed in rather than read here because the role rule
   * (`requiresElevatedRole`) belongs to the route layer that already owns the
   * 403 contract — this service must not become a second place that decides
   * authorization.
   */
  async setKey(
    userId: string | number | null | undefined,
    companyId: string,
    apiKey: unknown,
    options: {
      isElevated: boolean;
      includeSubscription?: boolean;
      /** ADR-200 S4 / G1 M-5: explicit confirmation to replace a key nassaj did not write. */
      replaceForeignKey?: boolean;
      authenticatedPrincipal?: unknown;
      /** Slots the caller ticked. Absent = every slot (pre-checkbox clients). */
      vendorIds?: readonly string[];
      auditContext?: QwenCredentialAuditContext;
    } = { isElevated: false },
  ): Promise<CompanyKeyResult> {
    const vendors = selectVendors(companyVendors(companyId), options.vendorIds);
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new AppError('API key is required and must not be empty.', {
        code: 'INVALID_API_KEY',
        statusCode: 400,
      });
    }
    const key = apiKey.trim();
    if (usesUnifiedFanout(userId)) return fanoutSave(userId, companyId, key, vendors, options);

    const slots: CompanySlotResult[] = [];
    for (const vendor of vendors) {
      const slot = vendor.slot!;
      const base = { vendorId: vendor.id, provider: slot.provider, target: slot.target };

      if (
        providerCredentialsService.requiresElevatedRole(slot.provider)
        && !options.isElevated
      ) {
        slots.push({ ...base, outcome: 'forbidden' });
        continue;
      }

      if (
        !options.includeSubscription
        && usesLiveSubscriptionSkip(slot.provider)
        && await isHeldBySubscription(slot.provider, userId)
      ) {
        slots.push({ ...base, outcome: 'skipped_subscription' });
        continue;
      }

      try {
        await providerCredentialsService.setKey(
          userId, slot.provider, key, slot.target, options.authenticatedPrincipal, options.auditContext,
          { origin: 'company_route', replaceForeignKey: options.replaceForeignKey === true },
        );
        slots.push({ ...base, outcome: 'written' });
      } catch (error) {
        slots.push(failedSlot(base, error, 'Write failed'));
      }
    }

    return {
      companyId,
      configured: slots.some((entry) => entry.outcome === 'written'),
      slots,
    };
  },

  /**
   * Removes the company's key from every slot it was fanned out to. A slot that
   * holds nothing is not an error — delete is idempotent per slot, so this is
   * safe to call after a partial write.
   *
   * In-flag (ADR-200 §6) the delete is vendor-wide: the AES record and every
   * owned projection go. A `vendorIds` that names only some of the company's
   * slots is refused with 409 `VENDOR_DELETE_IS_VENDOR_WIDE` (G2), so a
   * per-slot remove can never wipe the other harnesses' key silently.
   * `removeForeignKey` is the explicit confirm for adopted and foreign values.
   */
  async deleteKey(
    userId: string | number | null | undefined,
    companyId: string,
    options: {
      isElevated: boolean;
      vendorIds?: readonly string[];
      /** ADR-200 S6: explicit confirm to also remove adopted and foreign projections. */
      removeForeignKey?: boolean;
      auditContext?: QwenCredentialAuditContext;
    } = { isElevated: false },
  ): Promise<CompanyKeyResult> {
    const vendors = selectVendors(companyVendors(companyId), options.vendorIds);
    if (usesUnifiedFanout(userId)) {
      assertVendorWideDelete(vendors, companyVendors(companyId));
      const results = await (await loadFanout()).remove(userId, companyId, {
        ...options, removeForeignKey: options.removeForeignKey === true, slots: companyVendors(companyId).map(toFanoutSlot),
      });
      return { companyId, configured: false, slots: results };
    }
    const slots: CompanySlotResult[] = [];

    for (const vendor of vendors) {
      const slot = vendor.slot!;
      const base = { vendorId: vendor.id, provider: slot.provider, target: slot.target };

      if (providerCredentialsService.requiresElevatedRole(slot.provider) && !options.isElevated) {
        slots.push({ ...base, outcome: 'forbidden' });
        continue;
      }

      try {
        await providerCredentialsService.deleteKey(userId, slot.provider, slot.target, options.auditContext);
        slots.push({ ...base, outcome: 'written' });
      } catch (error) {
        slots.push({
          ...base,
          outcome: 'failed',
          error: error instanceof Error ? error.message : 'Delete failed',
        });
      }
    }

    return { companyId, configured: false, slots: [...slots, ...deleteLegacyCanonical(userId, companyId)] };
  },

  /** Per-slot existence + subscription state, for the single-field UI. */
  async getStatus(
    userId: string | number | null | undefined,
    companyId: string,
  ): Promise<CompanyKeyStatus> {
    const vendors = companyVendors(companyId);
    const slots: CompanySlotStatus[] = [];

    for (const vendor of vendors) {
      const slot = vendor.slot!;
      let configured = false;
      try {
        configured = (await providerCredentialsService.getStatus(userId, slot.provider, slot.target)).configured;
      } catch {
        // An unreadable slot reports "not configured" rather than failing the
        // whole company view.
        configured = false;
      }
      slots.push({
        vendorId: vendor.id,
        provider: slot.provider,
        target: slot.target,
        configured,
        subscription: await isHeldBySubscription(slot.provider, userId),
        ...qwenSlotStatus(userId, slot.provider, configured),
      });
    }

    return {
      companyId,
      name: COMPANY_NAME[companyId] ?? companyId,
      slots,
      ...await migrationConflictFor(userId, companyId),
      ...(isUnifiedVendorKeysEnabled()
        ? { projections: deriveCompanyProjections(projectionReadDeps, userId, companyId, slots) }
        : {}),
    };
  },
};
