import fs from 'node:fs';

import * as database from '@/modules/database/index.js';
import {
  providerGovernanceService,
  resolveGovernanceMaterialPlan,
  resolveGovernanceLinkPlan,
  type GovernanceExemptionRefusal,
  type GovernanceMaterialPlan,
  type ProviderGovernanceLinkRefusal,
  type ProviderGovernanceReason,
  type ProviderGovernanceStatus,
} from '@/modules/providers/services/provider-governance.service.js';
import {
  invalidateProvisioned,
  provisionUserDirs,
} from '@/services/isolation/provision-user-dirs.js';
import type { LLMProvider } from '@/shared/types.js';
import { resolveCredentialPrincipal } from '@/services/isolation/credential-principal.js';
import { AppError } from '@/shared/utils.js';

export type GovernanceMode = 'governed' | 'exempt';
export const GOVERNANCE_EXEMPTION_TTL_MS = 24 * 60 * 60 * 1_000;
export const GOVERNANCE_CHANNEL_PROVIDERS: readonly LLMProvider[] = Object.freeze([
  'codex', 'opencode', 'kimi', 'antigravity', 'claude',
] as LLMProvider[]);

const expiryTimers = new Map<string, NodeJS.Timeout>();
const { auditLogDb, governanceExemptionsDb } = database;

export type GovernanceChannelReason =
  | GovernanceExemptionRefusal
  | ProviderGovernanceReason
  | 'material_present';

export interface GovernanceChannelView {
  provider: LLMProvider;
  mode: GovernanceMode;
  canManage: boolean;
  enforcement: GovernanceMaterialPlan['enforcement'];
  status: ProviderGovernanceStatus;
  linkable: boolean;
  linkRefusal?: ProviderGovernanceLinkRefusal;
  expiresAt?: string;
  reason?: GovernanceChannelReason;
}

export interface GovernanceActorContext {
  userId: string | number | null;
  role: string | null;
  platformMode: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}

function canGrant(actor: GovernanceActorContext): boolean {
  return actor.userId !== null
    && actor.userId !== ''
    && !actor.platformMode
    && (actor.role === 'owner' || actor.role === 'admin');
}

function entryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function describe(provider: LLMProvider, actor: GovernanceActorContext): GovernanceChannelView {
  const plan = resolveGovernanceMaterialPlan(provider, actor.userId);
  const linkPlan = resolveGovernanceLinkPlan(provider, actor.userId);
  const descriptor = providerGovernanceService.getGovernance(provider, actor.userId);
  const linkable = linkPlan.linkable
    && actor.userId !== null
    && actor.userId !== ''
    && !actor.platformMode
    && (linkPlan.linkScope !== 'operator' || actor.role === 'owner');
  const exemption = governanceExemptionsDb.listForUser(actor.userId)
    .find((row) => row.provider === provider);
  if (exemption) {
    return {
      provider,
      mode: 'exempt',
      canManage: canGrant(actor) && plan.exemptible,
      enforcement: plan.enforcement,
      status: descriptor.status,
      linkable: false,
      expiresAt: exemption.expiresAt,
      ...(plan.paths.some(entryExists) ? { reason: 'material_present' as const } : {}),
    };
  }
  const reason = plan.refusal ?? descriptor.sources[0]?.reason ?? null;
  return {
    provider,
    mode: 'governed',
    canManage: canGrant(actor) && plan.exemptible,
    enforcement: plan.enforcement,
    status: descriptor.status,
    linkable,
    ...(!linkable && linkPlan.refusal ? { linkRefusal: linkPlan.refusal } : {}),
    ...(reason ? { reason } : {}),
  };
}

function requirePrincipal(actor: GovernanceActorContext): string | number {
  if (actor.userId === null || actor.userId === '') {
    throw new AppError('An authenticated account is required.', {
      code: 'GOVERNANCE_MODE_UNIDENTIFIED', statusCode: 403,
    });
  }
  return actor.userId;
}

function removeMaterial(paths: readonly string[]): void {
  const failed: string[] = [];
  for (const target of paths) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed.push(target);
    }
  }
  if (failed.length > 0) {
    throw new AppError('Governance material could not be removed.', {
      code: 'GOVERNANCE_MATERIAL_REMOVAL_FAILED', statusCode: 500,
      details: { remaining: failed.length },
    });
  }
}

function restoreMaterial(userId: string | number): void {
  invalidateProvisioned(userId);
  provisionUserDirs(userId);
}

function timerKey(userId: string | number, provider: LLMProvider): string {
  return `${String(userId)}\0${provider}`;
}

function cancelScheduledExpiry(userId: string | number, provider: LLMProvider): void {
  const key = timerKey(userId, provider);
  const timer = expiryTimers.get(key);
  if (timer) clearTimeout(timer);
  expiryTimers.delete(key);
}

function expireExemption(
  userId: string | number,
  provider: LLMProvider,
  expectedExpiresAt: string,
): void {
  const stored = governanceExemptionsDb.findStored(userId, provider);
  if (!stored || stored.expiresAt !== expectedExpiresAt || Date.parse(stored.expiresAt) > Date.now()) {
    return;
  }
  // The provisioning chokepoint restores the material FIRST, then atomically writes
  // the strict expiry audit + deletes this row. Keeping the expired row until that
  // succeeds makes it a durable retry marker across restarts and prevents a timer-only
  // fail-open window.
  cancelScheduledExpiry(userId, provider);
  invalidateProvisioned(userId);
  provisionUserDirs(userId);
  const pending = governanceExemptionsDb.findStored(userId, provider);
  if (pending?.expiresAt === expectedExpiresAt) {
    const retry = setTimeout(
      () => expireExemption(userId, provider, expectedExpiresAt),
      30_000,
    );
    retry.unref?.();
    expiryTimers.set(timerKey(userId, provider), retry);
  }
}

