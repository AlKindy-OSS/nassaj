import { spawn } from 'node:child_process';

import { ensureCodexGovernance } from '@/modules/providers/index.js';
// eslint-disable-next-line boundaries/dependencies
import { isSpawnBlockedForRunProvider } from '@/modules/providers/harness-update/spawn-admission.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import {
  acquireCodexLaunchIdentity,
  assertCodexIdentityUnchanged,
  codexLaunchOptions,
  CODEX_MACHINE_CLI_MISSING_MESSAGE,
  isCodexMachineCliMissing,
  resolveCodexMachineRuntime,
} from '@/shared/codex-executable.js';
import { assertCodexRuntimeCompatible, isCodexRuntimeIncompatible } from '@/shared/codex-runtime-compat.js';

import {
  TurnAdapterError,
  type TurnAdapterCapabilities,
  type TurnAdapterProbeRequest,
  type TurnAdapterRegistration,
  type TurnAdapterResult,
  type TurnCaptureEvent,
} from './types.js';

const INTERNAL_ROLE_CONTRACT = [
  'You are an internal capture-only role in the server Turn Supervisor.',
  'Do not use tools, shell commands, file operations, network tools, MCP, apps, skills, or native sub-agents.',
  'Do not attempt to persist or resume a conversation. Return only the requested answer.',
].join(' ');

export const CODEX_CLI_CAPABILITIES: TurnAdapterCapabilities = Object.freeze({
  execution: 'ephemeral-cli',
  persist: false,
  hiddenContext: 'system',
  abort: true,
  effects: 'none',
  nativeDelegation: Object.freeze({
    supported: false,
    reason: 'supervisor_disables_native_delegation',
  }),
});

type SpawnResult = Readonly<{ code: number | null; stdout: string; stderr: string }>;

type CodexLaunchIdentity = ReturnType<typeof acquireCodexLaunchIdentity>;

export type CodexCliAdapterOptions = Readonly<{
  cwd?: string;
  resolveEnv?: (userId: string | number) => NodeJS.ProcessEnv;
  governanceProbe?: (userId: string | number) => boolean;
  executableProbe?: () => Promise<boolean>;
  /** T-1872 seams: the machine Codex identity for one invocation and its pre-spawn re-check. */
  acquireIdentity?: () => CodexLaunchIdentity;
  assertUnchanged?: (identity: CodexLaunchIdentity) => void;
  /** T-1872 part 2 seam: the cached runtime-compatibility verdict for that identity. */
  assertCompatible?: (identity: CodexLaunchIdentity) => Promise<unknown>;
  spawnCapture?: (input: {
    binary: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal;
  }) => Promise<SpawnResult>;
}>;

/**
 * Available when the machine Codex release layout resolves. Deliberately cheap
 * (qa M2): no tree hash and no process; invoke() seals and judges the release.
 */
async function machineCodexAvailable(): Promise<boolean> {
  try {
    resolveCodexMachineRuntime();
    return true;
  } catch {
    return false;
  }
}

function spawnCapture(input: {
  binary: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal;
}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let aborted = false;
    const signalTree = (signal: NodeJS.Signals): void => {
      if (process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, signal); return; } catch { /* already dead */ }
      }
      try { child.kill(signal); } catch { /* already dead */ }
    };
    const groupAlive = (): boolean => {
      if (process.platform === 'win32' || !child.pid) return child.exitCode === null;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
    };
    const wait = (): Promise<void> => new Promise((done) => setTimeout(done, 25));
    const reapTree = async (): Promise<void> => {
      signalTree('SIGTERM');
      for (let attempt = 0; attempt < 20 && groupAlive(); attempt += 1) await wait();
      if (groupAlive()) signalTree('SIGKILL');
      // Never attest terminal while any descendant in the process group lives.
      while (groupAlive()) await wait();
    };
    const abort = (): void => {
      aborted = true;
      signalTree('SIGTERM');
    };
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', async (code) => {
      input.signal?.removeEventListener('abort', abort);
      await reapTree();
      if (aborted) {
        reject(new TurnAdapterError('aborted', 'Codex supervised role was aborted'));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function parseCodexJsonl(stdout: string): { text: string; usage?: TurnCaptureEvent & { type: 'usage' } } {
  let text = '';
  let usage: (TurnCaptureEvent & { type: 'usage' }) | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const item = event.item as Record<string, unknown> | undefined;
    if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      text = item.text;
    }
    const tokenUsage = event.usage as Record<string, unknown> | undefined;
    if (event.type === 'turn.completed' && tokenUsage) {
      usage = {
        type: 'usage',
        ...(Number.isFinite(tokenUsage.input_tokens) ? { inputTokens: Number(tokenUsage.input_tokens) } : {}),
        ...(Number.isFinite(tokenUsage.output_tokens) ? { outputTokens: Number(tokenUsage.output_tokens) } : {}),
      };
    }
  }
  return { text, ...(usage ? { usage } : {}) };
}

