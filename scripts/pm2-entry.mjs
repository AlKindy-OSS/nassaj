#!/usr/bin/env node
/**
 * Release-borne PM2 entry point (ADR-156, WI-9).
 *
 * PM2 loads a fork-mode script inside its own CommonJS container
 * (`lib/ProcessContainerFork.js`), so `process.argv[1]` is that container and
 * never this file. The launcher's own
 * `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)` guard
 * therefore does not fire when PM2 is pointed straight at
 * `nassaj-release-launcher.mjs`: PM2 reports the process online while nothing
 * ever binds a port and nothing is written to the log. A fleet node
 * works around this today with a hand-written wrapper outside the release; this
 * entry ships *with* the release, so a node receives the fix in the version it
 * installs instead of depending on a file nobody reviews.
 *
 * It runs unconditionally on load — unlike the launcher it has no other purpose
 * than being the process entry named by `script:` in an ecosystem file.
 *
 * مدخل pm2 مشحون مع الإصدار: pm2 يحمّل السكربت داخل حاويته فلا يصدق حارس
 * `argv[1]` في المشغّل، فيبقى الخادم خاملاً بلا منفذ ولا سجل. هذا المدخل يستدعي
 * `launchSealedRelease` مباشرةً ويُشحن مع الإصدار بدل غلاف يدوي على العقدة.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { launchSealedRelease, releaseFailureCode } from './nassaj-release-launcher.mjs';

const SUPPORTED_MODES = new Set([null, 'run']);

/**
 * The launcher this entry was reviewed against. Until the installer places both
 * files together (ADR-156, WI-16), the operator copies them by hand and can pair
 * an entry from one release with a launcher from another — a silent contract
 * with no owner. The pin turns that into a loud refusal at startup.
 *
 * Changing `nassaj-release-launcher.mjs` means updating this digest in the same
 * commit; `pm2-entry.test.mjs` fails until you do, which is the intended alarm.
 */
const EXPECTED_LAUNCHER_SHA256 = 'df9384a3427ce4208946b785e4663c2b6ab6574dd4200fc0fcee66678aaeb49d';
const LAUNCHER_FILE = fileURLToPath(new URL('./nassaj-release-launcher.mjs', import.meta.url));

/** Refuse to supervise a launcher this entry was never reviewed against. */
function assertLauncherIsPaired() {
  const actual = createHash('sha256').update(readFileSync(LAUNCHER_FILE)).digest('hex');
  if (actual !== EXPECTED_LAUNCHER_SHA256) {
    const error = new Error(`pm2 entry is paired with a different launcher: expected ${EXPECTED_LAUNCHER_SHA256}, found ${actual}`);
    error.failureCode = 'runtime_entry_launcher_mismatch';
    throw error;
  }
}

/**
 * The launcher's own CLI surface minus the read-only status modes, which a
 * supervised process must never be started with.
 */
function entryOptions(argv, env) {
  const value = (name) => argv[argv.indexOf(name) + 1];
  const mode = argv.includes('--mode') ? value('--mode') : null;
  if (!SUPPORTED_MODES.has(mode)) throw new Error('Unknown launcher mode.');
  return {
    deployRoot: argv.includes('--deploy-root') ? value('--deploy-root') : env.NASSAJ_DEPLOY_ROOT,
    mode,
    args: mode === null ? argv : [],
    port: argv.includes('--port') ? value('--port') : undefined,
  };
}

try {
  assertLauncherIsPaired();
  await launchSealedRelease(entryOptions(process.argv.slice(2), process.env));
} catch (error) {
  const failureCode = error?.failureCode ?? releaseFailureCode(error);
  if (failureCode === 'runtime_entry_launcher_mismatch') process.stderr.write(`${error.message}\n`);
  process.stderr.write(`${JSON.stringify({ failureCode })}\n`);
  process.exitCode = 1;
}
