/**
 * B-524: the whole point of this module is that a connector credential never
 * reaches argv. Two things therefore have to hold for real, not by inspection:
 * the file the secret moves into is 0600 AT CREATION, and it does not survive
 * the run. Everything else here guards the ways the fix could quietly become a
 * no-op — an `sdk` entry serialised by mistake, an empty set that still writes a
 * file, a sweep that eats a live run's file.
 *
 * B-530: and 0600 is worth nothing if every member's file sits in ONE directory
 * under a shared uid. The first suite below is the one that matters for that:
 * it feeds an env with NO `XDG_DATA_HOME` — which is exactly what the live
 * server process has, and what the `claude` case of resolveProviderEnv
 * produces — because the original suite injected that variable by hand in all
 * eight of its cases and so never once exercised production's shape.
 *
 * Runner:
 *   d=$(mktemp -d); DATABASE_PATH="$d/auth.db" npx tsx \
 *     --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/services/mcp-config-file.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { CAGE_SECRET_HIDE_DIRS, cageSecretHidePaths } from './isolation/provider-cage-wiring.js';
import { userConfigDir } from './isolation/provision-user-dirs.js';
import {
  MCP_CONFIG_DIR_NAME,
  STALE_FILE_MS,
  mcpConfigDir,
  splitSdkMcpServers,
  sweepStaleMcpConfigFiles,
  writeMcpConfigFile,
} from './mcp-config-file.js';

const roots: string[] = [];

/** A throwaway home, so no test ever writes into the operator's real one. */
function fakeHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-mcpcfg-'));
  roots.push(root);
  return root;
}

/**
 * A member's location with NO XDG_DATA_HOME anywhere in it — production's shape.
 * Every write test now runs through this, so a regression to an env-derived
 * directory fails the whole suite, not one case.
 */
function memberAt(userId: string | number = 7): { userId: string | number; env: NodeJS.ProcessEnv; homedir: () => string } {
  const home = fakeHome();
  return { userId, env: {}, homedir: () => home };
}

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const SECRET = 'mail-token-do-not-leak-1234567890';
const CONNECTOR = {
  mail: { type: 'stdio', command: 'node', args: ['server.js'], env: { MAIL_TOKEN: SECRET } },
};

describe('mcpConfigDir isolates per member (B-530)', () => {
  it('gives two members two directories on an env with NO XDG_DATA_HOME', () => {
    // The production shape, verified on the live server process 2026-08-07:
    // the claude case of resolveProviderEnv sets CLAUDE_CONFIG_DIR and nothing
    // else, so there is no XDG_DATA_HOME to hang anything off.
    const homedir = () => '/home/op';
    const env: NodeJS.ProcessEnv = { HOME: '/home/op', CLAUDE_CONFIG_DIR: '/home/op/.nassaj-users/7/.claude' };
    const a = mcpConfigDir({ userId: 7, env, homedir });
    const b = mcpConfigDir({ userId: 9, env, homedir });

    assert.notEqual(a, b, 'two members must never share one connector-secret directory');
    assert.ok(
      !a.startsWith(path.join('/home/op', '.local', 'share') + path.sep),
      `member secrets must not land in the operator data home — got ${a}`,
    );
    assert.equal(a, path.join('/home/op', '.nassaj-users', '7', '.local', 'share', MCP_CONFIG_DIR_NAME));
  });

  it('lands inside the member tree the cage re-binds, and nowhere else', () => {
    const homedir = () => '/home/op';
    const dir = mcpConfigDir({ userId: 7, env: {}, homedir });
    // buildCagedLaunch does `--tmpfs <usersRoot>` then `--bind <usersRoot>/<id>`:
    // a strict descendant of the member's own dir is hidden from every other
    // member by construction.
    assert.ok(dir.startsWith(path.join('/home/op', '.nassaj-users', '7') + path.sep));
  });

  it('matches provision-user-dirs, so the mirrored root cannot drift', () => {
    assert.equal(
      mcpConfigDir({ userId: 7, env: {} }),
      path.join(userConfigDir(7, path.join('.local', 'share')), MCP_CONFIG_DIR_NAME),
    );
  });

  it('ignores a stray XDG_DATA_HOME rather than following it out of the member tree', () => {
    const dir = mcpConfigDir({ userId: 7, env: { XDG_DATA_HOME: '/somewhere/shared' }, homedir: () => '/home/op' });
    assert.ok(!dir.startsWith('/somewhere/shared'));
  });

  it('roots the member tree on the SERVER home, not a spawn HOME override', () => {
    // agy / hermes / cursor set HOME to the member tree itself. Re-rooting on it
    // would nest .nassaj-users inside .nassaj-users.
    const dir = mcpConfigDir({
      userId: 7,
      env: { HOME: '/home/op/.nassaj-users/7' },
      homedir: () => '/home/op',
    });
    assert.equal(dir.split('.nassaj-users').length - 1, 1);
  });

  it('refuses an omitted userId instead of silently sharing a directory', () => {
    // The pre-B-530 signature took the env positionally. An un-migrated caller
    // must fail loudly, not land back in the operator data home.
    assert.throws(() => (mcpConfigDir as unknown as (e: unknown) => string)({ XDG_DATA_HOME: '/x' }), /userId/);
    assert.throws(() => (writeMcpConfigFile as unknown as (a: unknown, b: unknown) => unknown)(CONNECTOR, { XDG_DATA_HOME: '/x' }), /userId/);
  });

  it('refuses a userId that is not a plain path component', () => {
    assert.throws(() => mcpConfigDir({ userId: '../../etc', env: {} }), /path component/);
  });
});

