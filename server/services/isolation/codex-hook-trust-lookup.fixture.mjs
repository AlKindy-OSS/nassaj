/**
 * Runs one hook-trust lookup with the production code, for the sealed-namespace
 * proofs (T-2107 qa backlog, B-1790): argv[2] is a JSON spec
 *   { codexBin, codexHome, cwd, mode: 'read'|'ensure' }
 * `read` prints the entries readCodexHookTrust returns; `ensure` applies
 * ensureCodexHomeHookTrust to the home and prints the entries it trusted.
 */

import { ensureCodexHomeHookTrust, readCodexHookTrust } from './codex-hook-trust.js';

const spec = JSON.parse(process.argv[2]);
const input = { codexBin: spec.codexBin, codexHome: spec.codexHome, cwd: spec.cwd };
const entries = spec.mode === 'ensure' ? await ensureCodexHomeHookTrust(input) : await readCodexHookTrust(input);
process.stdout.write(`${JSON.stringify({ entries })}\n`);
