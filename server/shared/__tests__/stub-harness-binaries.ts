/**
 * Side-effect import (T-1873): points every non-codex harness at an executable
 * stub in a fresh /var/tmp sandbox through its SERVER override env
 * (`CLAUDE_CLI_PATH`, `QWEN_PATH`, …). The harness registry resolves only real
 * installs (no PATH, no bare-name fallback), so a test whose launcher is mocked
 * must not depend on what the host — or a CI runner — has installed. A test
 * that sets its own override afterwards still wins. Import it FIRST.
 */

import fs from 'node:fs';
import path from 'node:path';

import { installFakeHarnessOverrides } from './harness-binary-fixtures.js';

/** Sandbox dir holding the stubs (removed at exit). */
export const HARNESS_STUB_DIR = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'nassaj-harness-stubs-'));

installFakeHarnessOverrides(HARNESS_STUB_DIR);
process.on('exit', () => fs.rmSync(HARNESS_STUB_DIR, { recursive: true, force: true }));
