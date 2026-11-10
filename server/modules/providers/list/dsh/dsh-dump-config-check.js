/**
 * dsh-dump-config-check — the semantic check of a DSH_PATH operator override (T-2091, ADR-225).
 * A managed install is trusted through its reviewed tree manifest; an override is an arbitrary
 * dsh, and dsh ignores unknown layer ids silently (measured), so a renamed security row would
 * lose its protection without an error. Once per (binary sha256, layer pin) the override's
 * composed profile (`--dump-config`, same argv and env as the launch) must carry every Nassaj
 * security row in its expected state; otherwise the launch is refused (dsh_override_unverified).
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

import { checkSecurityRowsSemantic, parseDumpConfig } from '../../../../services/permission-parity/dsh-contract-suite.js';

import { DSH_LAUNCH_ERROR, DSH_LAYER_SHA256, DshLaunchError } from './dsh-launch.js';

const verified = new Map();
const DUMP_TIMEOUT_MS = 30000;

/** sha256 of the dsh entry file (null when unreadable). */
function binaryDigest(script) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'); } catch { return null; }
}

/**
 * @param {{ command: string, args: string[], env: Record<string, string>, home: string, script: string }} launch
 * @param {NodeJS.ProcessEnv} serverEnv
 * @param {{ run?: typeof spawnSync }} [deps] test seam
 */
export function assertDshOverrideSemantics(launch, serverEnv, deps = {}) {
  if ((serverEnv.DSH_PATH ?? '').trim() === '') return;
  const digest = binaryDigest(launch.script);
  const key = `${digest}\u0000${DSH_LAYER_SHA256}`;
  if (digest && verified.get(key) === true) return;
  const argv = [...launch.args, '--dump-config'];
  const options = { cwd: launch.home, env: launch.env, encoding: 'utf8', timeout: DUMP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
    shell: false };
  // The one spawn of this module (reviewed in permission-launch-classifications.json); deps.run is a test seam.
  const run = deps.run ? deps.run(launch.command, argv, options) : spawnSync(launch.command, argv, options);
  const problems = run.status === 0 ? checkSecurityRowsSemantic(parseDumpConfig(run.stdout)) : [`dump-config exit ${run.status}`];
  if (problems.length) {
    console.warn('[dsh] DSH_PATH override refused: security rows not as Nassaj requires', { problems: problems.slice(0, 10) });
    throw new DshLaunchError(DSH_LAUNCH_ERROR.OVERRIDE_UNVERIFIED, 'The DSH_PATH override does not carry Nassaj\'s security settings.');
  }
  if (digest) verified.set(key, true);
}
