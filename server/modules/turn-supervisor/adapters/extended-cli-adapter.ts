import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { collectOpenCodeTurnSecrets } from '@/modules/providers/index.js';
// eslint-disable-next-line boundaries/dependencies
import { isSpawnBlockedForRunProvider } from '@/modules/providers/harness-update/spawn-admission.js';
import { resolveModelRunEnv } from '@/services/isolation/credential-gate.js';
import { sanitizeVendorAgentEnv } from '@/services/isolation/sanitize-vendor-agent-env.js';
import { isQwenPlanModel, redactLiteralSecrets } from '@/services/isolation/opencode-qwen-plan.js';
import { spawnVendorRunOf } from '@/services/isolation/opencode-spawn-vendor.js';
import { resolveOpenCodeBinaryPath } from '@/shared/utils.js';

import {
  cleanupEphemeralRoleHome,
  createEphemeralRoleHome,
  spawnInIsolatedCliCage,
  type EphemeralRoleHome,
  type IsolatedCliProcessSpec,
  type IsolatedCliResult,
} from './isolated-cli-cage.js';
import {
  TurnAdapterError,
  type CliTurnProvider,
  type TurnAdapterCapabilities,
  type TurnAdapterRegistration,
  type TurnAdapterResult,
} from './types.js';

export type ExtendedCliProvider = Extract<CliTurnProvider, 'opencode'>;

const ROLE_SYSTEM = [
  'You are an internal capture-only role in the server Turn Supervisor.',
  'You have zero tools and zero native delegation authority.',
  'Return only the requested response. Never persist, resume, publish, or perform effects.',
].join(' ');

export const EXTENDED_CLI_CAPABILITIES: TurnAdapterCapabilities = Object.freeze({
  execution: 'ephemeral-cli', persist: false, hiddenContext: 'system', abort: true, effects: 'none',
  nativeDelegation: Object.freeze({ supported: false, reason: 'supervisor_disables_native_delegation' }),
});

type AdapterOptions = Readonly<{
  binary?: string;
  /** Feature-flag source for the spawn-only model rule (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Literal secrets of a turn, for stderr redaction (defaults to the M-6 collector). */
  turnSecrets?: (userId: string | number) => readonly string[];
  cwd?: string;
  resolveEnv?: (userId: string | number, model?: string) => NodeJS.ProcessEnv;
  executableProbe?: (binary: string) => Promise<boolean>;
  versionProbe?: (binary: string) => Promise<string>;
  /** opencode cell: the run flags exist and the zero-tools/deny config resolves (not a version pin). */
  opencodeCapabilityProbe?: (input: { binary: string; env: NodeJS.ProcessEnv; cwd: string }) => Promise<boolean>;
  createRoleHome?: () => Promise<EphemeralRoleHome>;
  cleanupRoleHome?: (role: EphemeralRoleHome) => Promise<void>;
  spawnCapture?: (input: IsolatedCliProcessSpec & { role: EphemeralRoleHome; signal?: AbortSignal }) => Promise<IsolatedCliResult>;
}>;

/**
 * opencode is not version-pinned (owner decision 2026-09-29): any release that
 * runs and reports a version is accepted, so the cell survives harness updates.
 */
function versionAccepted(version: string): boolean {
  return version !== '';
}

async function executable(binary: string): Promise<boolean> {
  if (!binary.includes('/')) return true;
  try { await access(binary); return true; } catch { return false; }
}

