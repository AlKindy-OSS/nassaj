/**
 * Declared session handover for one isolated launch (agy spawn key -> brain UUID).
 *
 * Some providers mint a transient launch id, announce it (the workspace bind
 * keys the overlay alias and ledger row to it), and only learn the durable
 * conversation id when the process exits. The provider asks for the swap
 * through `requestSessionHandover({ from, to })` and receives a verdict
 * synchronously; it may move its own records and announce `to` only when
 * accepted. Acceptance requires ALL of:
 *   1. `from` is the id this launch bound, and has the provider's spawn-key shape;
 *   2. it is the first handover of the launch (an identical repeat is idempotent);
 *   3. the provider is on the allow-list;
 *   4. `to` has no ledger row and no overlay alias;
 *   5. no other principal participates in `to`;
 *   6. (qa C2) the `to` sessions row has this provider and logical project, its
 *      jsonl_path is inside THIS user's brain dir, and the brain dir itself was
 *      born after the spawn started.
 * Checks 4-6 run inside the overlay state lock and the DB transaction.
 */

import fs from 'node:fs';
import path from 'node:path';

type HandoverRow = { provider: string; project_path: string; jsonl_path: string | null };

export type SessionHandoverRequest = { from?: unknown; to?: unknown; spawnStartedAtMs?: unknown };
export type SessionHandoverVerdict = { accepted: boolean; reason: string };

type HandoverProviderRule = { spawnKey: RegExp; durableId: RegExp };

export type SessionHandoverGateInput = {
  provider: string;
  isolation: 'overlay' | 'legacy_shared';
  logicalProjectPath: string;
  launchKey: string | null;
  principalId: string | number | null;
  principalUserId: number | null;
  /** Wall clock when this launch was admitted; the brain must be younger. */
  launchStartedAtMs: number;
  /** The id this launch bound on its first `session_created`, if any. */
  boundSessionId: () => string | null;
  rules: Readonly<Record<string, HandoverProviderRule>>;
  brainDirForUser: (userId: number | null) => string;
  rekeyLedger: (input: {
    fromSessionId: string;
    toSessionId: string;
    mode: 'overlay' | 'legacy_shared';
    projectPath: string;
    provider: string;
    principalUserId: number | null;
    verifyTarget: (row: HandoverRow) => void;
  }) => void;
  rebindWorkspace?: (input: {
    projectPath: string;
    launchKey: string;
    fromSessionId: string;
    toSessionId: string;
    principalId: string | number | null;
    commitLedger: () => void;
  }) => { generation: string | null };
};

/** Coarse filesystem clocks may stamp a just-created dir a tick before Date.now(). */
export const BRAIN_BIRTH_CLOCK_TOLERANCE_MS = 20;

/** One accepted handover of this launch; `forwarded` flips when `to` is announced. */
export type AcceptedHandover = {
  from: string;
  to: string;
  generation: string | null;
  forwarded: boolean;
};

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function brainDirCandidates(brainDir: string): string[] {
  const candidates = [path.resolve(brainDir)];
  try {
    candidates.push(fs.realpathSync(brainDir));
  } catch {
    // A missing brain dir leaves only the lexical form, which then fails below.
  }
  return candidates;
}

/** C2 evidence: the target transcript and brain dir belong to THIS user and THIS run. */
function assertBrainEvidence(
  row: HandoverRow,
  to: string,
  brainDir: string,
  notBeforeMs: number,
): void {
  const jsonlPath = typeof row.jsonl_path === 'string' ? path.resolve(row.jsonl_path) : '';
  const bases = brainDirCandidates(brainDir);
  if (!jsonlPath || !bases.some((base) => isWithin(path.join(base, to), jsonlPath))) {
    throw new Error('handover target transcript is outside this user brain dir');
  }
  const brainPath = path.join(brainDir, to);
  const stat = fs.lstatSync(brainPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('handover target brain is not a plain directory');
  }
  // Prefer the birth time: a directory's mtime moves whenever an entry is
  // added, so an OLD foreign brain written during the window would pass.
  const bornAtMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
  if (bornAtMs + BRAIN_BIRTH_CLOCK_TOLERANCE_MS < notBeforeMs) {
    throw new Error('handover target brain predates this launch');
  }
}

/** Creates the per-launch gate. `accepted()` exposes the committed handover, if any. */
export function createSessionHandoverGate(input: SessionHandoverGateInput): {
  request(request: SessionHandoverRequest): SessionHandoverVerdict;
  accepted(): AcceptedHandover | null;
} {
  let committed: AcceptedHandover | null = null;
  let refusedOnce = false;
  const reject = (reason: string): SessionHandoverVerdict => {
    refusedOnce = true;
    console.warn('Session handover rejected', { provider: input.provider, reason });
    return { accepted: false, reason };
  };

  const request = (raw: SessionHandoverRequest): SessionHandoverVerdict => {
    const from = typeof raw?.from === 'string' ? raw.from : '';
    const to = typeof raw?.to === 'string' ? raw.to : '';
    if (committed) {
      return committed.from === from && committed.to === to
        ? { accepted: true, reason: 'idempotent_repeat' }
        : reject('handover_already_used');
    }
    if (refusedOnce) return reject('handover_already_refused');
    const rule = Object.hasOwn(input.rules, input.provider) ? input.rules[input.provider] : null;
    if (!rule) return reject('provider_not_allowed');
    const bound = input.boundSessionId();
    if (!from || from !== bound || !rule.spawnKey.test(from)) return reject('source_not_bound_spawn_key');
    if (!to || to === from || !rule.durableId.test(to)) return reject('target_id_invalid');
    const claimedStart = typeof raw.spawnStartedAtMs === 'number' && Number.isFinite(raw.spawnStartedAtMs)
      ? Math.min(raw.spawnStartedAtMs, Date.now())
      : 0;
    const notBeforeMs = Math.max(input.launchStartedAtMs, claimedStart);
    const brainDir = input.brainDirForUser(input.principalUserId);
    const commitLedger = (): void => input.rekeyLedger({
      fromSessionId: from,
      toSessionId: to,
      mode: input.isolation,
      projectPath: input.logicalProjectPath,
      provider: input.provider,
      principalUserId: input.principalUserId,
      verifyTarget: (row) => assertBrainEvidence(row, to, brainDir, notBeforeMs),
    });
    try {
      let generation: string | null = null;
      if (input.isolation === 'overlay') {
        if (!input.rebindWorkspace || !input.launchKey) return reject('overlay_rebind_unavailable');
        generation = input.rebindWorkspace({
          projectPath: input.logicalProjectPath,
          launchKey: input.launchKey,
          fromSessionId: from,
          toSessionId: to,
          principalId: input.principalId,
          commitLedger,
        }).generation;
      } else {
        // Shared (non-overlay) launches own no alias: the ledger row is the
        // whole binding, rekeyed with mode kept legacy_shared.
        commitLedger();
      }
      committed = { from, to, generation, forwarded: false };
      return { accepted: true, reason: 'accepted' };
    } catch (error) {
      return reject(error instanceof Error ? error.message : String(error));
    }
  };

  return { request, accepted: () => committed };
}
