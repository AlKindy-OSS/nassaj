import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import { providerSecretsService } from '@/modules/providers/index.js';
// eslint-disable-next-line boundaries/dependencies
import { isSpawnBlockedForRunProvider } from '@/modules/providers/harness-update/spawn-admission.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { sanitizeVendorAgentEnv } from '@/services/isolation/sanitize-vendor-agent-env.js';
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

export type ExtendedCliProvider = Extract<CliTurnProvider, 'qwen' | 'opencode' | 'hermes'>;

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
  cwd?: string;
  resolveEnv?: (userId: string | number) => NodeJS.ProcessEnv;
  executableProbe?: (binary: string) => Promise<boolean>;
  versionProbe?: (binary: string) => Promise<string>;
  qwenCapabilityProbe?: (input: { binary: string; env: NodeJS.ProcessEnv }) => Promise<boolean>;
  /** Hermes enablement requires a pinned-runtime probe that observes zero tool definitions. */
  hermesToolDefinitionProbe?: (input: { binary: string; env: NodeJS.ProcessEnv }) => Promise<number>;
  createRoleHome?: () => Promise<EphemeralRoleHome>;
  cleanupRoleHome?: (role: EphemeralRoleHome) => Promise<void>;
  spawnCapture?: (input: IsolatedCliProcessSpec & { role: EphemeralRoleHome; signal?: AbortSignal }) => Promise<IsolatedCliResult>;
}>;

const EXACT_VERSIONS: Readonly<Record<ExtendedCliProvider, string>> = Object.freeze({
  qwen: '0.21.12', opencode: '1.17.18', hermes: '0.17.0',
});

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

async function defaultHermesToolDefinitionProbe(input: { binary: string; env: NodeJS.ProcessEnv }): Promise<number> {
  const role = await createEphemeralRoleHome();
  try {
    const result = await spawnInIsolatedCliCage({
      binary: input.binary,
      args: ['--safe-mode', '--ignore-user-config', '--ignore-rules', '--toolsets', '', 'prompt-size', '--json'],
      cwd: process.cwd(), env: input.env, role,
    });
    if (result.code !== 0) return Number.POSITIVE_INFINITY;
    const parsed = JSON.parse(result.stdout) as { tools?: { count?: unknown } };
    return Number.isSafeInteger(parsed.tools?.count) ? Number(parsed.tools?.count) : Number.POSITIVE_INFINITY;
  } catch { return Number.POSITIVE_INFINITY; }
  finally { await cleanupEphemeralRoleHome(role); }
}

async function defaultQwenCapabilityProbe(input: { binary: string; env: NodeJS.ProcessEnv }): Promise<boolean> {
  try {
    const result = await captureCommand(input.binary, ['--help'], input.env);
    if (result.code !== 0) return false;
    const help = `${result.stdout}\n${result.stderr}`;
    return [
      '--system-prompt', '--safe-mode', '--sandbox', '--approval-mode',
      '--max-tool-calls', '--exclude-tools', '--disabled-slash-commands',
    ].every((option) => help.includes(option));
  } catch { return false; }
}

function hiddenSystem(request: { hiddenContext?: readonly string[]; system?: string }): string {
  return [ROLE_SYSTEM, ...(request.hiddenContext ?? []), request.system ?? ''].filter(Boolean).join('\n\n');
}

function defaultResolvedEnv(userId: string | number, provider: ExtendedCliProvider): NodeJS.ProcessEnv {
  const env = resolveProviderEnv(userId, provider, process.env);
  if (provider !== 'qwen') return env;
  const profile = providerSecretsService.getQwenProfile(userId);
  if (!profile) return env;
  const codingPlan = profile.plan === 'coding_plan';
  const china = profile.region === 'china';
  return {
    ...env,
    [codingPlan ? 'BAILIAN_CODING_PLAN_API_KEY' : 'BAILIAN_TOKEN_PLAN_API_KEY']: profile.key,
    OPENAI_BASE_URL: codingPlan
      ? (china ? 'https://coding.dashscope.aliyuncs.com/v1' : 'https://coding-intl.dashscope.aliyuncs.com/v1')
      : (china ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' : 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'),
  };
}

function qwenSpec(input: { binary: string; cwd: string; env: NodeJS.ProcessEnv; model: string; prompt: string; system: string }): IsolatedCliProcessSpec {
  return Object.freeze({
    binary: input.binary, cwd: input.cwd, env: input.env,
    args: Object.freeze([
      '--prompt', input.prompt, '--system-prompt', input.system,
      '--output-format', 'stream-json', '--safe-mode', '--sandbox',
      '--approval-mode', 'plan', '--max-tool-calls', '0',
      '--exclude-tools', 'agent,task,subagent,spawn_agent,shell,bash,write_file,edit_file,delete_file,mcp,web_fetch,web_search',
      '--disabled-slash-commands', 'agents,agent,task,tools,mcp,extensions,hooks,skills',
      '--model', input.model,
    ]),
  });
}

