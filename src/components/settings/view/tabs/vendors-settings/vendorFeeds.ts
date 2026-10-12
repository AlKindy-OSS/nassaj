import type {
  CompanyProjection,
  CompanySlotResult,
  CompanySlotStatus,
  ProjectionState,
} from '../../../../provider-auth/hooks/useCompanyKey';
import type { Vendor } from '../../../../../../shared/vendors';

/**
 * Pure derivation of the «يغذّي:» badge row (ADR-200 S9, brief §1). No React, so
 * the state table is unit-tested on plain objects.
 */

/** Everything a badge can say: the ledger states plus the one Save-only refusal. */
export type FeedState = ProjectionState | 'forbidden';

export type FeedItem = {
  vendorId: string;
  provider: string;
  harness: string;
  state: FeedState;
};

export type FeedTone = 'success' | 'warning' | 'danger' | 'neutral';

/**
 * Tone by meaning. Billing-relevant states never sit on the light-mode info or
 * neutral tones, whose contrast measures under AA (B-1573): a key that moves
 * money is success, warning or danger.
 */
export const FEED_TONE: Record<FeedState, FeedTone> = {
  linked: 'success',
  stale: 'warning',
  adopted: 'warning',
  foreign_credential: 'warning',
  failed: 'danger',
  tombstone: 'neutral',
  kept_on_subscription: 'neutral',
  mode_unset: 'neutral',
  login_present: 'neutral',
  shared_scope_refused: 'neutral',
  forbidden: 'neutral',
};

/** States that carry an action line in a tooltip. `linked` and `forbidden` do not. */
export const FEED_STATES_WITH_ACTION: readonly FeedState[] = [
  'stale', 'failed', 'tombstone', 'foreign_credential', 'adopted',
  'kept_on_subscription', 'mode_unset', 'login_present', 'shared_scope_refused',
];

/** Brand names, identical in every locale (hence not translated). */
const HARNESS_NAME: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  glm: 'GLM',
  deepseek: 'DeepSeek',
  qwen: 'Qwen',
};

/** Slots that live only in the encrypted store: the engine pin reads them. */
const ENGINE_PIN_PROVIDERS: readonly string[] = ['kimi', 'glm', 'deepseek'];

export function harnessName(provider: string): string {
  return HARNESS_NAME[provider] ?? provider;
}

/** An AES-only slot (`kimi`/`glm`/`deepseek`): saving it also writes the unified engine-pin key. */
export function isEnginePinVendor(vendor: Vendor): boolean {
  return vendor.store === 'aes' && vendor.slot !== null && ENGINE_PIN_PROVIDERS.includes(vendor.slot.provider);
}

/** A Save outcome as a badge state; Delete outcomes (`removed`…) say nothing about the row. */
function stateOfOutcome(outcome: CompanySlotResult['outcome']): FeedState | null {
  switch (outcome) {
    case 'written': return 'linked';
    case 'skipped_subscription': return 'kept_on_subscription';
    case 'removed':
    case 'absent':
    case 'adopted_credential': return null;
    default: return outcome;
  }
}

type FeedInput = {
  vendors: readonly Vendor[];
  slots: readonly CompanySlotStatus[];
  /** `null` when the server sends none (flag OFF): fall back to `configured`. */
  projections: readonly CompanyProjection[] | null;
  /** The last Save result, newest information, so it wins over the ledger. */
  saveResults: readonly CompanySlotResult[] | null;
};

function feedStateFor(vendor: Vendor, input: FeedInput): FeedState | null {
  const saved = input.saveResults?.find((slot) => slot.vendorId === vendor.id);
  const fromSave = saved ? stateOfOutcome(saved.outcome) : null;
  if (fromSave) return fromSave;
  const projected = input.projections?.find((entry) => entry.vendorId === vendor.id);
  if (projected) return projected.state;
  return input.slots.some((slot) => slot.vendorId === vendor.id && slot.configured) ? 'linked' : null;
}

/** One item per slot that has something to say, in catalogue order. */
export function buildFeedItems(input: FeedInput): FeedItem[] {
  const items: FeedItem[] = [];
  for (const vendor of input.vendors) {
    const state = feedStateFor(vendor, input);
    if (state && vendor.slot) {
      items.push({
        vendorId: vendor.id,
        provider: vendor.slot.provider,
        harness: harnessName(vendor.slot.provider),
        state,
      });
    }
  }
  return items;
}

/** Items whose key nassaj did not write: the delete dialog offers to remove them too. */
export function foreignItems(items: readonly FeedItem[]): FeedItem[] {
  return items.filter((item) => item.state === 'adopted' || item.state === 'foreign_credential');
}
