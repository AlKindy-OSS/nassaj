/**
 * real-credential-guard — B-1771 fail-fast for test helpers that write or remove
 * credential files.
 *
 * On 2026-11-09 a test run with the operator's HOME replaced a member's live
 * Claude login with a fixture token. Every credential-writing test helper calls
 * assertOutsideRealCredentials(target) first: it throws when the target lies in
 * a credential tree of the REAL account, whose home comes from the passwd entry
 * (os.userInfo), so overriding or forgetting $HOME cannot fool it.
 * Dependency-free so it can be imported before anything resolves a home.
 */
import os from 'node:os';
import path from 'node:path';

/**
 * Credential trees under an account home: the member root (every provider row
 * of provider-credential-files.ts lives below it) and the operator-level
 * provider dotfiles, including the unmeasured ones (gemini, cursor, qwen, hermes).
 */
const CREDENTIAL_ROOTS_UNDER_HOME = Object.freeze([
  '.nassaj-users',
  '.claude',
  '.claude.json',
  '.codex',
  '.gemini',
  '.config/gcloud',
  '.cursor',
  '.qwen',
  '.kimi',
  '.kimi-code',
  '.hermes',
  '.local/share/opencode',
  '.config/opencode',
  '.nassaj-provider-secrets.key',
]);

/** Absolute credential roots of the real account (passwd home, not $HOME). */
export function realCredentialRoots(): string[] {
  const realHome = os.userInfo().homedir;
  return CREDENTIAL_ROOTS_UNDER_HOME.map((rel) => path.join(realHome, rel));
}

/** Throws when `target` is, or lies inside, a credential root of the real account. */
export function assertOutsideRealCredentials(target: string): void {
  const resolved = path.resolve(target);
  const hit = realCredentialRoots().find((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (hit) {
    throw new Error(`refusing to touch ${resolved}: it is inside the real account's credential tree ${hit}; `
      + "import '@/shared/__tests__/sandbox-home.js' first or run through scripts/run-isolated-node-tests.mjs");
  }
}