describe('mcpConfigDir (unauthenticated fallback)', () => {
  it('follows the spawn HOME, not os.homedir, for a HOME-overridden provider', () => {
    // agy / hermes / cursor run with HOME pointed elsewhere; writing their file
    // under the operator home would put it outside the home they can read.
    assert.equal(
      mcpConfigDir({ userId: null, env: { HOME: '/home/op/.nassaj-users/7' }, homedir: () => '/home/op' }),
      path.join('/home/op/.nassaj-users/7', '.local', 'share', MCP_CONFIG_DIR_NAME),
    );
  });

  it('never lands in /tmp (a tmpfs on this host: a leak there is leaked RAM)', () => {
    const dir = mcpConfigDir({ userId: null, env: {} });
    assert.ok(!dir.startsWith(os.tmpdir() + path.sep));
    assert.ok(!dir.startsWith('/tmp/'));
  });

  it('is not under nassaj-dev, the one data-home path the provider cage blanks', () => {
    assert.ok(!mcpConfigDir({ userId: null, env: {} }).includes(`${path.sep}nassaj-dev${path.sep}`));
  });
});

/**
 * B-531 — the class guard: this module creates a NEW on-disk secret surface,
 * and the provider cage is a DENYLIST (`--ro-bind / /`, so anything not named
 * explicitly stays readable by every caged provider child under the shared uid
 * `nassaj`). The coupling is asserted from THIS side, not from the cage's, for
 * two reasons: the lint boundaries forbid the isolation element from importing
 * this service, and the obligation belongs to whoever invents the secret. Ask
 * the module where its files go, then demand the cage covers it — a rename or a
 * move here fails these tests instead of silently falling out of the denylist.
 */
describe('the provider cage covers this module\'s secret directory (B-531)', () => {
  const HOME = '/home/op';
  const noCdxrt = { readdirSync: (() => []) as unknown as (p: string) => string[] };

  it('hides the operator-level directory an unauthenticated run writes to', () => {
    const anonDir = mcpConfigDir({ userId: null, env: {}, homedir: () => HOME });
    const hidden = cageSecretHidePaths({ homedir: () => HOME, existsSync: () => true, ...noCdxrt });
    assert.ok(
      hidden.includes(anonDir),
      `connector secrets live in ${anonDir}; anything the cage does not hide explicitly stays `
        + `readable inside it. CAGE_SECRET_HIDE_DIRS = ${JSON.stringify(CAGE_SECRET_HIDE_DIRS)}`,
    );
  });

  it("keeps a member's files inside the tree the usersRoot tmpfs already hides", () => {
    // buildCagedLaunch emits `--tmpfs <usersRoot>` then `--bind <usersRoot>/<id>`,
    // so a strict descendant of member 7's own dir is invisible to member 9
    // without needing a denylist entry at all.
    const dir = mcpConfigDir({ userId: 7, env: {}, homedir: () => HOME });
    assert.ok(dir.startsWith(path.join(HOME, '.nassaj-users', '7') + path.sep));
  });
});

describe('splitSdkMcpServers', () => {
  it('keeps in-process sdk servers off the file and external ones on it', () => {
    const { inProcess, external } = splitSdkMcpServers({
      'vendor-delegate': { type: 'sdk', instance: {} },
      ...CONNECTOR,
    });
    assert.deepEqual(Object.keys(inProcess), ['vendor-delegate']);
    assert.deepEqual(Object.keys(external), ['mail']);
  });

  it('treats an entry with no type as external (a bare stdio launcher still leaks)', () => {
    const { external } = splitSdkMcpServers({ x: { command: 'node' } });
    assert.deepEqual(Object.keys(external), ['x']);
  });

  it('survives null/undefined without inventing entries', () => {
    assert.deepEqual(splitSdkMcpServers(null), { inProcess: {}, external: {} });
    assert.deepEqual(splitSdkMcpServers(undefined).external, {});
  });
});

