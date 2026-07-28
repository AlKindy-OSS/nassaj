/**
 * vendor-single-launcher.guard.test.ts — SL-3 / M-2 (ADR-062).
 *
 * Two independent guards for the load-bearing compliance defense line:
 *
 *   (1) INJECTION test — seeds a hostile parent environment carrying the three
 *       worst leaks (`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
 *       `ANTHROPIC_API_KEY`) plus other-harness secrets, runs it through
 *       sanitizeVendorAgentEnv, and asserts they DISAPPEAR while the benign
 *       operational env (PATH/HOME/…) and the TARGET vendor key survive.
 *
 *   (2) SINGLE-LAUNCHER grep-gate — statically scans the server tree for any
 *       file that spawns a governed vendor CLI binary (kimi-code / opencode) and
 *       asserts every such launcher is a registered seam. A NEW, unregistered
 *       second launcher (a spawn that would bypass sanitizeVendorAgentEnv) FAILS
 *       the build, forcing its author to route through the sanitizer and register
 *       it. This is the "no second launcher bypasses the sanitizer" invariant.
 *
 * Pure: no DB, no network, no timers. Runner: node:test + node:assert/strict via
 *   tsx --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  sanitizeVendorAgentEnv,
  isDeniedVendorAgentEnvKey,
} from './sanitize-vendor-agent-env.js';

// ---------------------------------------------------------------------------
// (1) Injection sanitization
// ---------------------------------------------------------------------------

describe('sanitizeVendorAgentEnv — hostile env injection (M-2)', () => {
  /** A parent env seeded with the worst leaks + benign vars + the target key. */
  function hostileParentEnv(): Record<string, string> {
    return {
      // --- the three the plan names explicitly (must vanish) ---
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-claude-subscription-oauth-SECRET',
      ANTHROPIC_BASE_URL: 'https://api.competitor.example/v1',
      ANTHROPIC_API_KEY: 'sk-ant-SECRET',
      // --- rest of the Claude/Anthropic namespace ---
      ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-SECRET',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
      CLAUDE_CONFIG_DIR: '/home/op/.claude',
      CLAUDE_CODE_USE_BEDROCK: '1',
      // --- other-harness operator secrets ---
      OPENAI_API_KEY: 'sk-openai-SECRET',
      GEMINI_API_KEY: 'gemini-SECRET',
      CURSOR_API_KEY: 'cursor-SECRET',
      GH_TOKEN: 'gh-SECRET',
      GITHUB_TOKEN: 'github-SECRET',
      // --- intrusive base-URL redirect for the vendor itself ---
      OPENAI_BASE_URL: 'https://proxy.example',
      SOME_VENDOR_BASE_URL: 'https://redirect.example',
      // --- benign operational env (must survive) ---
      PATH: '/usr/bin:/bin',
      HOME: '/home/dev/.nassaj-users/9',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      NODE_OPTIONS: '--enable-source-maps',
      XDG_DATA_HOME: '/home/dev/.nassaj-users/9/.local/share',
      // --- the TARGET hosted-vendor key resolveProviderEnv injected (must survive) ---
      KIMI_API_KEY: 'kimi-target-key',
    };
  }

  it('strips CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY', () => {
    const parent = hostileParentEnv();
    const clean = sanitizeVendorAgentEnv(parent);

    assert.equal(clean.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'Claude OAuth token must vanish');
    assert.equal(clean.ANTHROPIC_BASE_URL, undefined, 'ANTHROPIC_BASE_URL must vanish');
    assert.equal(clean.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must vanish');
    // the keys must be GONE, not merely blanked
    assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in clean), 'key deleted, not emptied');
    assert.ok(!('ANTHROPIC_BASE_URL' in clean));
    assert.ok(!('ANTHROPIC_API_KEY' in clean));
  });

  it('strips the whole ANTHROPIC_/CLAUDE_ namespace and other-harness secrets', () => {
    const clean = sanitizeVendorAgentEnv(hostileParentEnv());
    for (const gone of [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_CODE_USE_BEDROCK',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'CURSOR_API_KEY',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ]) {
      assert.ok(!(gone in clean), `${gone} must be stripped`);
    }
  });

  it('strips any intrusive *_BASE_URL', () => {
    const clean = sanitizeVendorAgentEnv(hostileParentEnv());
    assert.ok(!('OPENAI_BASE_URL' in clean), 'OPENAI_BASE_URL must be stripped');
    assert.ok(!('SOME_VENDOR_BASE_URL' in clean), 'any *_BASE_URL must be stripped');
  });

  it('preserves benign operational env and the TARGET vendor key', () => {
    const clean = sanitizeVendorAgentEnv(hostileParentEnv());
    assert.equal(clean.PATH, '/usr/bin:/bin');
    assert.equal(clean.HOME, '/home/dev/.nassaj-users/9');
    assert.equal(clean.LANG, 'en_US.UTF-8');
    assert.equal(clean.TERM, 'xterm-256color');
    assert.equal(clean.NODE_OPTIONS, '--enable-source-maps');
    assert.equal(clean.XDG_DATA_HOME, '/home/dev/.nassaj-users/9/.local/share');
    // The explicit private key (first conjunct of the compliance model) survives.
    assert.equal(clean.KIMI_API_KEY, 'kimi-target-key');
  });

  it('is case-insensitive on the variable name (B-173 lesson)', () => {
    const clean = sanitizeVendorAgentEnv({
      anthropic_base_url: 'https://competitor.example',
      Anthropic_Api_Key: 'sk-ant-lower',
      claude_code_oauth_token: 'lower-oauth',
      PATH: '/bin',
    });
    assert.ok(!('anthropic_base_url' in clean), 'lowercase anthropic_base_url must be stripped');
    assert.ok(!('Anthropic_Api_Key' in clean), 'mixed-case must be stripped');
    assert.ok(!('claude_code_oauth_token' in clean), 'lowercase claude oauth must be stripped');
    assert.equal(clean.PATH, '/bin');
  });

  it('never mutates the input env object', () => {
    const parent = hostileParentEnv();
    const snapshot = { ...parent };
    const clean = sanitizeVendorAgentEnv(parent);
    assert.deepEqual(parent, snapshot, 'input env must be untouched (fresh copy returned)');
    assert.notEqual(clean, parent, 'a new object must be returned');
  });

  it('honors options.keep (allowlist override) and options.extraDeny (sibling keys)', () => {
    // keep: a caller preserves a var that would otherwise be denied.
    const kept = sanitizeVendorAgentEnv(
      { GH_TOKEN: 'x', PATH: '/bin' },
      { keep: ['GH_TOKEN'] },
    );
    assert.equal(kept.GH_TOKEN, 'x', 'options.keep must preserve the named var');

    // extraDeny: the single launcher strips the NON-target sibling vendor key.
    const stripped = sanitizeVendorAgentEnv(
      { KIMI_API_KEY: 'target', GLM_API_KEY: 'sibling', PATH: '/bin' },
      { extraDeny: ['GLM_API_KEY'] },
    );
    assert.equal(stripped.KIMI_API_KEY, 'target', 'target key preserved');
    assert.ok(!('GLM_API_KEY' in stripped), 'sibling vendor key stripped via extraDeny');
  });

  it('predicate isDeniedVendorAgentEnvKey matches the module policy', () => {
    assert.equal(isDeniedVendorAgentEnvKey('CLAUDE_CODE_OAUTH_TOKEN'), true);
    assert.equal(isDeniedVendorAgentEnvKey('ANTHROPIC_FOO'), true);
    assert.equal(isDeniedVendorAgentEnvKey('X_BASE_URL'), true);
    assert.equal(isDeniedVendorAgentEnvKey('KIMI_API_KEY'), false);
    assert.equal(isDeniedVendorAgentEnvKey('PATH'), false);
    assert.equal(isDeniedVendorAgentEnvKey(''), false);
  });
});