/** Actual Codex CLI adapter: ephemeral JSONL, read-only sandbox, no native agents. */
export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}): TurnAdapterRegistration {
  const acquireIdentity = options.acquireIdentity ?? acquireCodexLaunchIdentity;
  const assertUnchanged = options.assertUnchanged ?? assertCodexIdentityUnchanged;
  const assertCompatible = options.assertCompatible ?? assertCodexRuntimeCompatible;
  const cwd = options.cwd ?? process.cwd();
  const resolveEnv = options.resolveEnv ?? ((userId) => resolveProviderEnv(userId, 'codex', process.env));
  const governanceProbe = options.governanceProbe ?? ((userId) => ensureCodexGovernance(userId).ok);
  const executableProbe = options.executableProbe ?? machineCodexAvailable;
  const run = options.spawnCapture ?? spawnCapture;
  const registration: TurnAdapterRegistration = {
    id: 'codex-cli-ephemeral',
    capabilities: CODEX_CLI_CAPABILITIES,
    supports(provider: string): provider is 'codex' {
      return provider === 'codex';
    },
    async probe({ userId }: TurnAdapterProbeRequest): Promise<boolean> {
      // T-1749/ADR-159: a harness mid-update is unavailable, not merely busy.
      if (isSpawnBlockedForRunProvider('codex')) return false;
      return governanceProbe(userId) && executableProbe();
    },
    async invoke(request): Promise<TurnAdapterResult> {
      if (request.provider !== 'codex') {
        throw new TurnAdapterError('provider_unavailable', 'Codex adapter received another provider');
      }
      if (request.persist !== false) {
        throw new TurnAdapterError('invalid_persistence', 'Codex supervised roles must be ephemeral');
      }
      if (request.effects && request.effects.length > 0) {
        throw new TurnAdapterError('effects_unsupported', 'Codex supervised roles deny effects');
      }
      if (request.signal?.aborted) throw new TurnAdapterError('aborted', 'Codex role aborted before launch');
      if (isSpawnBlockedForRunProvider('codex')) {
        throw new TurnAdapterError('provider_unavailable', 'The codex runtime is being updated right now');
      }
      const hidden = [INTERNAL_ROLE_CONTRACT, ...(request.hiddenContext ?? []), request.system ?? '']
        .filter(Boolean).join('\n\n');
      const args = [
        'exec', '--ephemeral', '--json', '--strict-config', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--sandbox', 'read-only', '--model', request.model,
        '--config', 'project_doc_max_bytes=0',
        '--config', 'features.multi_agent=false',
        '--config', 'approval_policy="never"',
        '--config', 'web_search="disabled"',
        '--config', `developer_instructions=${JSON.stringify(hidden)}`,
        request.prompt,
      ] as const;
      let identity: CodexLaunchIdentity;
      try {
        identity = acquireIdentity();
        await assertCompatible(identity);
      } catch (error) {
        const message = isCodexRuntimeIncompatible(error) ? (error as Error).message
          : isCodexMachineCliMissing(error) ? CODEX_MACHINE_CLI_MISSING_MESSAGE : 'The Codex installation is not usable';
        throw new TurnAdapterError('provider_unavailable', message, { cause: error });
      }
      let result: SpawnResult;
      try {
        assertUnchanged(identity);
        const launch = codexLaunchOptions(resolveEnv(request.userId), identity);
        result = await run({
          binary: launch.codexPathOverride, args, cwd, env: launch.env, signal: request.signal,
        });
      } catch (error) {
        if (error instanceof TurnAdapterError) throw error;
        throw new TurnAdapterError('remote_error', 'Codex CLI could not be launched', { cause: error });
      }
      if (result.code !== 0) {
        throw new TurnAdapterError('remote_error', `Codex CLI exited ${result.code}: ${result.stderr.slice(0, 500)}`);
      }
      const parsed = parseCodexJsonl(result.stdout);
      if (!parsed.text) throw new TurnAdapterError('remote_error', 'Codex CLI returned no final assistant message');
      await request.writer.capture({ type: 'text', text: parsed.text });
      if (parsed.usage) await request.writer.capture(parsed.usage);
      await request.writer.capture({ type: 'complete' });
      return {
        provider: 'codex', model: request.model, text: parsed.text,
        ...(parsed.usage ? { usage: {
          inputTokens: parsed.usage.inputTokens, outputTokens: parsed.usage.outputTokens,
        } } : {}),
      };
    },
  };
  return Object.freeze(registration);
}

export const codexCliAdapterInternals = Object.freeze({
  parseCodexJsonl, INTERNAL_ROLE_CONTRACT, spawnCapture,
});
