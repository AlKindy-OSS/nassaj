/**
 * Side-effect import (B-1349, B-1771): import this FIRST in any test that lays
 * out harness installs or provider credentials under HOME. Before any later
 * import evaluates it points $HOME (and so os.homedir()), USERPROFILE and
 * CLAUDE_CONFIG_DIR at a fresh mkdtemp sandbox under /var/tmp and drops every
 * inherited provider credential and credential-root variable, so module-level
 * home reads and fixtures never touch the operator's real home or live logins
 * — whether or not the isolated runner is used.
 */

import fs from 'node:fs';
import path from 'node:path';

import { isProviderCredentialEnvName } from '@/services/isolation/provider-credential-env.js';

/** The sandbox HOME this test process runs under. */
export const SANDBOX_HOME = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'nassaj-test-home-'));

for (const name of Object.keys(process.env)) {
  if (!name.startsWith('NASSAJ_TEST_') && isProviderCredentialEnvName(name)) delete process.env[name];
}
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.CLAUDE_CONFIG_DIR = path.join(SANDBOX_HOME, '.claude');
process.on('exit', () => fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }));
