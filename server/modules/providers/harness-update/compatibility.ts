/**
 * Harness compatibility verdict (T-1871 / ADR-159 Addendum 4, qa M-4).
 *
 * Pure: no I/O, no clock, no env. The caller supplies the digest-pin table and
 * the pin posture. Precedence, highest first:
 *   1. version unreadable                     → untested / version-unknown
 *   2. pinned harness, version === pin        → compatible / pin-match
 *   3. pinned, mismatch, pin armed            → incompatible / pin-armed-blocked
 *   4. pinned, mismatch, a mode always
 *      enforces the pin (GLM carrier)         → incompatible / <mode>-blocked
 *   5. pinned, mismatch, nothing enforces     → untested / pin-mismatch-unreviewed
 *   6. version === compat baseline            → baseline / baseline-match
 *   7. baseline exists, version differs       → untested / not-baselined
 *   8. no data at all                         → untested / no-compat-data
 * Additive (T-1872): an installed release the launch guard refused
 * (runtimeIncompatible) is incompatible / runtime-incompatible right after 1.
 *
 * `incompatible` is reserved for versions Nassaj WILL refuse to run: a claim
 * that a version "breaks" without an enforcing guard would be a guess.
 * `compatible` on a pin match is a version comparison only; the bytes are still
 * digest-checked at spawn wherever the pin is enforced.
 */

import type { HarnessCompatibility } from '../../../../shared/harness-update.contract.js';

import type { HarnessCompat } from './descriptors.js';

/** Minimal pin entry this module reads (matches PINNED_VENDOR_DIGESTS values). */
export interface PinEntry {
  version: string;
}

export interface CompatibilityInput {
  /** Parsed version to judge (installed or latest), or null when unreadable. */
  version: string | null;
  /** The harness descriptor's pin key + compat data. */
  descriptor: { pinKey: string | null; compat?: HarnessCompat };
  /** Digest-pin table (PINNED_VENDOR_DIGESTS). */
  pins: Readonly<Record<string, PinEntry>>;
  /** NASSAJ_VENDOR_BINARY_PIN armed → every mode enforces the pin. */
  pinArmed: boolean;
  /** A mode of this harness enforces the pin even when the flag is off. */
  carrierAlwaysEnforced: boolean;
  /**
   * T-1872: the launch-time runtime-compat verdict refused this exact installed
   * release (codex-runtime-compat.js). Pass only for the installed version.
   */
  runtimeIncompatible?: boolean;
}

/** Builds one verdict object. */
function verdict(
  state: HarnessCompatibility['state'],
  reason: string,
  referenceVersion: string | null = null,
  extra: Partial<Pick<HarnessCompatibility, 'asOf' | 'blockedModes'>> = {},
): HarnessCompatibility {
  return {
    state,
    reason,
    referenceVersion,
    asOf: extra.asOf ?? null,
    blockedModes: extra.blockedModes ?? [],
  };
}

/** Verdict for a pinned harness whose version is known, or null when not pinned. */
function pinVerdict(input: CompatibilityInput, version: string): HarnessCompatibility | null {
  const { descriptor, pins } = input;
  const pin = descriptor.pinKey === null ? undefined : pins[descriptor.pinKey];
  if (!pin) return null;
  if (version === pin.version) return verdict('compatible', 'pin-match', pin.version);
  if (input.pinArmed) {
    return verdict('incompatible', 'pin-armed-blocked', pin.version, { blockedModes: ['all'] });
  }
  if (input.carrierAlwaysEnforced) {
    const mode = descriptor.compat?.alwaysEnforcedMode ?? 'carrier';
    return verdict('incompatible', `${mode}-blocked`, pin.version, { blockedModes: [mode] });
  }
  return verdict('untested', 'pin-mismatch-unreviewed', pin.version);
}

/** Computes the compatibility verdict for one harness version. Never throws. */
export function computeHarnessCompatibility(input: CompatibilityInput): HarnessCompatibility {
  const { version, descriptor } = input;
  if (version === null || version.trim() === '') return verdict('untested', 'version-unknown');
  if (input.runtimeIncompatible) return verdict('incompatible', 'runtime-incompatible', null, { blockedModes: ['all'] });

  const pinned = pinVerdict(input, version);
  if (pinned) return pinned;

  const baseline = descriptor.compat?.baseline ?? null;
  if (!baseline) return verdict('untested', 'no-compat-data');
  if (version === baseline.version) {
    return verdict('baseline', 'baseline-match', baseline.version, { asOf: baseline.date });
  }
  return verdict('untested', 'not-baselined', baseline.version, { asOf: baseline.date });
}
