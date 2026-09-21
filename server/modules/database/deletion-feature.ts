import type { ProtocolFloor } from './platform-protocol-registry.js';

export type DeletionMode = 'off' | 'observe' | 'guard' | 'on';
/** Capture configuration once at composition/boot; callers retain the returned immutable value. */
export function readDeletionFeature(env: Readonly<Record<string, string | undefined>>): DeletionMode {
  const mode = env.NASSAJ_HONEST_DELETION ?? 'off';
  if (mode !== 'off' && mode !== 'observe' && mode !== 'guard' && mode !== 'on') {
    throw new Error('DELETION_MODE_INVALID');
  }
  return mode;
}

/** Guard expectations come from installed markers, never from another feature's flag. */
export function deletionPosture(mode: DeletionMode, floor: ProtocolFloor) {
  const installed = floor.some(row => row.feature === 'deletion');
  if (!installed && (mode === 'guard' || mode === 'on')) throw new Error('DELETION_MARKER_REQUIRED');
  return Object.freeze({
    preserveFeatureGuards: Object.freeze(floor.map(row => row.feature)),
    deletionGuardsRequired: installed,
    legacyDeletionAllowed: !installed,
    // S1a cannot activate deletion: reconciliation/adapters/rehearsal do not exist yet.
    permanentDeletionAllowed: false,
    permanentDeletionStatus: 503,
  });
}
