/**
 * resume-turn-runner — the REAL `claude -p --resume` headless writer behind the
 * injector's `runResumeTurn` dep (agent.js SSE/collector + claude-sdk emptyPrompt
 * pattern, but out-of-process in the supervisor). Kept separate so the injector
 * core is unit-testable with a stub; this file is exercised live by the shadow
 * harness.
 *
 * SAFETY / LEAF-ONLY (الشرط 2):
 *   - parameterized argv (no shell) — a conversationId/prompt can never inject.
 *   - `--disallowed-tools Task Workflow` blocks the background-spawning tools;
 *     placed right before the positional `-p <prompt>` so the variadic stops at
 *     `-p` and never swallows the prompt.
 *   - the env is the caller's STRICT, workflow-stripped provider env.
 * BOUNDED (§ج-4): a hard hold-cap timer SIGTERMs then SIGKILLs the child, so the
 *   injector never holds the per-conversation lock "minutes open".
 * OUTPUT: `--output-format json` → the single result object is parsed for token
 *   usage (§د metering); an unparseable stdout still resolves (raw excerpt).
 */

import { spawn } from 'node:child_process';

import type { ResumeTurnParams, ResumeTurnResult } from './handoff-injector.js';
import { INJECTOR_SIGKILL_GRACE_MS } from './config.js';

/** Cap the captured stdout so a runaway turn cannot balloon memory. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;
/** Grace between SIGTERM and the hard SIGKILL at the hold cap. Single source of
 * truth in config so the chat-lock timing invariant (validateChatLockConfig)
 * reasons about the SAME worst-case hold the runner actually enforces. */
const KILL_GRACE_MS = INJECTOR_SIGKILL_GRACE_MS;

export function defaultRunResumeTurn(params: ResumeTurnParams): Promise<ResumeTurnResult> {
  return new Promise((resolve) => {
    const args: string[] = [
      '-r',
      params.conversationId,
      '--output-format',
      'json',
      '--append-system-prompt',
      params.systemFraming,
      ...(params.model ? ['--model', params.model] : []),
      // Variadic — MUST be the last flag before the positional `-p <prompt>`.
      '--disallowed-tools',
      ...params.disallowedTools,
      '-p',
      params.prompt,
    ];

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(params.claudeBin, args, {
        cwd: params.projectPath,
        env: params.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        ok: false,
        exitCode: null,
        timedOut: false,
        resultObj: null,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const clearTimers = (): void => {
      if (killTimer) clearTimeout(killTimer);
      if (hardTimer) clearTimeout(hardTimer);
    };

    if (params.maxHoldMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        hardTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, KILL_GRACE_MS);
      }, params.maxHoldMs);
    }

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
      if (stdout.length > MAX_STDOUT_BYTES) {
        stdout = stdout.slice(-MAX_STDOUT_BYTES);
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < 8192) {
        stderr += d.toString('utf8');
      }
    });

    child.on('error', (err) => {
      clearTimers();
      resolve({ ok: false, exitCode: null, timedOut, resultObj: null, error: err.message });
    });

    child.on('close', (code) => {
      clearTimers();
      let resultObj: unknown = null;
      try {
        resultObj = JSON.parse(stdout);
      } catch {
        resultObj = { raw: stdout.slice(0, 4096) };
      }
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        timedOut,
        resultObj,
        error: timedOut
          ? 'hold-cap timeout'
          : code !== 0
            ? stderr.slice(0, 1024) || `exit ${String(code)}`
            : undefined,
      });
    });
  });
}
