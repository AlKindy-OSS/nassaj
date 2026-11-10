// B-1771 acceptance: server tests that once wrote, replaced or deleted credentials
// under the operator's HOME (proven: launch-route replaced then removed user 1's
// live Claude login on 2026-11-09) must isolate THEMSELVES. Each is run ad hoc,
// outside run-isolated-node-tests.mjs, with a decoy operator HOME holding a
// linked credential; the decoy tree must come back byte- and mtime-identical.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const FORMERLY_UNSAFE = [
  'server/modules/workflow-supervisor/__tests__/launch-route.test.ts',
  'server/claude-sdk.coordinator-hook-gate.test.ts',
  'server/claude-sdk.peer-relay.test.ts',
  'server/modules/connectors/connector-oauth-flow.test.ts',
  'server/modules/providers/list/antigravity/__tests__/agy-progress.test.ts',
  'server/modules/providers/list/catalog-isolation.test.ts',
  'server/modules/providers/tests/mcp.test.ts',
  // Found by the 2026-11-10 ad-hoc decoy audit of every server test file.
  'server/modules/providers/list/claude/__tests__/agent-reconcile.normalize.integration.test.ts',
  'server/modules/providers/list/claude/__tests__/claude-progress.test.ts',
  'server/modules/providers/list/claude/__tests__/claude-subagent-outcomes.test.ts',
  'server/modules/providers/list/claude/__tests__/claude-subagent-transcript-path.test.ts',
  'server/modules/providers/list/claude/claude-receipt-reader.integration.test.ts',
  'server/modules/providers/list/claude/claude-steer-history.integration.test.ts',
  'server/modules/providers/list/codex/codex-credentials.writer.identity.test.ts',
  'server/modules/providers/list/codex/codex-credentials.writer.test.ts',
  'server/modules/providers/list/opencode/opencode-own-tree-write.test.ts',
  'server/modules/providers/services/__tests__/workflow-status.service.test.ts',
  'server/modules/providers/services/session-conversations-search.display-mask.integration.test.ts',
  'server/modules/providers/services/session-conversations-search.display-text.integration.test.ts',
  'server/modules/providers/services/session-conversations-search.service.ownership.integration.test.ts',
  'server/modules/providers/tests/codex-credential-principal.integration.test.ts',
  'server/modules/workflow-supervisor/__tests__/scope-precedence.test.ts',
  'server/services/isolation/resolve-claude-run-profile.test.ts',
];

const tempParent = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'decoy-home-'));
test.after(() => fs.rmSync(tempParent, { recursive: true, force: true }));

/** Every path under `root` with its mtime and size, as a sorted listing. */
function listing(root) {
  const rows = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const stat = fs.lstatSync(full);
      rows.push(`${path.relative(root, full)} ${stat.mtimeMs} ${stat.size}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return rows.sort();
}

for (const file of FORMERLY_UNSAFE) {
  test(`ad-hoc run leaves the operator HOME untouched: ${file}`, () => {
    const caseRoot = fs.mkdtempSync(path.join(tempParent, 'case-'));
    const home = path.join(caseRoot, 'home');
    const configDir = path.join(home, '.nassaj-users', '1', '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(path.join(caseRoot, 'tmp'));
    fs.writeFileSync(path.join(configDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'decoy', refreshToken: 'decoy', scopes: ['profile'] } }));
    const before = listing(home);
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir, TMPDIR: path.join(caseRoot, 'tmp'),
      DATABASE_PATH: path.join(caseRoot, 'ad-hoc.db'), TSX_TSCONFIG_PATH: path.resolve('server/tsconfig.json') };
    delete env.NODE_TEST_CONTEXT;
    spawnSync(process.execPath, ['--import', 'tsx', '--experimental-test-module-mocks', '--test-force-exit', '--test', file],
      { env, encoding: 'utf8', timeout: 300_000 });
    assert.deepEqual(listing(home), before);
  });
}

// B-1771 acceptance A: even a test that forgets the sandbox cannot write a member
// credential when HOME is the real account home. NASSAJ_TEST_REAL_HOME stands in
// for the passwd home so the real one is never involved.
test('ad-hoc run with the real HOME: the member-tree seam refuses the write', () => {
  const caseRoot = fs.mkdtempSync(path.join(tempParent, 'guard-'));
  const home = path.join(caseRoot, 'home');
  const configDir = path.join(home, '.nassaj-users', '1', '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(caseRoot, 'tmp'));
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"decoy","refreshToken":"decoy"}}');
  const before = listing(home);
  const env = { ...process.env, HOME: home, NASSAJ_TEST_REAL_HOME: home, TMPDIR: path.join(caseRoot, 'tmp'),
    DATABASE_PATH: path.join(caseRoot, 'ad-hoc.db'), TSX_TSCONFIG_PATH: path.resolve('server/tsconfig.json') };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', 'scripts/fixtures/real-home-credential-writer.fixture.mjs'],
    { env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(result.status, 0, 'the careless write must fail');
  assert.match(result.stdout + result.stderr, /B-1771/u);
  assert.deepEqual(listing(home), before);
});

// qa B-1771 r1: the same careless test run as a plain script (`node x.test.mjs`,
// no --test flag and no NODE_TEST_CONTEXT) must be refused too.
test('direct run of a careless *.test.mjs with the real HOME: refused', () => {
  const caseRoot = fs.mkdtempSync(path.join(tempParent, 'direct-'));
  const home = path.join(caseRoot, 'home');
  const configDir = path.join(home, '.nassaj-users', '1', '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(caseRoot, 'tmp'));
  fs.writeFileSync(path.join(configDir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"decoy","refreshToken":"decoy"}}');
  const seam = pathToFileURL(path.resolve('server/services/isolation/provision-user-dirs.js')).href;
  const careless = path.join(caseRoot, 'careless.test.mjs');
  fs.writeFileSync(careless, fs.readFileSync('scripts/fixtures/real-home-credential-writer.fixture.mjs', 'utf8')
    .replace('../../server/services/isolation/provision-user-dirs.js', seam));
  const before = listing(home);
  const env = { ...process.env, HOME: home, NASSAJ_TEST_REAL_HOME: home, TMPDIR: path.join(caseRoot, 'tmp'),
    DATABASE_PATH: path.join(caseRoot, 'ad-hoc.db'), TSX_TSCONFIG_PATH: path.resolve('server/tsconfig.json') };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', 'tsx', careless], { env, encoding: 'utf8', timeout: 120_000 });
  assert.notEqual(result.status, 0, 'the careless write must fail');
  assert.match(result.stdout + result.stderr, /B-1771/u);
  assert.deepEqual(listing(home), before);
});