function captureCommand(binary: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<IsolatedCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function defaultVersionProbe(binary: string): Promise<string> {
  try {
    const result = await captureCommand(binary, ['--version']);
    if (result.code !== 0) return '';
    return `${result.stdout}\n${result.stderr}`.match(/\bv?(\d+\.\d+\.\d+)\b/u)?.[1] ?? '';
  } catch { return ''; }
}

/** Flags the opencode cell passes to `opencode run` (see opencodeSpec). */
const OPENCODE_RUN_FLAGS = Object.freeze(['--pure', '--format', '--agent', '--model']);

/** True when a resolved `debug agent` document keeps every tool off and denies `*`. */
function opencodeAgentIsToolless(stdout: string): boolean {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return false;
  const agent = JSON.parse(stdout.slice(start, end + 1)) as {
    tools?: Record<string, unknown>; permission?: { permission?: unknown; action?: unknown }[];
  };
  const tools = Object.values(agent.tools ?? {});
  const deniesAll = (agent.permission ?? []).some((rule) => rule.permission === '*' && rule.action === 'deny');
  return tools.length > 0 && tools.every((enabled) => enabled === false) && deniesAll;
}

/**
 * opencode cell capability probe, run in the same cage as the cell: `run --help`
 * must list the flags the cell uses, and `debug agent supervisor` under the
 * cell's OPENCODE_CONFIG_CONTENT must resolve to zero enabled tools. Fails closed
 * for this cell only; interactive opencode/GLM chat never calls it.
 */
async function defaultOpencodeCapabilityProbe(input: { binary: string; env: NodeJS.ProcessEnv; cwd: string }): Promise<boolean> {
  const role = await createEphemeralRoleHome();
  try {
    const env = opencodeCellEnv(input.env, ROLE_SYSTEM);
    const help = await spawnInIsolatedCliCage({ binary: input.binary, args: ['run', '--help'], cwd: input.cwd, env, role });
    const helpText = `${help.stdout}\n${help.stderr}`;
    if (help.code !== 0 || !OPENCODE_RUN_FLAGS.every((flag) => helpText.includes(flag))) return false;
    const agent = await spawnInIsolatedCliCage({
      binary: input.binary, args: ['debug', 'agent', 'supervisor'], cwd: input.cwd, env, role,
    });
    return agent.code === 0 && opencodeAgentIsToolless(agent.stdout);
  } catch { return false; }
  finally { await cleanupEphemeralRoleHome(role); }
}

/**
 * ADR-200 S7/S8, B-1550: models only spawnOpenCode may run — `qwen-plan/*`, and
 * `moonshot/*` / `deepseek/*` while NASSAJ_OPENCODE_SPAWN_VENDORS is on (B-1575). They must
 * spend the SENDER's own vendor key under the carrier guards; this cell runs
 * opencode under a grant-honoring env, so it must never launch them.
 */
export function isSpawnOnlyOpenCodeModel(model: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return isQwenPlanModel(model) || spawnVendorRunOf(model, env) !== null;
}

/** CLI stderr for an error message: every key of the turn redacted, then bounded. */
function redactedStderr(stderr: string, secrets: readonly string[]): string {
  return redactLiteralSecrets(stderr, secrets).slice(0, 500);
}

function hiddenSystem(request: { hiddenContext?: readonly string[]; system?: string }): string {
  return [ROLE_SYSTEM, ...(request.hiddenContext ?? []), request.system ?? ''].filter(Boolean).join('\n\n');
}

function defaultResolvedEnv(userId: string | number, provider: ExtendedCliProvider, model?: string): NodeJS.ProcessEnv {
  // ADR-152 A1 §3.5: the credential gate admits the turn before the env exists.
  return resolveModelRunEnv(userId, provider, process.env, 'agent', { model: model ?? null });
}

/** The cell's sanitized env with its zero-tools, deny-all inline config. */
function opencodeCellEnv(env: NodeJS.ProcessEnv, system: string): NodeJS.ProcessEnv {
  const config = JSON.stringify({
    default_agent: 'supervisor',
    agent: { supervisor: { mode: 'primary', prompt: system, tools: { '*': false, task: false } } },
    tools: { '*': false, task: false }, permission: { '*': 'deny', task: 'deny' },
  });
  return Object.freeze({ ...sanitizeVendorAgentEnv(env), OPENCODE_CONFIG_CONTENT: config });
}

function opencodeSpec(input: { binary: string; cwd: string; env: NodeJS.ProcessEnv; model: string; prompt: string; system: string }): IsolatedCliProcessSpec {
  return Object.freeze({
    binary: input.binary, cwd: input.cwd,
    env: opencodeCellEnv(input.env, input.system),
    args: Object.freeze(['run', '--pure', '--format', 'json', '--agent', 'supervisor', '--model', input.model, input.prompt]),
  });
}

/** Final assistant text from `opencode run --format json` output lines. */
function parseOutput(stdout: string): string {
  let text = '';
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const part = (event.part ?? event) as Record<string, unknown>;
    if (typeof part.text === 'string' && (part.type === 'text' || event.type === 'text')) text += part.text;
    else if (typeof event.content === 'string' && event.type === 'assistant') text += event.content;
  }
  return text.trim();
}

