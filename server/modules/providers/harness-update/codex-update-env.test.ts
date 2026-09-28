/**
 * T-1871 qa condition 7 — `codex update` runs with CODEX_HOME / CODEX_INSTALL_DIR
 * derived from the launcher, and a full update (snapshot, store backup, the
 * updater child, verify) leaves member 1's auth and config byte-identical.
 *
 * The launcher is a machine-layout release (T-1873: the registry codex is
 * T-1872's validated release). The installer half of `codex update` is a /bin/sh
 * script on a /var/tmp fixture that mimics install.sh (new releases/<v>,
 * `current` and launcher repointed via the two env vars); it is spawned
 * through the REAL bounded runner, so the env assertion is on the actual child.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { initializeDatabase } from '@/modules/database/index.js';

import { runHarnessUpdateCommand } from './run-command.js';
import { hashFile } from './snapshot/durable-fs.js';
import { removeFixture, writeFixtureFile } from './snapshot/__tests__/fixtures.js';
import { _setSnapshotRuntimeOverrides } from './snapshot-runtime.js';
import { clearHarnessRecoveryBlocked } from './spawn-admission.js';
import { _setSharedSpawnLedger } from './spawn-ledger.js';
import { _awaitHarnessJob, getHarnessUpdateJob, startHarnessUpdate } from './update.service.js';
import { makeWorld, writeCodexMachineRelease, writeStore, type World } from './__tests__/harness-world.js';

let w: World;

before(async () => {
  await initializeDatabase();
  clearHarnessRecoveryBlocked('codex');
  w = makeWorld();
});

after(() => {
  _setSnapshotRuntimeOverrides(null);
  _setSharedSpawnLedger(null);
  removeFixture(w.root);
});

/**
 * The installer half of `codex update`, as a /bin/sh script: it installs `next`
 * like install.sh — a machine-layout release (T-1872: ELF-magic entry +
 * layoutVersion-1 manifest, so the registry accepts it), then repoints
 * `current` and the launcher through the two env vars under test.
 */
function updaterScript(next: string, envLog: string, targetFile: string): string {
  return `#!/bin/sh
[ "$1" = "update" ] || exit 2
printf 'CODEX_HOME=%s\\nCODEX_INSTALL_DIR=%s\\n' "$CODEX_HOME" "$CODEX_INSTALL_DIR" > '${envLog}'
ROOT="$CODEX_HOME/packages/standalone"
REL="$ROOT/releases/${next}"
mkdir -p "$REL/bin" "$REL/codex-resources" "$REL/codex-path"
printf '\\177ELF codex-cli ${next}' > "$REL/bin/codex"
chmod 755 "$REL/bin/codex"
printf '{"layoutVersion":1,"version":"${next}","target":"%s","variant":"codex","entrypoint":"bin/codex","resourcesDir":"codex-resources","pathDir":"codex-path"}' "$(cat '${targetFile}')" > "$REL/codex-package.json"
ln -sfn "$REL" "$ROOT/current.tmp" && mv -T "$ROOT/current.tmp" "$ROOT/current"
ln -sfn "$ROOT/current/bin/codex" "$CODEX_INSTALL_DIR/codex"
exit 0
`;
}

/** Fake `--version`: the fixture entry's text carries `codex-cli <v>`. */
async function readFixtureVersion(cmd: string): Promise<string | null> {
  try {
    return fs.readFileSync(fs.realpathSync(cmd), 'utf8').match(/codex-cli \S+/u)?.[0] ?? null;
  } catch {
    return null;
  }
}

test('codex update env targets the launcher install and never changes member-1 auth/config', async () => {
  const codexHome = path.join(w.home, '.nassaj-users', '1', '.codex');
  const standalone = path.join(codexHome, 'packages', 'standalone');
  const envLog = path.join(w.root, 'updater-env.log');
  writeCodexMachineRelease(path.join(standalone, 'releases', '0.156.0'), '0.156.0');
  const manifest = JSON.parse(fs.readFileSync(path.join(standalone, 'releases', '0.156.0', 'codex-package.json'), 'utf8'));
  const targetFile = path.join(w.root, 'target.txt');
  fs.writeFileSync(targetFile, manifest.target);
  const updater = path.join(w.root, 'codex-updater.sh');
  writeFixtureFile(updater, updaterScript('0.157.1', envLog, targetFile), 0o755);
  fs.symlinkSync(path.join(standalone, 'releases', '0.156.0'), path.join(standalone, 'current'));
  const binDir = path.join(w.home, '.local', 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(path.join(standalone, 'current', 'bin', 'codex'), path.join(binDir, 'codex'));
  const auth = path.join(codexHome, 'auth.json');
  const config = path.join(codexHome, 'config.toml');
  writeFixtureFile(auth, '{"tokens":{"access_token":"not-a-secret"}}', 0o600);
  writeFixtureFile(config, 'model = "gpt-5"\n', 0o600);
  writeStore(path.join(codexHome, 'state_5.sqlite'), 'db');
  const before = [hashFile(auth).sha256, hashFile(config).sha256];

  const launcher = path.join(binDir, 'codex');
  const updaterCmds: string[] = [];
  _setSnapshotRuntimeOverrides({
    ...w.rt,
    // The descriptor's argv targets the registry launcher; the installer half
    // runs as a real child through the bounded runner (env asserted below).
    runCommand: (cmd, args, opts) => {
      updaterCmds.push(cmd);
      return runHarnessUpdateCommand(updater, args, opts);
    },
    runVersion: readFixtureVersion,
  });
  _setSharedSpawnLedger(w.ledger);
  const job = await startHarnessUpdate('codex', { userId: 1 });
  await _awaitHarnessJob(job.jobId);

  const final = getHarnessUpdateJob(job.jobId)!;
  assert.equal(final.status, 'succeeded', JSON.stringify(final.error));
  assert.equal(final.toVersion, '0.157.1');
  assert.deepEqual(updaterCmds, [launcher], 'the update targets the registry codex launcher');
  assert.equal(fs.readFileSync(envLog, 'utf8'), `CODEX_HOME=${codexHome}\nCODEX_INSTALL_DIR=${binDir}\n`);
  assert.deepEqual([hashFile(auth).sha256, hashFile(config).sha256], before, 'member-1 auth/config unchanged');
  assert.equal(fs.statSync(auth).mode & 0o777, 0o600, 'modes untouched');
  assert.equal(fs.existsSync(path.join(w.home, '.codex', 'packages')), false, 'host ~/.codex never became an install');
});
