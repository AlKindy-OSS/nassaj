/**
 * ADR-226 (B-1759..B-1763): the server side of one OpenCode turn under the shared
 * Claude-parity engine (the dsh mechanism, ADR-225).
 *
 *  - fd 3 carries the channel to server/assets/opencode/nassaj-claude-parity.js. The server
 *    writes a per-turn challenge nonce; the prompt is written to stdin only after the plugin's
 *    hello (nonce + plugin digest + protocol) was accepted by the parity broker AND Claude's
 *    UserPromptSubmit hooks passed. Until then opencode has no prompt, so a plugin that did not
 *    load (absent, corrupt, throwing, OPENCODE_PURE, --pure) sends nothing to the model: after
 *    the handshake timeout the whole process tree is killed (`opencode_parity_not_loaded`).
 *  - every tool call is decided by the engine through the broker; an ask becomes a member card.
 *  - a settled `tool_use` part on stdout that has no matching allow (session + call id + argument
 *    hash) kills the tree (`parity_undecided_result`). Subagent parts never reach stdout, so
 *    this check covers the main session only; subagent calls are gated by the same hook.
 *  - a Claude-format transcript mirror backs the hooks' `transcript_path`.
 *  - kill = the whole descendant tree (bash tools start their own process group).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

import * as databaseModule from '@/modules/database/index.js';
import { createParityBroker } from '@/services/permission-parity/parity-broker.js';
import { cancelParityPermissionsForRun, requestParityPermission } from '@/services/permission-parity/parity-permissions.js';
import { ClaudeTranscriptMirror, claudeTranscriptMirrorPath } from '@/services/permission-parity/claude-transcript-mirror.js';
import { opencodePermissionCard } from '@/services/permission-parity/opencode-claude-tools.js';

/** The protocol literal; the same string is in the channel-client plugin. */
export const OPENCODE_PARITY_PROTOCOL = 'nassaj-opencode-parity/1';

export const OPENCODE_RUNTIME_CODES = Object.freeze({
  notLoaded: 'opencode_parity_not_loaded',
  promptBlocked: 'opencode_prompt_blocked',
  undecidedResult: 'parity_undecided_result',
  violation: 'opencode_policy_violation',
});

/** User-facing text per runtime code (the client shows its own localised text by code). */
export const OPENCODE_RUNTIME_TEXT: Readonly<Record<string, string>> = Object.freeze({
  [OPENCODE_RUNTIME_CODES.notLoaded]: 'OpenCode did not load nassaj\'s permission plugin, so nothing was sent to the model.',
  [OPENCODE_RUNTIME_CODES.promptBlocked]: 'One of Claude\'s hooks blocked this message; nothing was sent to the model.',
  [OPENCODE_RUNTIME_CODES.undecidedResult]: 'nassaj stopped OpenCode: a tool ran without nassaj\'s decision.',
  [OPENCODE_RUNTIME_CODES.violation]: 'nassaj stopped OpenCode: the permission channel was violated.',
});

/**
 * Plugin start-up takes ~9 s on a fresh data dir (stage 0) and more under load, so the
 * design's 15 s is tight; the default leaves headroom and the knob overrides it.
 */
export const OPENCODE_HANDSHAKE_TIMEOUT_MS_DEFAULT = 30_000;

/** The hello timeout for this server: NASSAJ_OPENCODE_HANDSHAKE_TIMEOUT_MS, else the default. */
export function openCodeHandshakeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.NASSAJ_OPENCODE_HANDSHAKE_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : OPENCODE_HANDSHAKE_TIMEOUT_MS_DEFAULT;
}