/** Strict, capture-only OpenCode registration. There is no legacy passthrough path. */
export function createExtendedCliAdapter(provider: ExtendedCliProvider, options: AdapterOptions = {}): TurnAdapterRegistration {
  const cwd = options.cwd ?? process.cwd();
  const flagEnv = options.env ?? process.env;
  const turnSecrets = options.turnSecrets ?? collectOpenCodeTurnSecrets;
  const resolveEnv = options.resolveEnv
    ?? ((userId: string | number, model?: string) => defaultResolvedEnv(userId, provider, model));
  const executableProbe = options.executableProbe ?? executable;
  const versionProbe = options.versionProbe ?? defaultVersionProbe;
  const createRole = options.createRoleHome ?? createEphemeralRoleHome;
  const cleanupRole = options.cleanupRoleHome ?? cleanupEphemeralRoleHome;
  const run = options.spawnCapture ?? spawnInIsolatedCliCage;
  let pinnedAndSafe = false;
  // Resolved at probe time through the harness registry (T-1873) and pinned for
  // invoke; opencode's digest pin applies only when NASSAJ_VENDOR_BINARY_PIN is armed.
  let binary = '';
  const registration: TurnAdapterRegistration = {
    id: `${provider}-cli-supervisor-ephemeral`, capabilities: EXTENDED_CLI_CAPABILITIES,
    supports(candidate: string): candidate is ExtendedCliProvider { return candidate === provider; },
    async probe({ userId }): Promise<boolean> {
      // T-1749/ADR-159: never probe (spawn) a binary that is being replaced.
      if (isSpawnBlockedForRunProvider(provider)) return false;
      try {
        // opencode goes through its (opt-in) digest-pin wrapper; throws when unresolved.
        binary = options.binary ?? resolveOpenCodeBinaryPath();
      } catch {
        return false;
      }
      if (!await executableProbe(binary) || !versionAccepted(await versionProbe(binary))) return false;
      let env: NodeJS.ProcessEnv;
      try {
        env = resolveEnv(userId);
      } catch {
        return false; // no linked credential (or no member): this cell cannot run for them
      }
      const capabilityProbe = options.opencodeCapabilityProbe ?? defaultOpencodeCapabilityProbe;
      if (!await capabilityProbe({ binary, env, cwd })) return false;
      pinnedAndSafe = true;
      return true;
    },
    async invoke(request): Promise<TurnAdapterResult> {
      if (request.provider !== provider || !pinnedAndSafe) {
        throw new TurnAdapterError('provider_unavailable', `${provider} supervisor cell was not pinned and probed`);
      }
      if (request.persist !== false) throw new TurnAdapterError('invalid_persistence', 'supervised CLI roles are ephemeral');
      if (request.effects?.length) throw new TurnAdapterError('effects_unsupported', 'supervised CLI roles deny effects');
      if (request.signal?.aborted) throw new TurnAdapterError('aborted', `${provider} role aborted before launch`);
      // T-1906 / ADR-200 S7-S8 (B-1550): a Token Plan, Moonshot or DeepSeek turn
      // runs only through spawnOpenCode (the sender's own key, carrier guards).
      // The supervisor routes these models away; this refusal is defense in depth.
      if (isSpawnOnlyOpenCodeModel(request.model, flagEnv)) {
        throw new TurnAdapterError('credential_unavailable', 'This model runs only through the standard chat path');
      }
      if (isSpawnBlockedForRunProvider(provider)) {
        throw new TurnAdapterError('provider_unavailable', `The ${provider} runtime is being updated right now`);
      }
      const role = await createRole();
      try {
        const common = {
          binary, cwd, env: resolveEnv(request.userId, request.model), model: request.model,
          prompt: request.prompt, system: hiddenSystem(request),
        };
        const spec = opencodeSpec(common);
        const result = await run({ ...spec, role, signal: request.signal });
        if (result.code !== 0) {
          throw new TurnAdapterError('remote_error', `${provider} CLI exited ${result.code}: ${redactedStderr(result.stderr, turnSecrets(request.userId))}`);
        }
        const text = parseOutput(result.stdout);
        if (!text) throw new TurnAdapterError('remote_error', `${provider} CLI returned no final assistant response`);
        await request.writer.capture({ type: 'text', text });
        await request.writer.capture({ type: 'complete' });
        return { provider, model: request.model, text };
      } catch (error) {
        if (error instanceof TurnAdapterError) throw error;
        throw new TurnAdapterError('remote_error', `${provider} supervised CLI launch failed`, { cause: error });
      } finally {
        await cleanupRole(role);
      }
    },
  };
  return Object.freeze(registration);
}

export const extendedCliAdapterInternals = Object.freeze({
  ROLE_SYSTEM, opencodeSpec, parseOutput,
  defaultVersionProbe, opencodeAgentIsToolless, OPENCODE_RUN_FLAGS,
});
