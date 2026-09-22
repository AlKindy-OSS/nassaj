import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pty, { type IPty } from 'node-pty';
import { WebSocket, type RawData } from 'ws';

import {
  isProjectPathVisibleToUser,
  readRequestUserId,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import { installManagedClaudeTerminalEnv } from '@/services/isolation/managed-claude-terminal-env.js';
import {
  bindManagedClaudeTerminal,
  registerManagedClaudeTerminal,
  revokeManagedClaudeTerminal,
} from '@/services/isolation/managed-claude-launch-broker.js';
import { resolveCagedLaunch } from '@/services/isolation/provider-cage-wiring.js';
import { buildShellErrorFrame, sanitizeTerminalText } from '@/modules/websocket/services/shell-error-frame.js';
import type { AuthenticatedWebSocketRequest } from '@/shared/types.js';
import { parseIncomingJsonObject } from '@/shared/utils.js';

import { reportWriterLeaseRefusal, withLocalUpdateWriterLease } from '../../../services/update-writer-lease.js';

/** Providers with a per-user credential knob in resolveProviderEnv. */
type IsolationProvider =
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'cursor'
  | 'agy'
  | 'opencode'
  | 'hermes'
  | 'kimi';

/**
 * Spawn mode handed to `resolveProviderEnv` / `resolveCagedLaunch` (SL-5/SL-6,
 * ADR-062). An interactive PTY always runs the provider's NATIVE CLI, so for the
 * vendors that ship one (today: kimi) the terminal is an 'agent' launch — that is
 * the only mode in which `resolveProviderEnv` sets KIMI_CODE_HOME and the only
 * mode in which the provider cage covers kimi. Every other provider stays 'chat',
 * which is what the resolvers already defaulted to, so their launches are
 * byte-identical to before.
 */
type IsolationMode = 'chat' | 'agent';

type ShellIncomingMessage = {
  type?: string;
  data?: string;
  cols?: number;
  rows?: number;
  projectPath?: string;
  sessionId?: string;
  hasSession?: boolean;
  provider?: string;
  initialCommand?: string;
  isPlainShell?: boolean;
  forceRestart?: boolean;
};

export function isProviderLoginCommand(
  initialCommand: string,
  provider: string,
  hasSession: boolean,
  isPlainShell: boolean
): boolean {
  const isAgyProvider = provider === 'agy' || provider === 'antigravity';
  return (
    initialCommand.includes('setup-token')
    || initialCommand.includes('cursor-agent login')
    || initialCommand.includes('codex login')
    // `kimi login` runs Moonshot's DEVICE-CODE flow (verified on disk: `kimi
    // login` → "Authenticate with Kimi Code CLI via the device-code flow"), so
    // it carries the same expiry hazard as `codex login --device-auth`: a stale
    // reattached PTY would show an already-dead code. Force a fresh PTY.
    || initialCommand.includes('kimi login')
    || initialCommand.includes('auth login')
    || (isAgyProvider && !hasSession && !isPlainShell)
  );
}

// ---------------------------------------------------------------------------
// SEC-SHELL-ROLE — arbitrary command execution over /shell
// ---------------------------------------------------------------------------
//
// `buildShellCommand` returns `initialCommand` VERBATIM on several branches
// (isPlainShell, and the agy/opencode/gemini/claude branches when the payload
// carries one), and the caller runs it as `bash -c <command>` on the HOST as the
// `nassaj` user. This file contained ZERO references to `role`, so a member with
// the plain `user` role could open ws://…/shell and execute anything.
//
// That contradicts the project's own stated policy: the standalone terminal is
// gated to owner/admin on BOTH transports — `requireRole('owner','admin')` on
// /api/terminals (index.js) and a 4403 close in terminal-websocket.service.ts,
// whose comment says the host shell "must never be reachable by a regular user".
//
// The gate is deliberately NARROW. It keys on the ONLY dangerous input — a
// caller-supplied `initialCommand` — and NOT on the provider PTY sessions, which
// stay open to every role exactly as before. Legitimate clients never send a
// free-form command: the project Shell tab sends `initialCommand: null`
// (MainContent → StandaloneShell with no `command`), and the only components
// that DO send one are the provider-login modals, whose commands are fixed
// strings enumerated below. Those remain available to every role so a regular
// member can still authenticate their own isolated provider credentials.
const FREE_SHELL_ALLOWED_ROLES: readonly string[] = ['owner', 'admin'];

/**
 * The exact commands the UI legitimately issues as `initialCommand`
 * (ProviderLoginModal.getProviderCommand + AgySetupModal). EXACT matches only —
 * a prefix/substring test would let `codex login --device-auth; curl … | sh`
 * through, which is the very bypass class this gate exists to stop.
 */
const PROVIDER_LOGIN_COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  'agy',
  'claude setup-token',
  'cursor-agent login',
  'codex login',
  'codex login --device-auth',
  'opencode auth login',
  'hermes setup --portal',
  // Kimi (ADR-062): the native `@moonshot-ai/kimi-code` CLI authenticates either
  // by KIMI_API_KEY (injected by resolveProviderEnv from the per-user encrypted
  // store) or by an interactive device-code login, which has no headless form —
  // hence a fixed, exactly-matched terminal command, available to every role like
  // the other provider logins.
  'kimi login',
  // B-1260: FULL OAuth is now the default Claude link (access + refresh + full
  // scopes), replacing the inference-only `claude setup-token`. `claude auth
  // login` prints an authorize URL and a "Paste code here if prompted >" prompt
  // (verified in the bundled CLI 2.1.273), so it completes headless with no
  // localhost callback. `claude setup-token` stays allowlisted as the API-panel
  // fallback (B-1075). Must match ProviderLoginModal.getProviderCommand exactly.
  'claude auth login',
]);

