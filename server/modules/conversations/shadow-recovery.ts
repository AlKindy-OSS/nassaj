import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

export type ShadowRecoveryDisposition =
  | 'safe_unstarted'
  | 'requires_reconciliation'
  | 'operator_review';

export interface ShadowRecoveryReport {
  conversationId: string;
  writerEpoch: number;
  classified: number;
  safeUnstarted: number;
  requiresReconciliation: number;
  operatorReview: number;
}

type RecoveryCandidate = {
  record_type: 'command' | 'effect' | 'attempt' | 'parity' | 'link_candidate';
  record_id: string;
  prior_state: string;
};

function recoveryId(
  conversationId: string,
  writerEpoch: number,
  candidate: RecoveryCandidate,
): string {
  const digest = createHash('sha256')
    .update([
      'shadow-recovery-v1',
      conversationId,
      String(writerEpoch),
      candidate.record_type,
      candidate.record_id,
      candidate.prior_state,
    ].join('\u001f'))
    .digest('hex');
  return `recovery_${digest.slice(0, 40)}`;
}

function dispositionFor(candidate: RecoveryCandidate): ShadowRecoveryDisposition {
  if (
    (candidate.record_type === 'effect' && candidate.prior_state === 'prepared')
    || (candidate.record_type === 'attempt' && candidate.prior_state === 'scheduled')
  ) {
    return 'safe_unstarted';
  }
  if (
    candidate.prior_state === 'uncertain'
    || candidate.prior_state === 'pending'
    || (candidate.record_type === 'command' && candidate.prior_state === 'prepared')
  ) {
    return 'operator_review';
  }
  return 'requires_reconciliation';
}

/**
 * Classifies incomplete durable work before writer activation.
 *
 * Phase 0 intentionally performs no provider call, effect, retry, or state
 * transition. A later reconciler may act on this evidence; startup only proves
 * every incomplete record was seen under the newly fenced writer epoch.
 */
export class ShadowConversationRecoveryService {
  constructor(private readonly db: Database.Database) {}

  recoverConversation(input: {
    conversationId: string;
    instanceId: string;
    writerEpoch: number;
  }): ShadowRecoveryReport {
    const writer = this.db
      .prepare(
        `SELECT state, owner_instance_id, writer_epoch
           FROM conversation_writer_state
          WHERE conversation_id = ?`,
      )
      .get(input.conversationId) as
      | { state: string; owner_instance_id: string | null; writer_epoch: number }
      | undefined;
    if (
      !writer
      || writer.state !== 'recovering'
      || writer.owner_instance_id !== input.instanceId
      || writer.writer_epoch !== input.writerEpoch
    ) {
      throw new Error('SHADOW_RECOVERY_REQUIRES_FENCED_RECOVERING_WRITER');
    }

    const candidates = this.readCandidates(input.conversationId);
    const counts = {
      safe_unstarted: 0,
      requires_reconciliation: 0,
      operator_review: 0,
    } satisfies Record<ShadowRecoveryDisposition, number>;

    this.db.transaction(() => {
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO conversation_shadow_recovery
          (recovery_id, conversation_id, writer_epoch, record_type,
           record_id, prior_state, disposition)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const candidate of candidates) {
        const disposition = dispositionFor(candidate);
        counts[disposition] += 1;
        insert.run(
          recoveryId(input.conversationId, input.writerEpoch, candidate),
          input.conversationId,
          input.writerEpoch,
          candidate.record_type,
          candidate.record_id,
          candidate.prior_state,
          disposition,
        );
      }
    })();

    return {
      conversationId: input.conversationId,
      writerEpoch: input.writerEpoch,
      classified: candidates.length,
      safeUnstarted: counts.safe_unstarted,
      requiresReconciliation: counts.requires_reconciliation,
      operatorReview: counts.operator_review,
    };
  }

  private readCandidates(conversationId: string): RecoveryCandidate[] {
    return this.db
      .prepare(
        `SELECT 'command' AS record_type, command_id AS record_id, state AS prior_state
           FROM conversation_commands
          WHERE conversation_id = ? AND state IN ('prepared', 'dispatched', 'uncertain')
         UNION ALL
         SELECT 'effect' AS record_type, effect_id AS record_id, state AS prior_state
           FROM effect_ledger
          WHERE conversation_id = ? AND state IN ('prepared', 'dispatched', 'uncertain')
         UNION ALL
         SELECT 'attempt' AS record_type, attempt_id AS record_id,
                CASE
                  WHEN state = 'terminal' AND terminal_outcome = 'uncertain' THEN 'uncertain'
                  ELSE state
                END AS prior_state
           FROM conversation_attempts
          WHERE conversation_id = ?
            AND (state IN ('scheduled', 'starting', 'running', 'recovering')
                 OR (state = 'terminal' AND terminal_outcome = 'uncertain'))
         UNION ALL
         SELECT 'parity' AS record_type, run_id AS record_id, 'pending' AS prior_state
           FROM conversation_shadow_parity
          WHERE conversation_id = ? AND terminal_observed = 0
         UNION ALL
         SELECT 'link_candidate' AS record_type, observation_id AS record_id,
                'pending' AS prior_state
           FROM conversation_shadow_observations
          WHERE conversation_id = ? AND legacy_kind = 'session_created'
            AND verification_state = 'pending'
         ORDER BY record_type, record_id`,
      )
      .all(
        conversationId,
        conversationId,
        conversationId,
        conversationId,
        conversationId,
      ) as RecoveryCandidate[];
  }
}
