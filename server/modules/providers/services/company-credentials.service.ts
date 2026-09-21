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
 * Never returns, logs, or echoes a key value — same contract as the per-slot
 * routes it delegates to.
 */

import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerCredentialsService } from '@/modules/providers/services/provider-credentials.service.js';
// Relative, like every other shared/ import on the server side (claude-sdk.js,
// engine-pin.js): the `@/*` alias maps to server/ only.
import { AppError } from '@/shared/utils.js';

import { COMPANY_NAME, VENDORS, type Vendor } from '../../../../shared/vendors.js';


/** What happened to one slot of the company during a fan-out. */
export type CompanySlotOutcome =
  /** The key was written into this harness's own credential surface. */
  | 'written'
  /** Skipped: the harness is signed in by subscription and would be downgraded. */
  | 'skipped_subscription'
  /** Skipped: writing this slot touches the operator's shared credentials. */
  | 'forbidden'
  /** The write was attempted and the harness's own writer refused it. */
  | 'failed';

export type CompanySlotResult = {
  vendorId: string;
  provider: string;
  target?: string;
  outcome: CompanySlotOutcome;
  /** Present only for 'failed' — the writer's message, never the key. */
  error?: string;
};

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
};

export type CompanyKeyStatus = {
  companyId: string;
  name: string;
  slots: CompanySlotStatus[];
};

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
      /** Slots the caller ticked. Absent = every slot (pre-checkbox clients). */
      vendorIds?: readonly string[];
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
        && await isHeldBySubscription(slot.provider, userId)
      ) {
        slots.push({ ...base, outcome: 'skipped_subscription' });
        continue;
      }

      try {
        await providerCredentialsService.setKey(userId, slot.provider, key, slot.target);
        slots.push({ ...base, outcome: 'written' });
      } catch (error) {
        slots.push({
          ...base,
          outcome: 'failed',
          error: error instanceof Error ? error.message : 'Write failed',
        });
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
   */
  async deleteKey(
    userId: string | number | null | undefined,
    companyId: string,
    options: { isElevated: boolean; vendorIds?: readonly string[] } = { isElevated: false },
  ): Promise<CompanyKeyResult> {
    const vendors = selectVendors(companyVendors(companyId), options.vendorIds);
    const slots: CompanySlotResult[] = [];

    for (const vendor of vendors) {
      const slot = vendor.slot!;
      const base = { vendorId: vendor.id, provider: slot.provider, target: slot.target };

      if (providerCredentialsService.requiresElevatedRole(slot.provider) && !options.isElevated) {
        slots.push({ ...base, outcome: 'forbidden' });
        continue;
      }

      try {
        await providerCredentialsService.deleteKey(userId, slot.provider, slot.target);
        slots.push({ ...base, outcome: 'written' });
      } catch (error) {
        slots.push({
          ...base,
          outcome: 'failed',
          error: error instanceof Error ? error.message : 'Delete failed',
        });
      }
    }

    return { companyId, configured: false, slots };
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
      });
    }

    return {
      companyId,
      name: COMPANY_NAME[companyId] ?? companyId,
      slots,
    };
  },
};
