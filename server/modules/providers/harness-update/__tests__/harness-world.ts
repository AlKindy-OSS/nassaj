/**
 * Test world for the T-1871 stage 3b flows: a fake HOME under /var/tmp with
 * harness installs laid out exactly like the measured host (codex standalone
 * with `current` + launcher links, single-file opencode/agy, claude versions),
 * member stores, a private spawn ledger and a stubbed updater. `--version` is
 * emulated by reading the fake binary's text; no real harness ever runs and no
 * real install or member data is touched.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AckTokenService } from '../confirmation.js';
import { parseVersionOutput } from '../descriptors.js';
import type { ReleaseAssetSpec } from '../opencode-asset.js';
import { hashFile } from '../snapshot/durable-fs.js';
import { makeFixtureRoot, writeFixtureFile } from '../snapshot/__tests__/fixtures.js';
import type { SnapshotRuntime } from '../snapshot-runtime.js';
import { SpawnLedger } from '../spawn-ledger.js';
import type { RunResult } from '../update-jobs.js';

/** A fake updater step: mutates the world, returns the child result. */
export type FakeUpdater = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => RunResult;

export interface World {
  root: string;
  home: string;
  snapshotRoot: string;
  ledger: SpawnLedger;
  audits: { action: string; metadata: Record<string, unknown> }[];
  commands: { cmd: string; args: string[]; env: NodeJS.ProcessEnv }[];
  versionChanges: { id: string; version: string }[];
  clock: { now: number };
  /** Replace to change what the "updater" does. */
  updater: FakeUpdater;
  /** Replace to lie about `--version` (post-restore identity tests). */
  versionOverride: ((binary: string) => string | null) | null;
  compatVerified: Set<string>;
  rt: Partial<SnapshotRuntime>;
}

export const ok = (over: Partial<RunResult> = {}): RunResult => ({
  code: 0, stdout: '', stderr: '', timedOut: false, quiesced: true, ...over,
});

/** `--version` emulation: the fake binary's text holds its version. */
function fakeVersion(world: World, binary: string): string | null {
  if (world.versionOverride) return world.versionOverride(binary);
  try {
    return fs.readFileSync(fs.realpathSync(binary), 'utf8');
  } catch {
    return null;
  }
}

/** Creates a private world (HOME 0700) with no installs yet. */
export function makeWorld(): World {
  const root = makeFixtureRoot('nassaj-t1871b-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  // T-1873: descriptors resolve through the harness registry, which reads the
  // OPERATOR home (os.homedir() ← $HOME) and never a per-call env. Point it at
  // this world so every measured install path lands inside the fixture.
  process.env.HOME = home;
  const data = path.join(home, '.local', 'share', 'nassaj');
  const clock = { now: 1_800_000_000_000 };
  const world: World = {
    root, home, snapshotRoot: path.join(data, 'harness-snapshots'),
    ledger: new SpawnLedger(path.join(data, 'harness-spawn-ledger.json'), () => clock.now),
    audits: [], commands: [], versionChanges: [], clock,
    updater: () => ok(), versionOverride: null, compatVerified: new Set(), rt: {},
  };
  const acks = new AckTokenService(randomBytes(32), () => clock.now);
  world.rt = {
    home, snapshotRoot: world.snapshotRoot, now: () => clock.now, ledger: world.ledger, acks: () => acks,
    runVersion: async (cmd) => fakeVersion(world, cmd),
    runCommand: async (cmd, args, opts) => {
      world.commands.push({ cmd, args, env: opts.env });
      return world.updater(cmd, args, opts.env);
    },
    cleanEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home }),
    hasLiveSession: () => false,
    hasUnregisteredLaunch: async () => false,
    assertNoHolders: () => {},
    audit: (action, metadata) => world.audits.push({ action, metadata }),
    pinArmed: () => false,
    latestVersion: async () => null,
    recordVersionChange: (id, version) => world.versionChanges.push({ id, version }),
    compatVerified: { get: (id) => world.compatVerified.has(id), set: (id) => world.compatVerified.add(id) },
    installCompatAsset: async () => { throw new Error('asset install not stubbed'); },
  };
  return world;
}

