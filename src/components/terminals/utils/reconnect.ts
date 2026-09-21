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
} from '../../shell/utils/reconnect';

/**
 * How the client should react to a `/terminal` socket close:
 * - `superseded` (4409): a newer tab won the attachment — final.
 * - `notFound`   (4404): the terminal id is unknown — final.
 * - `forbidden`  (4403): admin/policy rejection — final.
 * - `serverRestart` (1001): clean going-away — manual re-attach, no auto loop.
 * - `reconnect`  (1006 / anything else): abnormal drop while the PTY survives —
 *   auto re-attach with backoff.
 */
export type TerminalCloseDisposition =
  | 'superseded'
  | 'notFound'
  | 'forbidden'
  | 'serverRestart'
  | 'reconnect';

export function classifyTerminalClose(code: number): TerminalCloseDisposition {
  switch (code) {
    case 4409:
      return 'superseded';
    case 4404:
      return 'notFound';
    case 4403:
      return 'forbidden';
    case 1001:
      return 'serverRestart';
    default:
      return 'reconnect';
  }
}