function opencodeSpec(input: { binary: string; cwd: string; env: NodeJS.ProcessEnv; model: string; prompt: string; system: string }): IsolatedCliProcessSpec {
  const config = JSON.stringify({
    default_agent: 'supervisor',
    agent: { supervisor: { mode: 'primary', prompt: input.system, tools: { '*': false, task: false } } },
    tools: { '*': false, task: false }, permission: { '*': 'deny', task: 'deny' },
  });
  return Object.freeze({
    binary: input.binary, cwd: input.cwd,
    env: Object.freeze({ ...sanitizeVendorAgentEnv(input.env), OPENCODE_CONFIG_CONTENT: config }),
    args: Object.freeze(['run', '--pure', '--format', 'json', '--agent', 'supervisor', '--model', input.model, input.prompt]),
  });
}

function hermesSpec(input: { binary: string; cwd: string; env: NodeJS.ProcessEnv; model: string; prompt: string; system: string }): IsolatedCliProcessSpec {
  return Object.freeze({
    binary: input.binary, cwd: input.cwd,
    env: Object.freeze({ ...input.env, HERMES_SYSTEM_PROMPT: input.system }),
    args: Object.freeze([
      '--safe-mode', '--ignore-user-config', '--ignore-rules', '--toolsets', '',
      '--model', input.model, '--oneshot', input.prompt,
    ]),
  });
}

function parseJsonLines(provider: 'qwen' | 'opencode', stdout: string): string {
  let text = '';
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (provider === 'qwen') {
      const message = event.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (typeof event.result === 'string') text = event.result;
      else if (typeof content === 'string' && (message?.role === 'assistant' || event.type === 'assistant')) text += content;
    } else {
      const part = (event.part ?? event) as Record<string, unknown>;
      if (typeof part.text === 'string' && (part.type === 'text' || event.type === 'text')) text += part.text;
      else if (typeof event.content === 'string' && event.type === 'assistant') text += event.content;
    }
  }
  return text.trim();
}

function parseOutput(provider: ExtendedCliProvider, stdout: string): string {
  return provider === 'hermes' ? stdout.trim() : parseJsonLines(provider, stdout);
}

/** Strict, capture-only Qwen/OpenCode/Hermes registrations. There is no legacy passthrough path. */
export function createExtendedCliAdapter(provider: ExtendedCliProvider, options: AdapterOptions = {}): TurnAdapterRegistration {
  const binary = options.binary ?? (provider === 'opencode' ? resolveOpenCodeBinaryPath() : provider);
  const cwd = options.cwd ?? process.cwd();
  const resolveEnv = options.resolveEnv ?? ((userId: string | number) => defaultResolvedEnv(userId, provider));
  const executableProbe = options.executableProbe ?? executable;
  const versionProbe = options.versionProbe ?? defaultVersionProbe;
  const createRole = options.createRoleHome ?? createEphemeralRoleHome;
  const cleanupRole = options.cleanupRoleHome ?? cleanupEphemeralRoleHome;
  const run = options.spawnCapture ?? spawnInIsolatedCliCage;
  let pinnedAndSafe = false;
  const registration: TurnAdapterRegistration = {
    id: `${provider}-cli-supervisor-ephemeral`, capabilities: EXTENDED_CLI_CAPABILITIES,
    supports(candidate: string): candidate is ExtendedCliProvider { return candidate === provider; },
    async probe({ userId }): Promise<boolean> {
      // T-1749/ADR-159: never probe (spawn) a binary that is being replaced.
      if (isSpawnBlockedForRunProvider(provider)) return false;
      if (!await executableProbe(binary) || await versionProbe(binary) !== EXACT_VERSIONS[provider]) return false;
      const env = resolveEnv(userId);
      if (provider === 'qwen') {
        const capabilityProbe = options.qwenCapabilityProbe ?? defaultQwenCapabilityProbe;
        if (!await capabilityProbe({ binary, env })) return false;
      }
      if (provider === 'hermes') {
        const toolProbe = options.hermesToolDefinitionProbe ?? defaultHermesToolDefinitionProbe;
        if (await toolProbe({ binary, env }) !== 0) return false;
      }
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
      if (isSpawnBlockedForRunProvider(provider)) {
        throw new TurnAdapterError('provider_unavailable', `The ${provider} runtime is being updated right now`);
      }
      const role = await createRole();
      try {
        const common = {
          binary, cwd, env: resolveEnv(request.userId), model: request.model,
          prompt: request.prompt, system: hiddenSystem(request),
        };
        const spec = provider === 'qwen' ? qwenSpec(common)
          : provider === 'opencode' ? opencodeSpec(common) : hermesSpec(common);
        const result = await run({ ...spec, role, signal: request.signal });
        if (result.code !== 0) {
          throw new TurnAdapterError('remote_error', `${provider} CLI exited ${result.code}: ${result.stderr.slice(0, 500)}`);
        }
        const text = parseOutput(provider, result.stdout);
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
  EXACT_VERSIONS, ROLE_SYSTEM, qwenSpec, opencodeSpec, hermesSpec, parseOutput,
  defaultVersionProbe, defaultHermesToolDefinitionProbe,
  defaultQwenCapabilityProbe,
});