const CODEX_TRIPLES: Readonly<Record<string, string>> = {
  'linux:x64': 'x86_64-unknown-linux-musl', 'linux:arm64': 'aarch64-unknown-linux-musl',
};

/**
 * One codex release in the machine layout T-1872 validates (T-1873: the
 * registry resolves codex through it): an entry that starts with the ELF
 * magic (its text still carries `codex-cli <v>` for the fake `--version`), a
 * layoutVersion-1 manifest and the resources/path dirs.
 */
export function writeCodexMachineRelease(releaseDir: string, version: string, text = `codex-cli ${version}`): void {
  writeFixtureFile(path.join(releaseDir, 'bin', 'codex'), `\x7fELF ${text}`, 0o755);
  fs.mkdirSync(path.join(releaseDir, 'codex-resources'), { recursive: true });
  fs.mkdirSync(path.join(releaseDir, 'codex-path'), { recursive: true });
  const target = CODEX_TRIPLES[`${process.platform}:${process.arch}`] ?? 'x86_64-unknown-linux-musl';
  writeFixtureFile(path.join(releaseDir, 'codex-package.json'), JSON.stringify({
    layoutVersion: 1, version, target, variant: 'codex', entrypoint: 'bin/codex',
    resourcesDir: 'codex-resources', pathDir: 'codex-path',
  }), 0o644);
}

/** Codex standalone layout (measured): launcher → CODEX_HOME/packages/standalone/current/bin/codex. */
export function installCodex(world: World, version = '1.0.0', member = '1'): { codexHome: string; standalone: string } {
  const codexHome = path.join(world.home, '.nassaj-users', member, '.codex');
  const standalone = path.join(codexHome, 'packages', 'standalone');
  writeCodexMachineRelease(path.join(standalone, 'releases', version), version);
  fs.symlinkSync(path.join(standalone, 'releases', version), path.join(standalone, 'current'));
  fs.mkdirSync(path.join(world.home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(standalone, 'current', 'bin', 'codex'), path.join(world.home, '.local', 'bin', 'codex'));
  return { codexHome, standalone };
}

/** Emulates `codex update`: new release dir, `current` + launcher repointed. */
export function codexInstaller(world: World, version: string, exitCode = 0, onRun?: () => void): FakeUpdater {
  return (_cmd, _args, env) => {
    const standalone = path.join(env.CODEX_HOME as string, 'packages', 'standalone');
    writeCodexMachineRelease(path.join(standalone, 'releases', version), version);
    const current = path.join(standalone, 'current');
    fs.rmSync(current);
    fs.symlinkSync(path.join(standalone, 'releases', version), current);
    onRun?.();
    return ok({ code: exitCode });
  };
}

/** Single-file install (opencode / agy). */
export function installSingleFile(world: World, rel: string, text: string): string {
  const file = path.join(world.home, rel);
  writeFixtureFile(file, text, 0o755);
  return file;
}

/** Writes one SQLite-like store file (content only matters for hashing). */
export function writeStore(file: string, content: string): void {
  writeFixtureFile(file, content, 0o644);
}

/** A release asset spec whose pin is `content` (restore-compatible tests). */
export function fakeAsset(file: string, version: string): ReleaseAssetSpec {
  return {
    url: 'https://github.com/x/y.tar.gz', allowedHosts: ['github.com'], maxRedirects: 3, size: 1, capBytes: 2,
    tarballSha256: 'x', entryName: 'opencode', binarySha256: hashFile(file).sha256, version, maxUncompressedBytes: 2,
  };
}

/** Parsed fake `--version` of a live binary path. */
export function liveVersion(binary: string): string | null {
  return parseVersionOutput(fs.readFileSync(fs.realpathSync(binary), 'utf8'));
}
