/**
 * T-2037 — client-side risk read of a composer shell command, BEFORE anything
 * is sent. It is advisory only: the server's denylist
 * (server/services/command-board-raw.js) stays authoritative and refuses on its
 * own. The categories reuse that file's rule codes so the two vocabularies stay
 * comparable:
 *
 *   blocked — `kill_by_name` (pkill/killall): the server always refuses it, so
 *             we do not even offer a confirm.
 *   danger  — pm2 / systemctl / kill / host power verbs: a destructive-tone
 *             confirm showing the exact command.
 *   tmpfs   — installs, builds, clones or browser downloads aimed at /tmp or
 *             /dev/shm (RAM-backed): a warning confirm, because the agent hooks
 *             that normally stop this do not see a shell typed by hand.
 */

export type ShellDangerRule = 'pm2_lifecycle' | 'systemctl_lifecycle' | 'kill' | 'host_power';

export interface ShellCommandRisk {
  /** Server rule that will refuse it outright; never confirmable. */
  blocked: 'kill_by_name' | null;
  danger: ShellDangerRule | null;
  tmpfs: boolean;
}

/**
 * A command word: at the start, or after whitespace / a shell separator /
 * quote, optionally behind a path (`/usr/bin/pm2`, `./kill`), and followed by
 * the end or a separator. So `kill` never matches `pkill`, `killall`, `skill`
 * or `./kill.log`, while `/sbin/reboot` and `/usr/bin/pkill` do match (qa high-2).
 */
function commandWord(names: string): RegExp {
  return new RegExp(`(?:^|[\\s;&|()'"\`=])(?:[^\\s;&|()'"\`]*/)?(?:${names})(?=$|[\\s;&|()'"\`])`);
}

const BLOCKED_RE = commandWord('pkill|killall');

const DANGER_RULES: ReadonlyArray<{ rule: ShellDangerRule; re: RegExp }> = [
  { rule: 'pm2_lifecycle', re: commandWord('pm2') },
  { rule: 'systemctl_lifecycle', re: commandWord('systemctl') },
  { rule: 'host_power', re: commandWord('reboot|shutdown|halt|poweroff') },
  { rule: 'kill', re: commandWord('kill') },
];

const TMPFS_ACTION_RE =
  /(?<![\w-])(?:npm\s+(?:ci|install|i)(?![\w-])|(?:npm|pnpm|yarn)\s+(?:run\s+)?build(?![\w-])|vite\s+build(?![\w-])|git\s+(?:clone|worktree\s+add)(?![\w-])|playwright\s+install(?![\w-]))/;
const TMPFS_PATH_RE = /(?:^|[\s=:'"(])(?:\/tmp|\/dev\/shm)(?:\/|\s|$|['")])/;

/** Classifies a command. Case-insensitive on the verbs, like the server. */
export function classifyShellCommand(command: string): ShellCommandRisk {
  const text = command.toLowerCase();
  const blocked = BLOCKED_RE.test(text) ? 'kill_by_name' : null;
  const danger = DANGER_RULES.find(({ re }) => re.test(text))?.rule ?? null;
  const tmpfs = TMPFS_ACTION_RE.test(text) && TMPFS_PATH_RE.test(text);
  return { blocked, danger, tmpfs };
}

/** Whether running the command needs an explicit confirm first. */
export function needsShellConfirm(risk: ShellCommandRisk): boolean {
  return risk.blocked === null && (risk.danger !== null || risk.tmpfs);
}