function scheduleExpiry(
  userId: string | number,
  provider: LLMProvider,
  expiresAt: string,
): void {
  cancelScheduledExpiry(userId, provider);
  const delay = Math.max(0, Date.parse(expiresAt) - Date.now());
  const timer = setTimeout(() => expireExemption(userId, provider, expiresAt), delay);
  timer.unref?.();
  expiryTimers.set(timerKey(userId, provider), timer);
}

function reconcileExpiredForUser(userId: string | number | null): void {
  if (userId === null || userId === '') return;
  for (const stored of governanceExemptionsDb.listStoredForUser(userId)) {
    const provider = GOVERNANCE_CHANNEL_PROVIDERS.find((item) => item === stored.provider);
    if (!provider) continue;
    if (Date.parse(stored.expiresAt) <= Date.now()) {
      expireExemption(userId, provider, stored.expiresAt);
    } else if (!expiryTimers.has(timerKey(userId, provider))) {
      scheduleExpiry(userId, provider, stored.expiresAt);
    }
  }
}

export const governancePreferencesService = {
  listChannels(actor: GovernanceActorContext): GovernanceChannelView[] {
    reconcileExpiredForUser(actor.userId);
    return GOVERNANCE_CHANNEL_PROVIDERS.map((provider) => describe(provider, actor));
  },

  setMode(
    provider: LLMProvider,
    mode: GovernanceMode,
    actor: GovernanceActorContext,
  ): GovernanceChannelView {
    const principal = requirePrincipal(actor);
    // T-1675: while this member runs `provider` on a credential another member
    // delegated to them, the material plan below resolves into the GRANTOR's
    // tree — removal would strip the grantor's governance and restoration would
    // repair the member's own. Neither side may be touched from here.
    const sharingKey = provider === 'antigravity' ? 'agy' : provider;
    if (resolveCredentialPrincipal(principal, sharingKey).grantedBy !== null) {
      throw new AppError(
        'Governance cannot be changed while this engine runs on a credential shared with you. Switch to your own credential first.',
        { code: 'GOVERNANCE_MODE_DELEGATED', statusCode: 409 },
      );
    }
    const plan = resolveGovernanceMaterialPlan(provider, principal);

    if (mode === 'exempt') {
      if (actor.platformMode) {
        throw new AppError('Governance exemptions are unavailable in platform mode.', {
          code: 'GOVERNANCE_MODE_PLATFORM_FORBIDDEN', statusCode: 403,
        });
      }
      if (!canGrant(actor)) {
        throw new AppError('Only an admin or owner may grant an exemption.', {
          code: 'GOVERNANCE_MODE_FORBIDDEN', statusCode: 403,
        });
      }
      if (!plan.exemptible) {
        throw new AppError('This engine has no per-user governance exemption.', {
          code: 'GOVERNANCE_MODE_UNAVAILABLE', statusCode: 400,
          details: { refusal: plan.refusal },
        });
      }
      if (governanceExemptionsDb.isExempt(principal, provider)) {
        return describe(provider, actor);
      }
      // Remove the carrier material before activating the exemption. If removal
      // is partial, provisioning restores it while the database remains governed.
      // The exemption and its forensic row then commit in one SQLite transaction;
      // a strict-audit fault rolls the exemption back instead of leaving a bypass.
      try {
        removeMaterial(plan.paths);
      } catch (error) {
        restoreMaterial(principal);
        throw error;
      }
      const expiresAt = new Date(Date.now() + GOVERNANCE_EXEMPTION_TTL_MS).toISOString();
      try {
        database.getConnection().transaction(() => {
          governanceExemptionsDb.grant(principal, provider, principal, expiresAt);
          auditLogDb.recordStrict('governance_exemption_granted', {
            userId: Number(principal),
            metadata: {
              provider,
              role: actor.role,
              enforcement: plan.enforcement,
              resultMode: 'exempt',
              expiresAt,
            },
            ipAddress: actor.ipAddress ?? null,
            userAgent: actor.userAgent ?? null,
          });
        })();
      } catch (error) {
        restoreMaterial(principal);
        throw error;
      }
      scheduleExpiry(principal, provider, expiresAt);
    } else {
      const stored = governanceExemptionsDb.findStored(principal, provider);
      if (!stored) {
        restoreMaterial(principal);
        return describe(provider, actor);
      }

      // Commit the governed state and its strict audit together, then force the
      // provisioning chokepoint to restore the carrier material. Provider launch
      // gates remain fail-closed if that restoration cannot be attested.
      database.getConnection().transaction(() => {
        auditLogDb.recordStrict('governance_exemption_revoked', {
          userId: Number(principal),
          metadata: { provider, role: actor.role, enforcement: plan.enforcement },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
        });
        governanceExemptionsDb.revoke(principal, provider);
      })();
      cancelScheduledExpiry(principal, provider);
      restoreMaterial(principal);
    }

    const result = describe(provider, actor);
    return result;
  },
};