/**
 * B-1260 — SERVER-SIDE COMMAND↔PROVIDER BINDING. The client declares BOTH a
 * `provider` and an `initialCommand`; nothing before this map stopped a payload
 * from pairing `provider: 'claude'` with `initialCommand: 'codex login
 * --device-auth'`. Both strings are individually allowlisted, so the free-shell
 * role gate passes them, and buildShellCommand's claude branch would then run
 * the codex login INSIDE the claude-isolated env (CLAUDE_CONFIG_DIR) — a login
 * whose token lands in the wrong provider's tree. This map pins each provider to
 * the exact login command(s) it may issue, so a mismatched pair is refused
 * before any spawn. A provider may legitimately have more than one (claude keeps
 * `setup-token` as the API-panel fallback; codex the bare and --device-auth
 * forms). Providers absent here issue no fixed login command.
 */
const PROVIDER_CANONICAL_LOGIN_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['claude', new Set(['claude auth login', 'claude setup-token'])],
  ['cursor', new Set(['cursor-agent login'])],
  ['codex', new Set(['codex login', 'codex login --device-auth'])],
  ['opencode', new Set(['opencode auth login'])],
  ['hermes', new Set(['hermes setup --portal'])],
  ['kimi', new Set(['kimi login'])],
  ['agy', new Set(['agy'])],
  ['antigravity', new Set(['agy'])],
]);

/** Every fixed provider-login command, across all providers. */
const ALL_PROVIDER_LOGIN_COMMANDS: ReadonlySet<string> = new Set(
  [...PROVIDER_CANONICAL_LOGIN_COMMANDS.values()].flatMap((set) => [...set]),
);

/**
 * B-1260 — true when a caller-declared (provider, initialCommand) pair is a
 * provider-login command bound to the WRONG provider. An empty command, or a
 * command that is not a provider-login command at all (a resume template, the
 * echo fallback, a free-form admin command already gated elsewhere), is NOT a
 * mismatch here — this guard speaks only to login-command↔provider binding.
 *
 * Exported for the SEC-SHELL-ROLE / B-1260 regression suite.
 */
export function isProviderLoginCommandMismatch(
  provider: string,
  initialCommand: string,
): boolean {
  const command = initialCommand.trim();
  if (command.length === 0 || !ALL_PROVIDER_LOGIN_COMMANDS.has(command)) {
    return false;
  }
  const allowedForProvider = PROVIDER_CANONICAL_LOGIN_COMMANDS.get(provider);
  return !allowedForProvider || !allowedForProvider.has(command);
}

/** Roles permitted to write a credential into a SHARED (operator) Claude tree. */
const SHARED_CLAUDE_WRITE_ROLES: readonly string[] = ['owner', 'admin'];

/**
 * B-1260 — PRE-SPAWN CREDENTIAL-WRITE PERMISSION. `claude auth login` writes a
 * full OAuth credential (`.credentials.json`) into the config dir the spawn
 * resolves to. Under the ISOLATED policy that is the caller's OWN tree, so any
 * role may link their own account. Under the SHARED policy every claude spawn
 * runs on the OPERATOR's `~/.claude`, so a member's login would OVERWRITE the
 * operator credential every other user depends on — a member must be refused
 * BEFORE the CLI runs and destroys the shown code. `setup-token` prints to
 * stdout and persists nothing to the tree, so it is not gated here; only the
 * tree-writing `claude auth login` is.
 *
 * Exported for the regression suite.
 */
export function isClaudeLoginCredentialWriteAllowed(
  initialCommand: string,
  role: string | null | undefined,
  isClaudeShared: boolean,
): boolean {
  if (initialCommand.trim() !== 'claude auth login') {
    return true;
  }
  if (!isClaudeShared) {
    return true;
  }
  return typeof role === 'string' && SHARED_CLAUDE_WRITE_ROLES.includes(role);
}

/**
 * The UI's fallback for a provider with no configured login command:
 * `echo "No login command configured for <provider>"`. Matched by an anchored
 * pattern with a restricted provider charset so no shell metacharacter fits.
 */
const PROVIDER_NO_LOGIN_ECHO_PATTERN =
  /^echo "No login command configured for [A-Za-z0-9_-]{1,32}"$/;

/**
 * True when `initialCommand` is a fixed, UI-issued provider command that any
 * role may run. An empty/absent command is also "safe": the PTY then follows a
 * provider template (`claude`, `codex resume …`, …) that contains no
 * caller-controlled text.
 *
 * Exported for the SEC-SHELL-ROLE regression suite.
 */
export function isAllowlistedShellCommand(initialCommand: string): boolean {
  const command = initialCommand.trim();
  if (command.length === 0) {
    return true;
  }
  if (PROVIDER_LOGIN_COMMAND_ALLOWLIST.has(command)) {
    return true;
  }
  return PROVIDER_NO_LOGIN_ECHO_PATTERN.test(command);
}

/**
 * The authorization decision for a shell init payload. Pure, so the regression
 * suite asserts the exact policy without a live socket.
 *
 * @returns true when this role may run this `initialCommand`.
 * Exported for the SEC-SHELL-ROLE regression suite.
 */
export function isShellCommandPermittedForRole(
  initialCommand: string,
  role: string | null | undefined
): boolean {
  if (isAllowlistedShellCommand(initialCommand)) {
    return true;
  }
  return typeof role === 'string' && FREE_SHELL_ALLOWED_ROLES.includes(role);
}

type PtySessionEntry = {
  pty: IPty;
  ws: WebSocket | null;
  buffer: string[];
  timeoutId: NodeJS.Timeout | null;
  projectPath: string;
  sessionId: string | null;
  writerLease: { release(): void };
  managedClaudeSelector?: string;
};

const ptySessionsMap = new Map<string, PtySessionEntry>();
const PTY_SESSION_TIMEOUT = 30 * 60 * 1000;
const SHELL_URL_PARSE_BUFFER_LIMIT = 32768;
/**
 * UTF-8 locale used by project/chat PTYs. A plain `C` locale makes readline
 * count Arabic input as individual bytes, which breaks cursor movement and
 * deletion even though the websocket payload itself is valid Unicode.
 */