/** Direct children of `pid` (every thread), or [] when it is gone. */
function childrenOf(pid: number): number[] {
  try {
    return fs.readdirSync(`/proc/${pid}/task`).flatMap((task) => {
      try {
        return fs.readFileSync(`/proc/${pid}/task/${task}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number);
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const signal = (pid: number, sig: NodeJS.Signals) => {
  try { process.kill(pid, sig); } catch { /* gone */ }
};
const alive = (pid: number) => {
  try {
    return !/^State:\s*Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  } catch {
    return false;
  }
};

/**
 * Kills `pid` and every descendant. Each found process is stopped first (a stopped process
 * cannot fork), the tree is walked again until it stops growing, then everything is killed
 * leaves first and the root's process group last. Resolves once nothing is left alive
 * (zombies awaiting their parent count as dead), or after ~2 s.
 */
export async function killProcessTree(pid: number | undefined | null): Promise<void> {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return;
  const root = pid as number;
  const order: number[] = [];
  const seen = new Set<number>();
  for (let round = 0; round < 20; round += 1) {
    const before = seen.size;
    const stack = [root];
    const visited = new Set<number>([root]);
    while (stack.length && visited.size < 4096) {
      const current = stack.pop() as number;
      if (!seen.has(current)) {
        seen.add(current);
        order.push(current);
        signal(current, 'SIGSTOP');
      }
      for (const kid of childrenOf(current)) {
        if (!visited.has(kid)) {
          visited.add(kid);
          stack.push(kid);
        }
      }
    }
    if (seen.size === before) break;
  }
  for (const target of [...order].reverse()) signal(target, 'SIGKILL');
  signal(-root, 'SIGKILL');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && order.some(alive)) await new Promise((resolve) => setTimeout(resolve, 20));
}

let cageAuditWritten = false;

/**
 * L4: NASSAJ_PROVIDER_CAGE no longer wraps the OpenCode spawn (Claude is not caged, B-1707).
 * When the flag is on, one audit entry per server process says so.
 */
export function auditProviderCageNotApplied(env: NodeJS.ProcessEnv = process.env, userId: unknown = null): void {
  if (env.NASSAJ_PROVIDER_CAGE !== 'true' || cageAuditWritten) return;
  cageAuditWritten = true;
  const id = Number(userId);
  databaseModule.auditLogDb?.record('opencode_provider_cage_not_applied', {
    userId: Number.isInteger(id) && id > 0 ? id : undefined,
    metadata: { engine: 'opencode', flag: 'NASSAJ_PROVIDER_CAGE' },
  });
  console.warn('[OpenCode] NASSAJ_PROVIDER_CAGE is set but no longer applies to OpenCode (ADR-226 L4)');
}

type Engine = {
  decideTool: (call: Record<string, unknown>) => Promise<{ decision: string; reason?: string; claude?: unknown }>;
  userPromptSubmit: (input: { prompt: string }) => Promise<{ blocked: boolean; reason?: string; additionalContext?: string[]; notices?: string[] }>;
  setSession?: (session: { sessionId: string; transcriptPath: string }) => void;
};

type Writer = { send?: (frame: unknown) => void; ws?: unknown } | null | undefined;

/** The parity broker surface this runtime uses (parity-broker.js is plain JS). */
type Broker = {
  attach: (stream: NodeJS.ReadWriteStream) => void;
  handshake: Promise<boolean>;
  toolResult: (result: { sessionID: string | null; callID: string; input: unknown; status: string }) => boolean;
  state: { refusal: string | null; killCode?: string };
};

export type OpenCodeParityPrepared = {
  runId: string;
  engine: Engine;
  mirror: ClaudeTranscriptMirror;
  mirrorHome: string;
  sessionId: string | null;
};

/**
 * Before spawn: the turn's engine and transcript mirror. A refusal of the engine throws here,
 * so no process is started for it.
 * @param input.createEngine the factory from resolveOpenCodePermissionParity
 * @param input.mirrorHome a dir nassaj owns for the member (the mirror lives under it)
 * @param input.sessionId the resumed session, or null for a new one
 */
export function prepareOpenCodeParityTurn(input: {
  createEngine: (turn: { sessionId: string; transcriptPath: string }) => Engine;
  mirrorHome: string;
  sessionId: string | null;
  cwd: string;
}): OpenCodeParityPrepared {
  const runId = randomUUID();
  const sessionId = input.sessionId ?? `pending-${runId}`;
  const transcriptPath = claudeTranscriptMirrorPath(input.mirrorHome, sessionId);
  const engine = input.createEngine({ sessionId, transcriptPath });
  const mirror = new ClaudeTranscriptMirror({ file: transcriptPath, sessionId, cwd: input.cwd });
  return { runId, engine, mirror, mirrorHome: input.mirrorHome, sessionId: input.sessionId };
}

export type OpenCodeParityTurnInput = {
  child: ChildProcess;
  pluginDigest: string;
  /** The prompt as nassaj built it (runtime instructions included), before hook context. */
  prompt: string;
  /** The member's own text, for UserPromptSubmit and the transcript mirror. */
  userText: string;
  userId: unknown;
  writer: Writer;
  timeoutMs?: number;
};

export type OpenCodeParityOutcome = { ok: true } | { ok: false; code: string; message: string };

const refusal = (code: string): OpenCodeParityOutcome => ({ ok: false, code,
  message: OPENCODE_RUNTIME_TEXT[code] ?? OPENCODE_RUNTIME_TEXT[OPENCODE_RUNTIME_CODES.notLoaded] });

/**
 * After spawn: the parity side of one turn. `released` settles once the prompt was written
 * (ok) or the tree was killed before it (refusal code). Call `onStdoutEvent` for every parsed
 * stdout line and `finish` once the child closed.
 */
export function startOpenCodeParityTurn(prepared: OpenCodeParityPrepared, input: OpenCodeParityTurnInput) {
  const { runId, engine, mirror } = prepared;
  const nonce = randomUUID();
  let sessionId = prepared.sessionId;
  let violation: string | null = null;
  const killTree = (code: string) => {
    violation ??= code;
    void killProcessTree(input.child.pid);
  };
  const askMember = (card: Parameters<typeof opencodePermissionCard>[0]) =>
    requestParityPermission({
      provider: 'opencode', runId, ownerUserId: input.userId, sessionId, writer: input.writer,
      ...opencodePermissionCard(card),
    }).then((how: string) => (how === 'allow' ? 'approve' : 'reject'));
  // requireHash: the plugin always sends one; strictFailures: the hook fires for every call,
  // so a failed result with no record at all is a bypass, not an excuse.
  const broker: Broker = createParityBroker({
    engine, askMember, requireHash: true, strictFailures: true,
    helloPolicy: { nonce, pluginDigest: input.pluginDigest, protocol: OPENCODE_PARITY_PROTOCOL },
    kill: () => killTree(broker.state.refusal ?? broker.state.killCode ?? OPENCODE_RUNTIME_CODES.violation),
    onIncident: (incident: object) => console.warn('[OpenCode] parity incident', { userId: input.userId, ...incident }),
  }) as unknown as Broker;
  const channel = input.child.stdio[3] as (NodeJS.ReadWriteStream & { on: Function }) | null | undefined;
  // Started now so Claude's hooks run while opencode loads its plugins (~9 s).
  const gate = engine.userPromptSubmit({ prompt: input.userText });
  const exited = new Promise<void>((resolve) => { input.child.once('exit', () => resolve()); input.child.once('error', () => resolve()); });

  /** Waits for an accepted hello (false on refusal, exit or timeout). */
  async function handshake(stream: NodeJS.ReadWriteStream & { on: Function }): Promise<boolean> {
    stream.on('error', () => {});
    broker.attach(stream);
    stream.write(`${JSON.stringify({ type: 'challenge', nonce, protocol: OPENCODE_PARITY_PROTOCOL })}\n`);
    let timer: NodeJS.Timeout | undefined;
    const ok = await Promise.race([
      broker.handshake as Promise<boolean>,
      exited.then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), input.timeoutMs ?? openCodeHandshakeTimeoutMs()); }),
    ]);
    clearTimeout(timer);
    return ok === true;
  }

  async function release(): Promise<OpenCodeParityOutcome> {
    if (!channel || !(await handshake(channel))) {
      killTree(broker.state.refusal ?? OPENCODE_RUNTIME_CODES.notLoaded);
      return refusal(OPENCODE_RUNTIME_CODES.notLoaded);
    }
    const verdict = await gate;
    for (const notice of verdict.notices ?? []) console.warn('[OpenCode] UserPromptSubmit hook notice', { notice: String(notice).slice(0, 200) });
    if (verdict.blocked) {
      killTree(OPENCODE_RUNTIME_CODES.promptBlocked);
      return { ok: false, code: OPENCODE_RUNTIME_CODES.promptBlocked,
        message: verdict.reason || OPENCODE_RUNTIME_TEXT[OPENCODE_RUNTIME_CODES.promptBlocked] };
    }
    mirror.user(input.userText);
    // L3: hook context is prepended to the prompt opencode reads; nassaj's record keeps the clean text.
    const context = (verdict.additionalContext ?? []).filter((text) => typeof text === 'string' && text.trim());
    input.child.stdin?.on('error', () => {});
    input.child.stdin?.end([...context, input.prompt].join('\n\n'));
    return { ok: true };
  }

  const released = release().catch((error: unknown) => {
    console.error('[OpenCode] parity release failed', { error: error instanceof Error ? error.message : String(error) });
    killTree(OPENCODE_RUNTIME_CODES.notLoaded);
    return refusal(OPENCODE_RUNTIME_CODES.notLoaded);
  });

  /** A new session's id arrives with the first stdout event: hooks see it from then on. */
  function adoptSession(sid: string | null): void {
    if (!sid || sessionId !== null) return;
    sessionId = sid;
    const next = claudeTranscriptMirrorPath(prepared.mirrorHome, sid);
    mirror.rename(sid, next);
    engine.setSession?.({ sessionId: sid, transcriptPath: next });
  }

  /** One parsed stdout event of the run: mirror it; a settled tool part needs a matching allow. */
  function onStdoutEvent(event: Record<string, any>): void {
    const sid = typeof event?.sessionID === 'string' ? event.sessionID : null;
    adoptSession(sid);
    if (event?.type === 'text' && typeof event.part?.text === 'string') mirror.addText(event.part.text);
    if (event?.type !== 'tool_use' || !event.part) return;
    const { part } = event;
    const state = part.state ?? {};
    if (state.status !== 'completed' && state.status !== 'error') return;
    const isError = state.status === 'error';
    mirror.toolUse(part.callID, part.tool, state.input);
    mirror.toolResult(part.callID, String(isError ? (state.error ?? '') : (state.output ?? '')), isError);
    // A result with no matching allow kills the tree through the broker's kill (undecided result).
    broker.toolResult({ sessionID: sid ?? sessionId, callID: part.callID, input: state.input ?? {}, status: state.status });
  }

  /** After close: no question stays open and nothing of the tree survives. */
  async function finish(): Promise<string | null> {
    cancelParityPermissionsForRun(runId);
    mirror.flushText();
    const { child } = input;
    // A leader that already exited may have a reused pid: only its group is signalled then.
    if (child.exitCode === null && child.signalCode === null) await killProcessTree(child.pid);
    else if (child.pid) signal(-child.pid, 'SIGKILL');
    return violation;
  }

  return {
    runId, released, onStdoutEvent, finish,
    get violation() { return violation; },
    /** Abort: the whole tree goes. */
    stop: () => { void killProcessTree(input.child.pid); },
  };
}
