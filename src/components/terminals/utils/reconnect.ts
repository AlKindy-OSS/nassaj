// Auto-reconnect helpers for the standalone terminals feature. Backoff tuning is
// shared with the shell terminal (single source of truth) and re-exported here;
// the close-code classifier is terminal-specific because standalone terminals
// use dedicated policy codes (4404/4409/4403).
export {
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
  computeBackoffDelay,
  shouldRetryReconnect,
  UPDATE_TERMINALS_CLOSED_REASON,
} from '../../shell/utils/reconnect';
import { UPDATE_TERMINALS_CLOSED_REASON } from '../../shell/utils/reconnect';

/**
 * How the client should react to a `/terminal` socket close:
 * - `superseded` (4409): a newer tab won the attachment — final.
 * - `notFound`   (4404): the terminal id is unknown — final.
 * - `closedForUpdate` (4404 + reason `update_terminals_closed`): the owner
 *   closed every terminal to install an update (B-1448) — final.
 * - `forbidden`  (4403): admin/policy rejection — final.
 * - `serverRestart` (1001): clean going-away — manual re-attach, no auto loop.
 * - `reconnect`  (1006 / anything else): abnormal drop while the PTY survives —
 *   auto re-attach with backoff.
 */
export type TerminalCloseDisposition =
  | 'superseded'
  | 'notFound'
  | 'closedForUpdate'
  | 'forbidden'
  | 'serverRestart'
  | 'reconnect';

export function classifyTerminalClose(code: number, reason = ''): TerminalCloseDisposition {
  switch (code) {
    case 4409:
      return 'superseded';
    case 4404:
      return reason === UPDATE_TERMINALS_CLOSED_REASON ? 'closedForUpdate' : 'notFound';
    case 4403:
      return 'forbidden';
    case 1001:
      return 'serverRestart';
    default:
      return 'reconnect';
  }
}