const TERMINAL_UTF8_LOCALE = 'C.UTF-8';

/**
 * Whether an authenticated userId is mandatory before spawning a PTY.
 *
 * verifyWebSocketClient (websocket-auth.service.ts) populates request.user in
 * BOTH platform mode (first DB user) and OSS mode (verified JWT), and refuses
 * the upgrade otherwise — so authentication is enforced for every PTY upgrade
 * regardless of mode. This flag therefore stays `true` unconditionally: it
 * exists to make the fail-closed gate explicit and locally auditable (rather
 * than relying on the remote verifyClient invariant), and to give a single,
 * documented switch should a legitimate no-auth PTY mode ever be introduced.
 */
const REQUIRE_PTY_USER = true;

type ShellWebSocketDependencies = {
  acquireWriterLease: (kind: string) => { release(): void } | Promise<{ release(): void }>;
  getSessionById: (sessionId: string) => { cliSessionId?: string } | null | undefined;
  stripAnsiSequences: (content: string) => string;
  normalizeDetectedUrl: (url: string) => string | null;
  extractUrlsFromText: (content: string) => string[];
  shouldAutoOpenUrlFromOutput: (content: string) => boolean;
};

/**
 * Reads a string field from untyped payloads and falls back when absent.
 */
function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Reads a boolean field from untyped payloads and falls back when absent.
 */
function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Reads a finite number field from untyped payloads and falls back when absent.
 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses incoming websocket shell messages and keeps processing safe when
 * malformed payloads are received.
 */
function parseShellMessage(rawMessage: RawData): ShellIncomingMessage | null {
  const payload = parseIncomingJsonObject(rawMessage);
  if (!payload) {
    return null;
  }

  return payload as ShellIncomingMessage;
}

/**
 * Resolves provider command line for plain shell and agent-backed shell modes.
 */