describe('writeMcpConfigFile', () => {
  it('creates the file with mode 0600 — measured, not assumed', () => {
    const handle = writeMcpConfigFile(CONNECTOR, memberAt());
    assert.ok(handle);
    assert.equal(fs.statSync(handle!.path).mode & 0o777, 0o600);
  });

  it('creates the directory 0700 so a stray file inside stays unreachable', () => {
    const loc = memberAt();
    writeMcpConfigFile(CONNECTOR, loc);
    assert.equal(fs.statSync(mcpConfigDir(loc)).mode & 0o777, 0o700);
  });

  it('writes into the member tree, not the operator data home (B-530)', () => {
    const loc = memberAt(7);
    const handle = writeMcpConfigFile(CONNECTOR, loc)!;
    const home = loc.homedir();
    assert.ok(handle.path.startsWith(path.join(home, '.nassaj-users', '7') + path.sep));
    assert.equal(fs.existsSync(path.join(home, '.local', 'share', MCP_CONFIG_DIR_NAME)), false);
  });

  it('writes the payload the CLI expects, secret included', () => {
    const handle = writeMcpConfigFile(CONNECTOR, memberAt())!;
    const parsed = JSON.parse(fs.readFileSync(handle.path, 'utf8'));
    assert.equal(parsed.mcpServers.mail.env.MAIL_TOKEN, SECRET);
  });

  it('returns null for an empty set so the no-connector path is untouched', () => {
    assert.equal(writeMcpConfigFile({}, memberAt()), null);
  });

  it('gives every run its own file', () => {
    const loc = memberAt();
    const a = writeMcpConfigFile(CONNECTOR, loc)!;
    const b = writeMcpConfigFile(CONNECTOR, loc)!;
    assert.notEqual(a.path, b.path);
  });

  it('dispose removes the file, and twice is not an error', () => {
    const handle = writeMcpConfigFile(CONNECTOR, memberAt())!;
    handle.dispose();
    assert.equal(fs.existsSync(handle.path), false);
    handle.dispose();
  });

  it('dispose stays silent when the file already vanished', () => {
    const handle = writeMcpConfigFile(CONNECTOR, memberAt())!;
    fs.unlinkSync(handle.path);
    handle.dispose();
  });

  it('leaves no file behind when serialisation fails (B-532)', () => {
    // openSync('wx') creates the file before the write; a throw from the write
    // (here, a circular value JSON.stringify cannot serialise) used to leave a
    // 0600 secret file that only a much-later sweep could remove. The caller's
    // finally never gets a handle to dispose on this path, so the module itself
    // must clean up.
    const loc = memberAt();
    const circular: Record<string, unknown> = {
      type: 'stdio',
      command: 'node',
      env: { MAIL_TOKEN: SECRET },
    };
    circular.self = circular;
    assert.throws(() => writeMcpConfigFile({ mail: circular }, loc));
    const dir = mcpConfigDir(loc);
    const leftovers = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((n) => n.startsWith('mcp-') && n.endsWith('.json'))
      : [];
    assert.deepEqual(leftovers, [], `a failed write must leave no secret file behind, found ${JSON.stringify(leftovers)}`);
  });
});

describe('sweepStaleMcpConfigFiles', () => {
  it('removes a leftover from a killed run', () => {
    const loc = memberAt();
    const stale = writeMcpConfigFile(CONNECTOR, loc)!;
    const old = Date.now() - STALE_FILE_MS - 60_000;
    fs.utimesSync(stale.path, old / 1000, old / 1000);
    assert.equal(sweepStaleMcpConfigFiles(mcpConfigDir(loc)), 1);
    assert.equal(fs.existsSync(stale.path), false);
  });

  it('leaves a live run file alone', () => {
    const loc = memberAt();
    const live = writeMcpConfigFile(CONNECTOR, loc)!;
    assert.equal(sweepStaleMcpConfigFiles(mcpConfigDir(loc)), 0);
    assert.equal(fs.existsSync(live.path), true);
  });

  it('runs on write, so files do not accumulate forever', () => {
    const loc = memberAt();
    const stale = writeMcpConfigFile(CONNECTOR, loc)!;
    const old = Date.now() - STALE_FILE_MS - 60_000;
    fs.utimesSync(stale.path, old / 1000, old / 1000);
    writeMcpConfigFile(CONNECTOR, loc);
    assert.equal(fs.existsSync(stale.path), false);
  });

  it('ignores foreign files in the directory', () => {
    const loc = memberAt();
    writeMcpConfigFile(CONNECTOR, loc);
    const foreign = path.join(mcpConfigDir(loc), 'notes.txt');
    fs.writeFileSync(foreign, 'x');
    const old = Date.now() - STALE_FILE_MS - 60_000;
    fs.utimesSync(foreign, old / 1000, old / 1000);
    assert.equal(sweepStaleMcpConfigFiles(mcpConfigDir(loc)), 0);
    assert.equal(fs.existsSync(foreign), true);
  });

  it('is inert on a directory that does not exist', () => {
    assert.equal(sweepStaleMcpConfigFiles(path.join(os.tmpdir(), 'nassaj-absent-dir')), 0);
  });
});