// ---------------------------------------------------------------------------
// (2) Single-launcher grep-gate
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..'); // isolation -> services -> server -> root
const SERVER_DIR = path.join(REPO_ROOT, 'server');

/**
 * A spawn primitive invocation: spawn / spawnSync / spawnFunction / crossSpawn /
 * execa / execFile / execFileSync, plus the `spawn.sync|.async` member forms.
 */
const SPAWN_PRIMITIVE =
  /\b(spawn|spawnSync|spawnFunction|crossSpawn|execa|execFile|execFileSync)\s*(\.\s*(sync|async))?\s*\(/;

/**
 * A reference to the canonical way to LOCATE/IMPORT a governed vendor CLI binary.
 * A legitimate launcher resolves the binary through these; hard-coding a path
 * would also defeat the SL-7 digest pin, so the resolver is the sanctioned seam.
 */
const VENDOR_BINARY_TOKEN =
  /\bresolveOpenCodeBinaryPath\b|\bresolveKimiBinaryPath\b|@moonshot-ai\/kimi-code/;

/**
 * Files that reference a vendor-binary resolver but are NOT agent launchers:
 * the resolver-definition / generic CLI-presence-prober home. Documented so a
 * reviewer knows exactly why each is exempt.
 */
const RESOLVER_HOME_ALLOWLIST = new Set<string>([
  // Defines resolveOpenCodeBinaryPath and the generic isCliInstalled() prober
  // (spawnSync of an arbitrary `command` with stdio:'ignore' — a presence check,
  // not a governed agent turn). Not a vendor-agent launch seam.
  'server/shared/utils.ts',
  // `spawn.sync(resolveOpenCodeBinaryPath(), ['--version'], { stdio:'ignore' })` —
  // a version/presence probe (no prompt, output discarded), not an agent turn.
  'server/modules/providers/list/opencode/opencode-auth.provider.ts',
]);

/**
 * Strips block and line comments so a resolver/package token or a `spawn(...)`
 * example that appears only in documentation (e.g. the SL-7 digest module's
 * JSDoc) is NOT mistaken for a real launch site. `[^:]` before `//` avoids
 * chopping `http://` inside a string literal.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Registry of the files permitted to spawn a governed vendor CLI binary. Every
 * discovered launcher MUST appear here. `sanitized:true` entries MUST route
 * through sanitizeVendorAgentEnv; `sanitized:false` entries are documented as
 * pending their wiring work item (the sanitize call lands in a later wave). When
 * that wave lands it flips to true — the assertion below then enforces the call.
 */
const VENDOR_AGENT_LAUNCHER_REGISTRY: ReadonlyArray<{
  file: string;
  sanitized: boolean;
  note: string;
}> = [
  {
    file: 'server/kimi-agent-cli.js',
    sanitized: true, // KM-1 (W3-A): sanitizeVendorAgentEnv is the LAST step before spawn.
    note: 'Kimi native agent launcher; ordered seam ends with sanitizeVendorAgentEnv (SL-3).',
  },
  {
    file: 'server/opencode-cli.js',
    // sanitized:true — carrier mode (carrier=true) calls sanitizeVendorAgentEnv as its
    // LAST step before spawn (GL-4, W3-B). The sanitize call is CONDITIONAL on carrier
    // mode: legacy opencode (anthropic DEFAULT_TARGET) never runs sanitize so its env
    // (including ANTHROPIC_* for the built-in provider) is byte-for-byte unchanged.
    sanitized: true,
    note: 'OpenCode carrier agent-turn launcher; sanitize wired by GL-4 (carrier=true only).',
  },
  {
    file: 'server/modules/providers/list/opencode/opencode-models.provider.ts',
    sanitized: false, // GL-6/GL-9: opencode `models` enumeration spawn
    note: 'Spawns `opencode models` for catalog enumeration; wired by GL-6/GL-9.',
  },
];

/** Recursively collect .js/.ts source files under a dir, excluding tests/deps. */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...collectSources(full));
      continue;
    }
    if (!/\.(js|ts)$/.test(entry.name)) continue;
    if (/\.test\.(js|ts)$/.test(entry.name)) continue;
    out.push(full);
  }
  return out;
}

