/**
 * Scope-status bridge for the app-level workflow-status endpoint (ADR-053 §ج-2).
 *
 * This is the seam that lets workflow-status.service consult the NEW is-active
 * source for scope-launched workflows WITHOUT modifying the sacred Layer-1 pid
 * classifier. It builds a lookup from the supervisor's on-disk records:
 *
 *   scopes/<wfLaunchId>/supervisor.json  →  { unit, projectPath }
 *
 * and exposes `resolveScopeLivenessFor(projectPath)` which, for a workflow that
 * belongs to a scope, returns its is-active verdict (RUNNING/COMPLETED/ORPHAN),
 * or null when the workflow is NOT scope-launched (then the caller keeps using
 * the pid path — precedence: scope wins, pid is the fallback).
 *
 * HARD NO-OP WHEN THE FLAG IS OFF
 * -------------------------------
 * `buildScopeLivenessResolver` returns `null` when WORKFLOW_SUPERVISOR is off, so
 * workflow-status.service passes `undefined` to the scanner and its behavior is
 * byte-identical to today (pid-only). Nothing in this file runs on the critical
 * path; it is a read-only disk lookup invoked by the status endpoint only.
 *
 * MATCHING: the supervisor keys records by wfLaunchId (a UUID) while the journal
 * keys workflows by wf_<id>. They are DIFFERENT ids, so the link is by the
 * session's projectPath: a scope record for this project makes its scope unit the
 * authoritative liveness source for that project's workflows. When multiple
 * scopes target one project the freshest (latest heartbeat) wins.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { isSupervisorEnabled, scopesDir } from './config.js';
import { classifyScopeLiveness, type ScopeLiveness } from './scope-liveness.js';
import { systemctlIsActive } from './systemd.js';

type ScopeRecord = { unit: string; projectPath: string; heartbeat: string };

/**
 * A resolver: given a project path, returns the is-active liveness of its most
 * recent scope, or null when no scope targets that project (fall back to pid).
 */
export type ScopeLivenessResolver = (projectPath: string) => Promise<ScopeLiveness | null>;

/**
 * Build a resolver from the supervisor's scope records. Returns null (=> caller
 * stays pid-only) when the feature is off or no records exist. Read-only,
 * fail-safe: any unreadable record is skipped, never thrown.
 */
export async function buildScopeLivenessResolver(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScopeLivenessResolver | null> {
  if (!isSupervisorEnabled(env)) {
    return null;
  }

  const root = scopesDir(env);
  let dirs: string[];
  try {
    dirs = await fsp.readdir(root);
  } catch {
    return null; // no scopes launched yet
  }

  // projectPath → freshest scope record.
  const byProject = new Map<string, ScopeRecord>();
  for (const wfLaunchId of dirs) {
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(path.join(root, wfLaunchId, 'supervisor.json'), 'utf8'));
    } catch {
      continue;
    }
    const rec = raw as {
      projectPath?: unknown;
      session?: { unit?: unknown; heartbeat?: unknown };
    };
    const projectPath = typeof rec.projectPath === 'string' ? rec.projectPath : null;
    const unit = typeof rec.session?.unit === 'string' ? rec.session.unit : null;
    const heartbeat = typeof rec.session?.heartbeat === 'string' ? rec.session.heartbeat : '';
    if (!projectPath || !unit) {
      continue;
    }
    const prev = byProject.get(projectPath);
    if (!prev || heartbeat > prev.heartbeat) {
      byProject.set(projectPath, { unit, projectPath, heartbeat });
    }
  }

  if (byProject.size === 0) {
    return null;
  }

  return async (projectPath: string): Promise<ScopeLiveness | null> => {
    const rec = byProject.get(projectPath);
    if (!rec) {
      return null; // not scope-launched => pid path decides
    }
    return classifyScopeLiveness(rec.unit, systemctlIsActive);
  };
}
