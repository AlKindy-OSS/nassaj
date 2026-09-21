/**
 * The boundary guard for the operator-wide vendor slot (T-1260).
 *
 * WHY A TEST AND NOT A REVIEW NOTE. Renaming `SYSTEM_SCOPE` broke every one of
 * the eighteen unconverted call sites at once — that is what forced the reads
 * behind a single resolver instead of trusting a reviewer to spot them. But a
 * rename only bites once. Nothing stops the nineteenth site from importing
 * `getSharedVendorKey` directly and rebuilding the undeclared org-key fallback
 * that made the run path and the catalog path disagree (B-436 / T-1208), and
 * wave B's sharing DECLARATION is worth exactly as much as the narrowest door
 * into the store. So the door is asserted, continuously, by machine.
 *
 * WHY NOT ESLINT. `no-restricted-imports` with `importNames` is the natural home
 * for this, but eslint.config.js is protected by a repo hook (config-protection)
 * that refuses edits from an agent. This test is the same guarantee on the same
 * CI run; moving it into the lint config later is a pure upgrade.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The accessors that reach the operator-wide vendor slot without a resolver. */
const RESTRICTED = ['getSharedVendorKey', 'setSharedVendorKey', 'deleteSharedVendorKey'];

/**
 * Paths allowed to name them, relative to `server/`:
 *   • the store that defines them;
 *   • the ONE read door — the resolver that owns member-vs-shared precedence;
 *   • the ONE write door — the service that stores a vendor key, where wave B
 *     hangs the elevated-role check and the audit row.
 * Tests are allowed too: proving precedence requires arranging a shared key.
 */
const ALLOWED = new Set([
  'services/isolation/provider-secrets-store.js',
  'services/isolation/provider-slot-key.js',
  'modules/providers/services/provider-secrets.service.ts',
]);

const isTestFile = (relative: string): boolean =>
  /\.test\.(ts|js)$/.test(relative)
  || relative.split(path.sep).includes('__tests__')
  || relative.split(path.sep).includes('tests');

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|js)$/.test(entry.name)) {
      yield full;
    }
  }
}

test('T-1260: the shared vendor slot is reachable only through resolveSlotKey', () => {
  const offenders: string[] = [];

  for (const file of walk(SERVER_ROOT)) {
    const relative = path.relative(SERVER_ROOT, file);
    if (ALLOWED.has(relative.split(path.sep).join('/')) || isTestFile(relative)) continue;

    const source = fs.readFileSync(file, 'utf8');
    for (const name of RESTRICTED) {
      // Match the identifier in code, not the word inside prose: an import or a
      // call, both of which are followed by a delimiter a comment rarely uses.
      if (new RegExp(`\\b${name}\\s*[(,}]`).test(source)) {
        offenders.push(`${relative} → ${name}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'These files reach the operator-wide vendor slot directly. Use '
      + 'resolveSlotKey(userId, slot, { sharedFallback }) instead — whether a member '
      + "spends the org's key is one decision, made in one place (T-1260).",
  );
});