describe('single-launcher grep-gate — no second launcher bypasses the sanitizer (SL-3)', () => {
  it('every governed vendor-CLI spawn site is a registered (or exempt) launcher', () => {
    const sources = collectSources(SERVER_DIR);
    const registered = new Set(VENDOR_AGENT_LAUNCHER_REGISTRY.map((r) => r.file));

    const discovered: string[] = [];
    for (const file of sources) {
      const rel = path.relative(REPO_ROOT, file);
      // Never flag the sanitizer module itself.
      if (rel === 'server/services/isolation/sanitize-vendor-agent-env.js') continue;
      const text = stripComments(fs.readFileSync(file, 'utf8'));
      if (SPAWN_PRIMITIVE.test(text) && VENDOR_BINARY_TOKEN.test(text)) {
        discovered.push(rel);
      }
    }

    // Every discovered launcher must be either an exempt resolver-home or registered.
    const unregistered = discovered.filter(
      (rel) => !RESOLVER_HOME_ALLOWLIST.has(rel) && !registered.has(rel),
    );
    assert.deepEqual(
      unregistered,
      [],
      `Unregistered vendor-CLI launcher(s) found — every spawn of a governed vendor ` +
        `binary must route through sanitizeVendorAgentEnv and be registered in ` +
        `VENDOR_AGENT_LAUNCHER_REGISTRY: ${JSON.stringify(unregistered)}`,
    );

    // Registry hygiene: no stale entries, and each launcher is actually discovered.
    for (const { file } of VENDOR_AGENT_LAUNCHER_REGISTRY) {
      assert.ok(
        fs.existsSync(path.join(REPO_ROOT, file)),
        `registry entry ${file} does not exist on disk (stale registry)`,
      );
      assert.ok(
        discovered.includes(file),
        `registry entry ${file} no longer matches a spawn site (update the registry)`,
      );
    }
  });

  it('every launcher marked sanitized:true routes through sanitizeVendorAgentEnv', () => {
    for (const { file, sanitized } of VENDOR_AGENT_LAUNCHER_REGISTRY) {
      if (!sanitized) continue;
      const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      assert.ok(
        /sanitizeVendorAgentEnv/.test(text),
        `${file} is registered sanitized:true but does not call sanitizeVendorAgentEnv`,
      );
    }
  });
});
