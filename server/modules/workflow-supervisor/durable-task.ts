/**
 * Durable-task writer (ADR-053 §أ-1/§ب-1) — the PARALLEL writer for the explicit
 * launch route. This is the "durable task" side of B-103: the request path drops
 * a validated DurableTask intent and ENDS its turn; the standalone supervisor
 * launches it fresh, so the work was NEVER a child of the requesting process and
 * survives its death (the structural fix over the decommissioned Layer 2).
 *
 * DELIBERATELY SEPARATE FROM writeLaunchIntent
 * --------------------------------------------
 * `writeLaunchIntent` (the Layer-2 chat bridge) is decommissioned and gated by
 * `inlineWorkflowsActive`/`pendingWorkflows` — semantics that DO NOT apply to an
 * explicit request. This writer reuses ONLY the atomic tmp→rename primitive and
 * the strict validator; it has NONE of the Layer-2 gates. (Do NOT merge them; do
 * NOT re-enable Layer 2.)
 *
 * NO-OP WHEN THE FLAG IS OFF: returns immediately having touched nothing.
 * NEVER THROWS: all I/O errors map to a `written:false` result.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { isSupervisorEnabled, userIntentDir } from './config.js';
import { validateIntent, type DurableTask, type HandoffPolicy } from './intent.js';

/**
 * Atomic JSON write with restrictive modes: 0700 leaf dir, 0600 file (the intent
 * is a web-originated surface — §هـ-4). tmp → fsync → rename so the supervisor
 * never reads a half-written intent.
 */
async function atomicWriteJson0600(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask — enforce 0700 on the leaf explicitly.
  await fsp.chmod(dir, 0o700).catch(() => {});
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = await fsp.open(tmp, 'w', 0o600);
  try {
    await fd.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fsp.rename(tmp, filePath);
  // fsync the directory so the rename is durable.
  const dfd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dfd);
  } finally {
    fs.closeSync(dfd);
  }
}

export type WriteDurableTaskInput = {
  userId: number;
  projectPath: string;
  scriptOrPrompt: string;
  conversationId: string;
  originMessageId: string;
  model?: string | null;
  effort?: string | null;
  /** Delivery policy (§د); defaults to card-only (T-830). */
  handoffPolicy?: HandoffPolicy;
  env?: NodeJS.ProcessEnv;
};

export type WriteDurableTaskResult =
  | { written: true; taskId: string; path: string }
  | { written: false; reason: string };

/**
 * Persist an explicit background-task intent. The blob is self-validated by the
 * STRICT v2 validator before it is written, so the supervisor never sees a
 * malformed durable task from us (its own re-validation is defense-in-depth
 * against a tampered file).
 */
export async function writeDurableTask(
  input: WriteDurableTaskInput,
): Promise<WriteDurableTaskResult> {
  const env = input.env ?? process.env;

  // Master no-op gate: OFF => touch nothing.
  if (!isSupervisorEnabled(env)) {
    return { written: false, reason: 'flag off' };
  }

  const taskId = randomUUID();
  const task: DurableTask = {
    schema_version: '2',
    taskId,
    userId: input.userId,
    projectPath: input.projectPath,
    conversationId: input.conversationId,
    originMessageId: input.originMessageId,
    spec: {
      scriptOrPrompt: input.scriptOrPrompt,
      model: input.model ?? null,
      effort: input.effort ?? null,
      handoffPolicy: input.handoffPolicy ?? 'card-only',
      leafOnly: true,
    },
    requestedAt: new Date().toISOString(),
  };

  // Validate our OWN write (strict v2) so a shape bug never reaches the supervisor.
  const check = validateIntent(task);
  if (!check.ok) {
    return { written: false, reason: `self-validation failed: ${check.reason}` };
  }

  const filePath = path.join(userIntentDir(input.userId, env), `${taskId}.json`);
  try {
    await atomicWriteJson0600(filePath, task);
    return { written: true, taskId, path: filePath };
  } catch (error) {
    return {
      written: false,
      reason: `durable-task write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
