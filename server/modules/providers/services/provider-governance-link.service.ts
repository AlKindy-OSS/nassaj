/**
 * provider-governance-link.service — the ONE write path of ADR-093 (§4, T-1197):
 * "link this agent to nassaj instructions".
 *
 * WHY A SEPARATE MODULE (§4.3, non-negotiable)
 * --------------------------------------------
 * provider-governance.service.ts is READ-ONLY by architectural decision: calling a
 * provisioning path from it would turn every badge query into a silent write that
 * then reports the "governed" it just created. So the button does NOT reach into
 * that service — it lands here, and the reader stays write-free forever. This
 * module imports the reader (for the plan and the post-write verdict); the reader
 * never imports this one.
 *
 * WHAT IT WRITES, AND WHERE
 * -------------------------
 * A real, read-only (0444) COPY of the neutral governance source at
 * <home>/<filename> — never a symlink, without exception (§4.1): agy runs
 * --dangerously-skip-permissions and codex danger-full-access, so a link into the
 * shared source is a write-through vector by which one user's turn could rewrite
 * every user's governance. Both `home` and the source path come from
 * resolveGovernanceLinkPlan, i.e. from the provider id and the AUTHENTICATED user
 * id alone. No path, prefix or filename ever arrives from the client, so the write
 * cannot be aimed.
 *
 * ATOMIC (tmp + rename), a DECLARED refinement of §4.1's "call the primitives"
 * --------------------------------------------------------------------------
 * The shared primitive materializeGovernanceCopy writes in place: rm, then write.
 * That is right for the spawn guard (it is the repair, and it re-checks), but on
 * THIS path a concurrent launch could observe the gap — and for codex/opencode/kimi
 * an unattested read is fail-closed. So the copy is staged in the SAME directory
 * and moved with rename(2), which is atomic on one filesystem: a reader sees the
 * old file or the new one, never neither. The ARTIFACT is byte-identical to the
 * primitive's (same source bytes via readNeutralSource, same 0444 mode), and the
 * result is verified with the SAME identity function the spawn guard trusts
 * (governanceMatchesSource) — so this never becomes a second, drifting mechanism.
 * The shared primitive itself is untouched.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  providerGovernanceService,
  resolveGovernanceLinkPlan,
  type GovernanceLinkPlan,
  type ProviderGovernanceDescriptor,
} from '@/modules/providers/services/provider-governance.service.js';
import {
  DEFAULT_GOVERNANCE_FILE_MODE,
  governanceMatchesSource,
  readNeutralSource,
} from '@/services/isolation/vendor-cli-governance-material.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export interface GovernanceLinkResult {
  /** The governance file established, for the audit trail (never shown as proof). */
  governancePath: string;
  /** Whose tree it landed in — 'operator' means it affects every user on this node. */
  linkScope: NonNullable<GovernanceLinkPlan['linkScope']>;
  /**
   * The verdict RE-READ from disk after the write. The surface must render this,
   * not an optimistic "done": if the copy did not take, the honest answer is
   * "still ungoverned", not a green message (ADR-093 §2.4).
   */
  descriptor: ProviderGovernanceDescriptor;
}

/**
 * Stages the copy beside its target and moves it into place atomically.
 * Never partially replaces an existing file; on any failure the staged file is
 * removed and the previous state is left exactly as it was.
 */
function materializeAtomicCopy(home: string, filename: string, sourcePath: string): string {
  const source = readNeutralSource(sourcePath) as { content: Buffer } | null;
  if (!source) {
    // No neutral source on this node: there is nothing authentic to install, and
    // inventing content would be the one thing this whole subsystem forbids.
    throw new AppError('No usable nassaj governance source on this node.', {
      code: 'GOVERNANCE_SOURCE_ABSENT',
      statusCode: 409,
    });
  }

  const target = path.join(home, filename);
  // A dot-prefixed, randomized staging name in the SAME directory: same filesystem
  // (so rename is atomic, never a cross-device copy) and no collision between two
  // concurrent links.
  const staged = path.join(home, `.${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`);

  try {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // 'wx' — refuse to write through an existing entry (a planted symlink included).
    fs.writeFileSync(staged, source.content, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(staged, DEFAULT_GOVERNANCE_FILE_MODE);
    // rename(2) replaces the target atomically; it removes the DIRECTORY ENTRY of
    // whatever was there (a stale copy or a hostile symlink) and never follows a
    // link, so the shared source can never be written through.
    fs.renameSync(staged, target);
  } catch (err) {
    fs.rmSync(staged, { force: true });
    throw new AppError('Could not establish the governance copy.', {
      code: 'GOVERNANCE_LINK_FAILED',
      statusCode: 500,
      details: { errno: (err as NodeJS.ErrnoException)?.code ?? null },
    });
  }

  // Identity, not existence: verified by the SAME function the fail-closed spawn
  // guard reads, so "linked" means exactly what "governed" means at launch.
  if (!governanceMatchesSource(target, sourcePath)) {
    throw new AppError('The governance copy could not be attested after writing.', {
      code: 'GOVERNANCE_LINK_UNVERIFIED',
      statusCode: 500,
    });
  }
  return target;
}

export const providerGovernanceLinkService = {
  /**
   * Establishes nassaj governance for one (provider, user) and returns the verdict
   * re-read from disk.
   *
   * AUTHORIZATION IS NOT HERE: the operator-home/owner rule (§4.2) is enforced at
   * the route, where the caller's role lives. This service refuses only what is
   * refusable without a request — an engine with no link mechanism — so it can
   * never be called into doing something the plan forbids.
   *
   * @param provider the engine to link
   * @param userId   the AUTHENTICATED caller id (drives the isolation gate; the
   *                 client never supplies a home)
   */
  link(provider: LLMProvider, userId: string | number | null): GovernanceLinkResult {
    const plan = resolveGovernanceLinkPlan(provider, userId);
    if (!plan.linkable || !plan.home || !plan.filename || !plan.sourcePath || !plan.linkScope) {
      throw new AppError('This engine has no governance channel to establish.', {
        code: 'GOVERNANCE_LINK_UNAVAILABLE',
        statusCode: 400,
        details: { refusal: plan.refusal },
      });
    }

    const governancePath = materializeAtomicCopy(plan.home, plan.filename, plan.sourcePath);

    return {
      governancePath,
      linkScope: plan.linkScope,
      descriptor: providerGovernanceService.getGovernance(provider, userId),
    };
  },
};
