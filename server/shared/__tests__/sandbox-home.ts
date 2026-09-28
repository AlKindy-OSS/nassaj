/**
 * Side-effect import (B-1349): import this FIRST in a test that lays out
 * harness installs under HOME. It points $HOME (and so os.homedir()) at a
 * fresh mkdtemp sandbox under /var/tmp BEFORE any later import evaluates, so
 * module-level home reads (e.g. descriptor npm prefixes) and fixtures never
 * touch the operator's real home — whether or not the isolated runner is used.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The sandbox HOME this test process runs under. */
export const SANDBOX_HOME = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'nassaj-test-home-'));

process.env.HOME = SANDBOX_HOME;
process.on('exit', () => fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }));