function buildShellCommand(
  message: ShellIncomingMessage,
  dependencies: ShellWebSocketDependencies
): string {
  const hasSession = readBoolean(message.hasSession);
  const sessionId = readString(message.sessionId);
  const initialCommand = readString(message.initialCommand);
  const provider = readString(message.provider, 'claude');
  const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
  const isPlainShell =
    readBoolean(message.isPlainShell) ||
    (!!initialCommand && !hasSession) ||
    provider === 'plain-shell';

  if (isPlainShell) {
    return initialCommand;
  }

  if (provider === 'cursor') {
    if (hasSession && sessionId) {
      return `cursor-agent --resume="${sessionId}"`;
    }
    return 'cursor-agent';
  }

  if (provider === 'codex') {
    if (hasSession && sessionId) {
      // Nassaj conversations are created through @openai/codex-sdk (`source:
      // exec`), so the native TUI classifies their rollouts as non-interactive.
      // Codex hides that class from `resume` unless this flag is explicit. The
      // old command then fell through to a *new* bare `codex` process on any
      // resume failure, which presented the Welcome/Sign-in screen and silently
      // detached the terminal from the conversation the user opened.
      //
      // Fail closed instead: resume exactly the authenticated user's requested
      // thread from their isolated CODEX_HOME, or let the process error. Never
      // substitute an unrelated fresh conversation.
      return `codex resume --include-non-interactive "${sessionId}"`;
    }
    return 'codex';
  }

  if (provider === 'gemini') {
    const command = initialCommand || 'gemini';
    let resumeId = sessionId;
    if (hasSession && sessionId) {
      try {
        const existingSession = dependencies.getSessionById(sessionId);
        if (existingSession && existingSession.cliSessionId) {
          resumeId = existingSession.cliSessionId;
          if (!safeSessionIdPattern.test(resumeId)) {
            resumeId = '';
          }
        }
      } catch (error) {
        console.error('Failed to get Gemini CLI session ID:', error);
      }
    }

    if (hasSession && resumeId) {
      return `${command} --resume "${resumeId}"`;
    }
    return command;
  }

  if (provider === 'opencode') {
    if (hasSession && sessionId) {
      return `opencode --session "${sessionId}"`;
    }
    return initialCommand || 'opencode';
  }

  if (provider === 'kimi') {
    // Native `@moonshot-ai/kimi-code`. Without this branch a kimi terminal fell
    // through to the trailing `claude` default — the wrong CLI entirely. An
    // explicit initialCommand (the `kimi login` device-code flow from the UI)
    // wins; otherwise resume by id (`kimi -S <id>`, verified against `kimi
    // --help`) with a bare `kimi` fallback, mirroring the codex branch.
    if (initialCommand) {
      return initialCommand;
    }
    if (hasSession && sessionId) {
      return `kimi -S "${sessionId}" || kimi`;
    }
    return 'kimi';
  }

  if (provider === 'agy' || provider === 'antigravity') {
    // agy resumes a prior conversation by UUID via --conversation; a fresh launch
    // runs bare `agy` interactively, which triggers its OAuth device/browser flow
    // when no valid token exists under HOME — i.e. an interactive `agy` IS the
    // login command (agy has no `agy login` subcommand). An explicit
    // initialCommand (e.g. a login command from the UI) wins.
    if (initialCommand) {
      return initialCommand;
    }
    if (hasSession && sessionId) {
      return `agy --conversation "${sessionId}" || agy`;
    }
    return 'agy';
  }

  const command = initialCommand || 'claude';
  if (hasSession && sessionId) {
    if (os.platform() === 'win32') {
      return `claude --resume "${sessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
    }
    return `claude --resume "${sessionId}" || claude`;
  }
  return command;
}

/**
 * Maps the provider declared by a shell init payload onto a credential-isolation
 * provider key understood by `resolveProviderEnv`. Providers without a per-user
 * credential knob (e.g. cursor, plain-shell) fall through to `claude`'s policy
 * gate, which returns the base env unchanged when that provider is shared.
 */
/**
 * Reads an env value by case-insensitive key. PATH is `PATH` on Linux but the
 * isolated env we extend is ultimately derived from process.env, so we stay
 * tolerant of casing rather than assuming a fixed key.
 */
function readEnvValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const resolvedKey = Object.keys(env).find(
    (envKey) => envKey.toLowerCase() === key.toLowerCase()
  );
  return resolvedKey ? env[resolvedKey] : undefined;
}

/** Resolves the actual PATH key name present in the env (casing-tolerant). */
function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') || 'PATH';
}

/**
 * B-90: surface the *user's* npm-global binaries ahead of bundled/system CLIs in
 * the PTY's PATH (ported, pruned, from upstream #913 `prioritizeUserNpmGlobalBin`).
 *
 * Two deliberate departures from upstream:
 *   1. Linux-only — all Windows/AppData candidates are dropped.
 *   2. Per-user isolation — every candidate is derived from the **isolated env**
 *      (`isolatedEnv` = resolveProviderEnv output), NEVER `os.homedir()`/raw
 *      process.env. So for an isolated provider (e.g. agy, whose HOME is the
 *      per-user tree) the npm-global dir resolves inside *that* user's tree, and
 *      for a shared/claude provider it resolves under the operator home exactly
 *      as before. This makes it structurally impossible for one user's npm path
 *      to leak into another user's terminal: the path can only ever be whatever
 *      the isolation seam already scoped for this spawn.
 *
 * Two classes of candidate, in priority order:
 *
 *   A. User/project-specific dirs — prepended whenever they exist on disk as a
 *      directory (even if absent from the inherited PATH; this is what actually
 *      fixes B-90, since the user npm dir is frequently NOT on the PTY's PATH):
 *        - <isolated HOME>/.npm-global/bin
 *        - <isolated HOME>/.local/bin  (native Claude installer, B-1058)
 *        - <cwd>/node_modules/.bin   (project-local, scoped to the project dir)
 *
 *   B. npm_config_prefix dirs — hoisted to the front ONLY when already present
 *      in the inherited PATH (upstream's reorder-only semantics). They are
 *      deliberately NOT blind-prepended: npm_config_prefix is commonly the
 *      SYSTEM prefix (e.g. `/usr` when the server is launched under an npm
 *      script, which injects npm_config_prefix), and promoting a system dir to
 *      the front of PATH would be both wrong and pointless. A user who set a
 *      personal prefix (e.g. `~/.npm-global`) already has it on PATH, so the
 *      reorder still serves the intended case.
 *        - npm_config_prefix
 *        - npm_config_prefix/bin
 *
 * Existing PATH entries are preserved in order; matched candidates are de-duped
 * and moved to the front. When nothing matches, PATH is returned unchanged.
 */
export function prioritizeUserNpmGlobalBin(
  env: NodeJS.ProcessEnv,
  projectCwd: string
): { key: string; value: string | undefined } {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey];
  if (!currentPath) {
    return { key: pathKey, value: currentPath };
  }

  const delimiter = path.delimiter;
  const pathEntries = currentPath.split(delimiter).filter(Boolean);
  const pathEntrySet = new Set(pathEntries);

  // HOME and npm_config_prefix come from the ISOLATED env so the resolved
  // candidates honor whatever home the isolation seam scoped for this user.
  const isolatedHome = readEnvValue(env, 'HOME');
  const npmPrefix = readEnvValue(env, 'npm_config_prefix');

  // Class A: user/project dirs — eligible when they exist on disk.
  const diskCandidates = [
    isolatedHome ? path.join(isolatedHome, '.npm-global', 'bin') : '',
    // B-1058: the native Claude installer lands in ~/.local/bin, which a
    // pm2/systemd-launched server never has on PATH and `--noprofile --norc`
    // never restores. Surface it exactly like the npm-global dir.
    isolatedHome ? path.join(isolatedHome, '.local', 'bin') : '',
    projectCwd ? path.join(projectCwd, 'node_modules', '.bin') : '',
  ].filter(Boolean);

  // Class B: npm_config_prefix dirs — eligible only if already on PATH.
  const pathOnlyCandidates = [
    npmPrefix || '',
    npmPrefix ? path.join(npmPrefix, 'bin') : '',
  ].filter(Boolean);

  const isEligible = (candidate: string, requireOnPath: boolean): boolean => {
    if (requireOnPath) {
      return pathEntrySet.has(candidate);
    }
    try {
      return fs.statSync(candidate).isDirectory();
    } catch {
      return false;
    }
  };

  // Priority order: user npm-global → user ~/.local/bin → project node_modules/.bin → npm prefix.
  const ordered = [
    ...diskCandidates.map((c) => ({ candidate: c, requireOnPath: false })),
    ...pathOnlyCandidates.map((c) => ({ candidate: c, requireOnPath: true })),
  ];

  const seen = new Set<string>();
  const preferredEntries: string[] = [];
  for (const { candidate, requireOnPath } of ordered) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (isEligible(candidate, requireOnPath)) {
      preferredEntries.push(candidate);
    }
  }

  if (preferredEntries.length === 0) {
    return { key: pathKey, value: currentPath };
  }

  const preferredSet = new Set(preferredEntries);
  const value = [
    ...preferredEntries,
    ...pathEntries.filter((entry) => !preferredSet.has(entry)),
  ].join(delimiter);

  return { key: pathKey, value };
}

function readIsolationProvider(provider: string): IsolationProvider {
  // agy resolves its credentials via a HOME override in resolveProviderEnv, so a
  // terminal launched in agy context must map to the 'agy' isolation key (NOT
  // fall through to claude) — otherwise a non-owner's `agy` login would write the
  // token under HOME=process home (shared) instead of their isolated tree. The UI
  // labels this provider 'antigravity'; accept both spellings.
  if (provider === 'agy' || provider === 'antigravity') {
    return 'agy';
  }
  // T-866/B5: opencode isolates its credentials via XDG_* redirection in
  // resolveProviderEnv, NOT via CLAUDE_CONFIG_DIR. Falling through to the
  // 'claude' default made a non-owner's `opencode auth login` terminal write
  // auth.json under the SHARED operator tree (XDG untouched) instead of the
  // user's isolated tree — the exact isolation bug this maps out. hermes has no
  // per-user knob (auth in ~/.hermes, shared), so it must resolve to base env
  // too rather than wrongly inherit claude's CLAUDE_CONFIG_DIR override.
  // kimi (SL-5/ADR-062): the native CLI reads AND WRITES credential + session
  // state to disk under KIMI_CODE_HOME. Falling through to the 'claude' default
  // would hand an interactive `kimi login` the CLAUDE_CONFIG_DIR knob instead —
  // i.e. the device-code token would land in the SHARED operator ~/.kimi-code
  // rather than the user's isolated tree. Exactly the opencode/B5 bug above.
  if (
    provider === 'claude'
    || provider === 'codex'
    || provider === 'gemini'
    || provider === 'cursor'
    || provider === 'opencode'
    || provider === 'hermes'
    || provider === 'kimi'
  ) {
    return provider;
  }
  return 'claude';
}

/**
 * The spawn mode for an interactive PTY. A terminal always runs the provider's
 * NATIVE CLI, so kimi — the one vendor here that ships one — is an 'agent'
 * launch: only then does `resolveProviderEnv` set the per-user KIMI_CODE_HOME
 * (SL-5) and only then does `cageEnabled` cover kimi (SL-6). Everything else
 * resolves to 'chat', which is the value both resolvers already defaulted to,
 * so no existing provider's launch changes.
 *
 * Exported for the terminal-isolation regression suite.
 */
export function readIsolationMode(provider: IsolationProvider): IsolationMode {
  return provider === 'kimi' ? 'agent' : 'chat';
}

/**
 * Handles websocket connections used by the standalone shell terminal UI.
 *
 * `request` carries the JWT-authenticated user (populated by verifyClient) so the
 * PTY process inherits the per-user isolated credential env via resolveProviderEnv
 * (B-MU-PTY-ENV) and the session key is namespaced per user (B-MU-PTY-KEY).
 *
 * Fail-closed: if no authenticated userId is present at PTY init while auth is
 * enforced (REQUIRE_PTY_USER), the connection is refused (error frame + close)
 * with no spawn and no session-key build — never a shared 'anon' fallback.
 */
export function handleShellConnection(
  ws: WebSocket,
  request: AuthenticatedWebSocketRequest,
  dependencies: ShellWebSocketDependencies
): void {
  console.log('[INFO] Shell websocket connected');

  const userId = readRequestUserId(request);
  // SEC-SHELL-ROLE: the JWT-verified role, read the same way the terminal
  // service reads it (verifyWebSocketClient stamps request.user).
  const userRole = (request?.user as { role?: string } | undefined)?.role ?? null;

  let shellProcess: IPty | null = null;
  let ptySessionKey: string | null = null;
  // One notice per ADMISSION CYCLE, not one per frame. The outer lease below
  // wraps EVERY inbound frame, `input` included, so an unthrottled refusal
  // turned a single keystroke into a log line plus a client banner — hundreds
  // of both within seconds on any node that happens to be updating.
  //
  // LIMIT, stated precisely: the flag is cleared by the next ADMITTED frame, so
  // the real bound is one notice per deny→admit cycle, not one per socket. The
  // gate takes and releases its lock in short cycles during `transition()`, so
  // a maintenance window can still produce one banner per cycle. That is two
  // orders of magnitude fewer than one per keystroke, not a total suppression.
  let gateDenialAnnounced = false;
  let urlDetectionBuffer = '';
  const announcedAuthUrls = new Set<string>();

  ws.on('message', async (rawMessage) => {
    try { await withLocalUpdateWriterLease('shell-websocket-frame', async () => {
    try {
      const data = parseShellMessage(rawMessage);
      if (!data?.type) {
        throw new Error('Invalid websocket payload');
      }

      if (data.type === 'init') {
        const projectPath = readString(data.projectPath, process.cwd());
        const sessionId = readString(data.sessionId) || null;
        const hasSession = readBoolean(data.hasSession);
        const provider = readString(data.provider, 'claude');
        const initialCommand = readString(data.initialCommand);
        const forceRestart = readBoolean(data.forceRestart);
        const isPlainShell =
          readBoolean(data.isPlainShell) ||
          (!!initialCommand && !hasSession) ||
          provider === 'plain-shell';

        urlDetectionBuffer = '';
        announcedAuthUrls.clear();

        // A login must never reattach to stale terminal output. Codex device
        // codes in particular expire, so each modal open needs a fresh PTY.
        const isLoginCommand = isProviderLoginCommand(
          initialCommand,
          provider,
          hasSession,
          isPlainShell
        );

        const commandSuffix =
          isPlainShell && initialCommand
            ? `_cmd_${Buffer.from(initialCommand).toString('base64').slice(0, 16)}`
            : '';

        // B-MU-PTY-KEY (fail-closed): the session key is namespaced per
        // authenticated user so one user can never reattach to (hijack) another
        // user's live PTY. verifyWebSocketClient already rejects any upgrade
        // without request.user in BOTH platform and OSS modes, so a missing
        // userId here is an unexpected/broken state — never a sanctioned
        // anonymous session. Refuse to spawn rather than fall back to a shared
        // 'anon' key that two no-userId connections could collide on and use to
        // hijack each other's terminals. The guard is bound to the same
        // condition that enforces authentication (REQUIRE_PTY_USER): auth is
        // enforced unconditionally for PTY upgrades, so the refusal is too.
        if (REQUIRE_PTY_USER && (userId === null || userId === undefined)) {
          console.error(
            '[ERROR] Shell WebSocket rejected: missing authenticated userId on PTY init'
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: 'Authentication required for terminal session',
              })
            );
          }
          ws.close(4401, 'Authentication required');
          return;
        }

        // SEC-SHELL-ROLE: refuse a FREE-FORM initialCommand from a non-admin
        // BEFORE the session key is built, before any reattach, and before any
        // spawn — the same shape and close code (4403) terminal-websocket uses.
        // Provider PTY sessions (no initialCommand) and the fixed provider-login
        // commands are unaffected for every role.
        if (!isShellCommandPermittedForRole(initialCommand, userRole)) {
          console.error(
            `[ERROR] Shell WebSocket rejected: role '${userRole ?? 'none'}' `
            + 'may not run an arbitrary shell command'
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: 'Running arbitrary shell commands is restricted to administrators',
                code: 'forbidden',
              })
            );
          }
          ws.close(4403, 'Forbidden');
          return;
        }

        // B-1260 — command↔provider binding: a fixed provider-login command
        // paired with the wrong provider is refused before any spawn, so a
        // login can never run in a different provider's isolated tree.
        if (isProviderLoginCommandMismatch(provider, initialCommand)) {
          console.error(
            `[ERROR] Shell WebSocket rejected: login command does not match declared `
            + `provider '${provider}'`
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message: 'This login command does not match the selected provider.',
                code: 'provider_mismatch',
              })
            );
          }
          ws.close(4403, 'Forbidden');
          return;
        }

        // B-1260 — credential-write permission: under the SHARED claude policy a
        // full `claude auth login` overwrites the operator credential, so only
        // owner/admin may run it; members are refused BEFORE the CLI prints (and
        // then destroys) the one-time code. Isolated users write their own tree
        // and pass. isProviderIsolated resolves the same policy resolveProviderEnv
        // consults for the spawn env, so the gate and the write can never drift.
        const isClaudeShared =
          readIsolationProvider(provider) === 'claude' && !isProviderIsolated('claude');
        if (!isClaudeLoginCredentialWriteAllowed(initialCommand, userRole, isClaudeShared)) {
          console.error(
            `[ERROR] Shell WebSocket rejected: role '${userRole ?? 'none'}' may not run `
            + 'claude auth login against the shared operator credential'
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'error',
                message:
                  'Linking Claude on this shared server is limited to administrators. '
                  + 'Ask an owner or admin to link the account, or set a personal API key instead.',
                // Dedicated code so the modal renders a tailored, localized "ask an
                // owner/admin to link" message rather than the generic role refusal.
                code: 'shared_link_admin_only',
              })
            );
          }
          ws.close(4403, 'Forbidden');
          return;
        }

        // B-36 / B-PRIV: same spawn guard as chat — refuse to open a PTY inside
        // a KNOWN private project the authenticated user is not a member of
        // (404-equivalent), before any reattach or spawn. Unregistered paths
        // pass (creation/first-run flow), mirroring the chat behavior.
        if (!isProjectPathVisibleToUser(projectPath, userId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Project not found' }));
          ws.close(4404, 'Project not found');
          return;
        }

        const userKey = userId;
        ptySessionKey = `${userKey}_${projectPath}_${sessionId ?? 'default'}${commandSuffix}`;

        if (isLoginCommand || forceRestart) {
          const oldSession = ptySessionsMap.get(ptySessionKey);
          if (oldSession) {
            if (oldSession.timeoutId) {
              clearTimeout(oldSession.timeoutId);
            }
            oldSession.pty.kill();
            revokeManagedClaudeTerminal(oldSession.managedClaudeSelector);
            oldSession.writerLease.release();
            ptySessionsMap.delete(ptySessionKey);
          }
        }

        const existingSession =
          isLoginCommand || forceRestart ? null : ptySessionsMap.get(ptySessionKey);
        if (existingSession?.writerLease) {
          shellProcess = existingSession.pty;
          if (existingSession.timeoutId) {
            clearTimeout(existingSession.timeoutId);
          }

          ws.send(
            JSON.stringify({
              type: 'output',
              data: '\x1b[36m[Reconnected to existing session]\x1b[0m\r\n',
            })
          );

          if (existingSession.buffer.length > 0) {
            existingSession.buffer.forEach((bufferedData) => {
              ws.send(
                JSON.stringify({
                  type: 'output',
                  data: bufferedData,
                })
              );
            });
          }

          existingSession.ws = ws;
          return;
        }
        if (existingSession) {
          // A pre-gate PTY cannot be admitted during a future update drain.
          existingSession.pty.kill();
          revokeManagedClaudeTerminal(existingSession.managedClaudeSelector);
          ptySessionsMap.delete(ptySessionKey);
        }

        const resolvedProjectPath = path.resolve(projectPath);
        try {
          const stats = fs.statSync(resolvedProjectPath);
          if (!stats.isDirectory()) {
            throw new Error('Not a directory');
          }
        } catch {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid project path' }));
          return;
        }

        const safeSessionIdPattern = /^[a-zA-Z0-9_.\-:]+$/;
        if (sessionId && !safeSessionIdPattern.test(sessionId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid session ID' }));
          return;
        }

        const shellCommand = buildShellCommand(data, dependencies);
        const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
        const shellArgs =
          os.platform() === 'win32' ? ['-Command', shellCommand] : ['-c', shellCommand];
        const termCols = readNumber(data.cols, 80);
        const termRows = readNumber(data.rows, 24);

        // B-MU-PTY-ENV: build the PTY environment through the central isolation
        // seam (same resolver as claude-sdk.js:784) so the terminal process runs
        // under the authenticated user's credential dir (CLAUDE_CONFIG_DIR /
        // CODEX_HOME / HOME for the CLIs with no dedicated knob) instead of the
        // operator's raw process.env. When
        // no userId is present, or the provider is marked shared, resolveProviderEnv
        // returns the base env unchanged — preserving single-user behavior.
        const isolationProvider = readIsolationProvider(provider);
        const isolationMode = readIsolationMode(isolationProvider);
        // T-1675: a terminal ALWAYS runs on the member's own credential, never on
        // one delegated to them — the PTY is interactive, so any login typed at
        // the prompt would otherwise land in the grantor's tree.
        const isolatedEnv = resolveProviderEnv(
          userId,
          isolationProvider,
          process.env,
          isolationMode,
          { honorGrants: false }
        );
        // B-90: hoist the user's npm-global binaries to the front of PATH,
        // deriving every candidate from the ISOLATED env (HOME/npm_config_prefix
        // as scoped by resolveProviderEnv) so per-user isolation is preserved and
        // no user's npm path can leak into another's terminal.
        const prioritizedPath = prioritizeUserNpmGlobalBin(isolatedEnv, resolvedProjectPath);
        const prioritizedEnv = {
          ...isolatedEnv,
          [prioritizedPath.key]: prioritizedPath.value,
        };
        // Even a general/plain project shell can invoke `claude --resume` after
        // it opens. Put the managed launcher first for every Claude-isolated
        // shell, not only the provider-specific initial command.
        const terminalEnv = isolationProvider === 'claude'
          ? installManagedClaudeTerminalEnv(prioritizedEnv, {
            userId: userId!,
            mode: hasSession ? 'session-bound' : 'general',
            // A stale client sessionId alongside hasSession=false is not a
            // binding. Keep the general-terminal contract free of it.
            sessionId: hasSession ? sessionId : null,
          })
          : prioritizedEnv;
        const actorCandidate = request.user as { authenticationKind?: unknown; authorizationGeneration?: unknown } | undefined;
        const broker = isolationProvider === 'claude' && actorCandidate
          && typeof actorCandidate.authenticationKind === 'string'
          && Number.isSafeInteger(actorCandidate.authorizationGeneration)
          ? registerManagedClaudeTerminal({
            authenticatedPrincipal: request.user,
            userId: Number(userId), mode: hasSession ? 'session-bound' : 'general',
            sessionId: hasSession ? sessionId : null, cwd: resolvedProjectPath,
            realBinary: terminalEnv.NASSAJ_MANAGED_CLAUDE_REAL_BIN!, baseEnv: prioritizedEnv,
          })
          : null;

        // T-897: cage the interactive terminal behind NASSAJ_PROVIDER_CAGE
        // (default OFF ⇒ launch returned unchanged; byte-identical to the
        // previous pty.spawn). A caged PTY runs bash inside bwrap so a terminal
        // cannot cat another user's ~/.nassaj-users tree or reach docker.sock.
        // codex maps to the exempt path (self-cages) — see resolveCagedLaunch.
        // `mode` (SL-6) is what un-exempts kimi: its chat path is a hosted HTTP
        // call with no child to cage, but this PTY runs its native CLI, so the
        // terminal must be cageable. 'chat' for every other provider is the value
        // cageEnabled already assumed, so their launches stay byte-identical.
        const ptyLaunch = resolveCagedLaunch({
          userId,
          provider: isolationProvider,
          mode: isolationMode,
          cmd: shell,
          args: shellArgs,
          cwd: resolvedProjectPath,
        });

        let writerLease: { release(): void };
        try {
          const acquiredLease = dependencies.acquireWriterLease('managed-pty');
          writerLease = acquiredLease instanceof Promise ? await acquiredLease : acquiredLease;
        } catch (leaseError) {
          // The denial used to be silent on BOTH ends: no server log and an
          // unlabelled frame, so a terminal that stayed blank had no
          // diagnosable cause on any fleet node. Classify FIRST: an ordinary
          // acquisition failure told the user maintenance was active while none
          // was running. The refusal itself is unconditional either way — the
          // PTY is never spawned on this path.
          const refusal = reportWriterLeaseRefusal(
            'Shell WebSocket rejected: PTY writer lease',
            leaseError
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'error',
                code: refusal.code,
                message: refusal.gateDenial
                  ? 'Source update maintenance is active'
                  : 'The terminal could not be started.',
              })
            );
          }
          // No ptySessionsMap entry can leak here: the map is written only
          // after a successful spawn below, and the socket is left OPEN so the
          // client may retry once maintenance clears. NOT a no-op refusal
          // though: on the isLoginCommand/forceRestart path above the previous
          // session was already killed and its lease released, so the user is
          // left with no terminal at all, not with the one they had.
          return;
        }
        try {
          shellProcess = pty.spawn(ptyLaunch.cmd, ptyLaunch.args, {
          name: 'xterm-256color',
          cols: termCols,
          rows: termRows,
          cwd: resolvedProjectPath,
          env: {
            ...terminalEnv,
            ...(broker ? {
              NASSAJ_MANAGED_CLAUDE_BROKER_SOCKET: broker.socketPath,
              NASSAJ_MANAGED_CLAUDE_BROKER_SELECTOR: broker.selector,
            } : {}),
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            FORCE_COLOR: '3',
            LANG: TERMINAL_UTF8_LOCALE,
            LC_ALL: TERMINAL_UTF8_LOCALE,
            LC_CTYPE: TERMINAL_UTF8_LOCALE,
          },
          // Pin the PTY ↔ JS boundary to Unicode explicitly so the Arabic-output
          // contract remains stable across supported node-pty releases/platforms.
          encoding: 'utf8',
          });
          if (broker) bindManagedClaudeTerminal(broker.selector, shellProcess.pid);
        } catch (error) {
          revokeManagedClaudeTerminal(broker?.selector);
          writerLease.release();
          throw error;
        }

        ptySessionsMap.set(ptySessionKey, {
          pty: shellProcess,
          ws,
          buffer: [],
          timeoutId: null,
          projectPath,
          sessionId,
          writerLease,
          managedClaudeSelector: broker?.selector,
        });

        shellProcess.onData((chunk) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (!session) {
            return;
          }

          if (session.buffer.length < 5000) {
            session.buffer.push(chunk);
          } else {
            session.buffer.shift();
            session.buffer.push(chunk);
          }

          if (session.ws && session.ws.readyState === WebSocket.OPEN) {
            let outputData = chunk;
            const cleanChunk = dependencies.stripAnsiSequences(chunk);
            urlDetectionBuffer = `${urlDetectionBuffer}${cleanChunk}`.slice(-SHELL_URL_PARSE_BUFFER_LIMIT);

            outputData = outputData.replace(
              /OPEN_URL:\s*(https?:\/\/[^\s\x1b\x07]+)/g,
              '[INFO] Opening in browser: $1'
            );

            const emitAuthUrl = (detectedUrl: string, autoOpen = false) => {
              const normalizedUrl = dependencies.normalizeDetectedUrl(detectedUrl);
              if (!normalizedUrl) {
                return;
              }

              const isNewUrl = !announcedAuthUrls.has(normalizedUrl);
              if (isNewUrl) {
                announcedAuthUrls.add(normalizedUrl);
                session.ws?.send(
                  JSON.stringify({
                    type: 'auth_url',
                    url: normalizedUrl,
                    autoOpen,
                  })
                );
              }
            };

            const normalizedDetectedUrls = dependencies.extractUrlsFromText(urlDetectionBuffer)
              .map((url) => dependencies.normalizeDetectedUrl(url))
              .filter((url): url is string => Boolean(url));

            const dedupedDetectedUrls = Array.from(new Set(normalizedDetectedUrls)).filter(
              (url, _, urls) =>
                !urls.some((otherUrl) => otherUrl !== url && otherUrl.startsWith(url))
            );

            dedupedDetectedUrls.forEach((url) => emitAuthUrl(url, false));

            if (
              dependencies.shouldAutoOpenUrlFromOutput(cleanChunk) &&
              dedupedDetectedUrls.length > 0
            ) {
              const bestUrl = dedupedDetectedUrls.reduce((longest, current) =>
                current.length > longest.length ? current : longest
              );
              emitAuthUrl(bestUrl, true);
            }

            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: outputData,
              })
            );
          }
        });

        shellProcess.onExit((exitCode) => {
          if (!ptySessionKey) {
            return;
          }

          const session = ptySessionsMap.get(ptySessionKey);
          if (session && session.pty !== shellProcess) {
            return;
          }

          if (session && session.ws && session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(
              JSON.stringify({
                type: 'output',
                data: `\r\n\x1b[33mProcess exited with code ${exitCode.exitCode}${
                  exitCode.signal != null ? ` (${exitCode.signal})` : ''
                }\x1b[0m\r\n`,
              })
            );
          }

          if (session?.timeoutId) {
            clearTimeout(session.timeoutId);
          }

          session?.writerLease.release();
          revokeManagedClaudeTerminal(session?.managedClaudeSelector);

          ptySessionsMap.delete(ptySessionKey);
          shellProcess = null;
        });

        // Same rule as the error frame: everything interpolated into a pane
        // frame is stripped of terminal-control bytes first, so a crafted path
        // or session id cannot retitle the window or clear the screen.
        const safeProjectPath = sanitizeTerminalText(projectPath);
        const safeSessionId = sanitizeTerminalText(String(sessionId ?? ''));
        let welcomeMsg = `\x1b[36mStarting terminal in: ${safeProjectPath}\x1b[0m\r\n`;
        if (!isPlainShell) {
          const providerName =
            provider === 'cursor'
              ? 'Cursor'
              : provider === 'codex'
                ? 'Codex'
                : provider === 'gemini'
                  ? 'Gemini'
                  : provider === 'opencode'
                    ? 'OpenCode'
                    : provider === 'kimi'
                      ? 'Kimi'
                  : 'Claude';
          welcomeMsg = hasSession
            ? `\x1b[36mResuming ${providerName} session ${safeSessionId} in: ${safeProjectPath}\x1b[0m\r\n`
            : `\x1b[36mStarting new ${providerName} session in: ${safeProjectPath}\x1b[0m\r\n`;
        }

        ws.send(
          JSON.stringify({
            type: 'output',
            data: welcomeMsg,
          })
        );
        return;
      }

      if (data.type === 'input') {
        if (shellProcess) {
          shellProcess.write(readString(data.data));
        }
        return;
      }

      if (data.type === 'resize') {
        if (shellProcess) {
          shellProcess.resize(readNumber(data.cols, 80), readNumber(data.rows, 24));
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The RAW message stays in the server log only: it can carry paths or
      // command text, and the pane is the least controlled surface we have (it
      // is also copied into screenshots and bug reports). What the pane gets is
      // the publishable text chosen by the declared list in shell-error-frame,
      // which is why a node owner still sees "claude not found" without reading
      // `pm2 logs`, and an unlisted exception still says nothing.
      const frame = buildShellErrorFrame(message);
      console.error(`[ERROR] Shell WebSocket error (${frame.code}):`, message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'output',
            data: frame.data,
          })
        );
      }
    }
    }); gateDenialAnnounced = false; } catch (frameError) {
      // This catch wraps the WHOLE frame handler, so it sees every rejection the
      // handler produces — not just the lease refusal. Classifying first is what
      // stops an ordinary handler fault from being logged and framed as an
      // update-gate denial. Both branches refuse the frame.
      const refusal = reportWriterLeaseRefusal('Shell WebSocket rejected: frame', frameError, {
        gateAlreadyAnnounced: gateDenialAnnounced,
      });
      if (refusal.gateDenial) {
        if (gateDenialAnnounced) return;
        gateDenialAnnounced = true;
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'error',
          code: refusal.code,
          message: refusal.gateDenial
            ? 'Update maintenance is active'
            : 'The terminal request could not be completed.',
        }));
      }
    }
  });

  ws.on('close', () => {
    if (!ptySessionKey) {
      return;
    }

    const session = ptySessionsMap.get(ptySessionKey);
    if (!session) {
      return;
    }

    session.ws = null;
    session.timeoutId = setTimeout(() => {
      if (ptySessionsMap.get(ptySessionKey as string) !== session) {
        return;
      }

      session.pty.kill();
      session.writerLease.release();
      revokeManagedClaudeTerminal(session.managedClaudeSelector);
      ptySessionsMap.delete(ptySessionKey as string);
    }, PTY_SESSION_TIMEOUT);
  });

  ws.on('error', (error) => {
    console.error('[ERROR] Shell WebSocket error:', error);
  });
}
