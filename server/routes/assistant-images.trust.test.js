/**
 * assistant-images directory-trust tests: the private-group rule that
 * lets umask-002 hosts (group-writable `775` dirs) serve overlay and scratchpad
 * images without trusting any other account. Pure parsers, the fstat-pinned
 * identity loader against real temp files, and the router over real HTTP with
 * temp identity databases.
 *
 * Framework: node:test + node:assert/strict.
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, describe } from 'node:test';
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, truncate, writeFile, appendFile }
  from 'node:fs/promises';

import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import express from 'express';

import {
  createAssistantImagesRouter,
  deriveAllowedRoots,
  encodeProjectPathForScratchpad,
  identityFileTrusted,
  isPrivateGroup,
  loadPrivateGid,
  nsswitchTrustsLocalSources,
  resolveImageWithinRoots,
  trustedDirectory,
} from './assistant-images.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);
const UID = process.getuid();
const GID = process.getgid();
const OTHER = 4242;
const LOCAL_NSS = 'passwd: files systemd\ngroup: files [SUCCESS=merge] systemd\n';

const passwdFor = (extra = '') => `root:x:0:0:root:/root:/bin/sh\nsvc:x:${UID}:${GID}:svc:/srv:/bin/false\n${extra}`;
const groupFor = (members = '', extra = '') => `root:x:0:\nsvc:x:${GID}:${members}\n${extra}`;

let tmpRoot;
before(async () => { tmpRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ai-trust-'))); });
after(async () => { await rm(tmpRoot, { recursive: true, force: true }); });

/**
 * Write passwd/group/nsswitch (0644) into a fresh dir and return their paths.
 * Temp files are owned by the test uid, so `ownerUid` is set to it (B-1471 seam).
 */
async function writeIdentity({ passwd = passwdFor(), group = groupFor(), nsswitch = LOCAL_NSS } = {}) {
  const dir = await mkdtemp(path.join(tmpRoot, 'id-'));
  const files = { passwdPath: path.join(dir, 'passwd'), groupPath: path.join(dir, 'group'),
    nsswitchPath: path.join(dir, 'nsswitch.conf'), ownerUid: UID };
  for (const [file, text] of [[files.passwdPath, passwd], [files.groupPath, group], [files.nsswitchPath, nsswitch]]) {
    await writeFile(file, text);
    await chmod(file, 0o644);
  }
  return files;
}

/**
 * An fs seam that counts content reads and can mutate a file before its 2nd fstat
 * or its 1st read. `freezeStat` replays the first fstat so only the read guard remains.
 */
function countingOpen({ mutateOnSecondStat = null, mutateOnFirstRead = null, freezeStat = false } = {}) {
  const counter = { reads: 0 };
  counter.openFile = async (filePath, mode) => {
    const handle = await open(filePath, mode);
    let stats = 0;
    let firstStat = null;
    let reads = 0;
    return {
      read: async (...args) => {
        counter.reads += 1;
        reads += 1;
        if (reads === 1 && mutateOnFirstRead?.path === filePath) await mutateOnFirstRead.run();
        return handle.read(...args);
      },
      stat: async () => {
        stats += 1;
        if (stats === 2 && mutateOnSecondStat?.path === filePath) await mutateOnSecondStat.run();
        if (freezeStat && firstStat) return firstStat;
        firstStat = await handle.stat();
        return firstStat;
      },
      close: () => handle.close(),
    };
  };
  return counter;
}

// ---------------------------------------------------------------------------
// 1. isPrivateGroup
// ---------------------------------------------------------------------------

describe('isPrivateGroup', () => {
  const check = (passwdText, groupText) => isPrivateGroup({ passwdText, groupText, uid: 1000, gid: 1000 });
  const pw = 'root:x:0:0::/root:/bin/sh\nsvc:x:1000:1000::/srv:/bin/false\n';

  test('user private group with no members is private', () => {
    assert.equal(check(pw, 'root:x:0:\nsvc:x:1000:\n'), true);
  });
  test('an extra member makes it shared', () => {
    assert.equal(check(pw, 'svc:x:1000:alice\n'), false);
  });
  test('only the server itself listed as member stays private', () => {
    assert.equal(check(pw, 'svc:x:1000:svc\n'), true);
  });
  test('another account with the same primary gid makes it shared', () => {
    assert.equal(check(`${pw}bob:x:1001:1000::/home/user:/bin/sh\n`, 'svc:x:1000:\n'), false);
  });
  test('a same-uid alias may be listed', () => {
    assert.equal(check(`${pw}svc2:x:1000:1000::/srv:/bin/false\n`, 'svc:x:1000:svc,svc2\n'), true);
  });
  test('a gid missing from the group file is not private', () => {
    assert.equal(check(pw, 'root:x:0:\n'), false);
  });
  test('duplicate gid lines where one carries a foreign member is shared', () => {
    assert.equal(check(pw, 'svc:x:1000:\nsvcdup:x:1000:alice\n'), false);
  });
  test('NIS compat lines fail closed in either file', () => {
    assert.equal(check(`${pw}+::::::\n`, 'svc:x:1000:\n'), false);
    assert.equal(check(pw, 'svc:x:1000:\n+:::\n'), false);
    assert.equal(check(pw, 'svc:x:1000:\n-alice:::\n'), false);
  });
  test('any malformed non-empty line fails closed', () => {
    assert.equal(check(`${pw}broken:x:1001\n`, 'svc:x:1000:\n'), false);
    assert.equal(check(pw, 'svc:x:1000:\nweird:x:notanumber:\n'), false);
    assert.equal(check(`${pw}   \n`, 'svc:x:1000:\n'), false);
    assert.equal(check(pw, 'svc:x:1000:svc,,svc\n'), false);
  });
  test('a real group password fails closed', () => {
    assert.equal(check(pw, 'svc:$6$salt$hash:1000:\n'), false);
    assert.equal(check(pw, 'svc:!:1000:\n'), true);
  });
  test('no passwd line for the uid fails closed', () => {
    assert.equal(isPrivateGroup({ passwdText: pw, groupText: 'svc:x:1000:\n', uid: 7, gid: 1000 }), false);
  });
});

// ---------------------------------------------------------------------------
// 2. nsswitch parsing
// ---------------------------------------------------------------------------

describe('nsswitchTrustsLocalSources', () => {
  test('files and systemd, with comments and bracket actions, are accepted', () => {
    assert.equal(nsswitchTrustsLocalSources('# c\npasswd: files systemd\ngroup:  files  # tail\n'), true);
    assert.equal(nsswitchTrustsLocalSources('passwd: files [NOTFOUND=return] systemd\ngroup: files\n'), true);
  });
  test('remote or compat sources fail closed', () => {
    assert.equal(nsswitchTrustsLocalSources('passwd: files sss\ngroup: files\n'), false);
    assert.equal(nsswitchTrustsLocalSources('passwd: files\ngroup: compat\n'), false);
    assert.equal(nsswitchTrustsLocalSources('passwd: files\ngroup: files ldap\n'), false);
  });
  test('missing, duplicated, empty or malformed entries fail closed', () => {
    assert.equal(nsswitchTrustsLocalSources('passwd: files\n'), false);
    assert.equal(nsswitchTrustsLocalSources('passwd: files\ngroup: files\ngroup: files\n'), false);
    assert.equal(nsswitchTrustsLocalSources('passwd:\ngroup: files\n'), false);
    assert.equal(nsswitchTrustsLocalSources('passwd: files [oops\ngroup: files\n'), false);
    assert.equal(nsswitchTrustsLocalSources('passwd: files [bad action]\ngroup: files\n'), false);
  });
  test('database names match case-insensitively; a case-variant duplicate fails closed', () => {
    assert.equal(nsswitchTrustsLocalSources('Passwd: files\nGROUP: files systemd\n'), true);
    assert.equal(nsswitchTrustsLocalSources('passwd: files\nPASSWD: files\ngroup: files\n'), false);
    assert.equal(nsswitchTrustsLocalSources('passwd: files\nGroup: files ldap\n'), false);
  });
  test('initgroups is optional but, when present, held to the same rule', () => {
    const base = 'passwd: files\ngroup: files\n';
    assert.equal(nsswitchTrustsLocalSources(`${base}initgroups: files systemd\n`), true);
    assert.equal(nsswitchTrustsLocalSources(`${base}initgroups: files ldap\n`), false);
    assert.equal(nsswitchTrustsLocalSources(`${base}initgroups: files\nInitGroups: files\n`), false);
  });
  test('a pathological bracket action is refused in linear time (no ReDoS)', () => {
    for (const token of [`[${'a=aaaa'.repeat(16)}=]`, `[${'a=aaaa'.repeat(5000)}=]`,
      `[${' a=b'.repeat(5000)} !]`]) {
      const started = performance.now();
      const verdict = nsswitchTrustsLocalSources(`passwd: files ${token}\ngroup: files\n`);
      const elapsed = performance.now() - started;
      assert.equal(verdict, false);
      assert.ok(elapsed < 500, `took ${elapsed.toFixed(1)} ms`);
    }
    assert.equal(nsswitchTrustsLocalSources('passwd: files [!UNAVAIL=return  SUCCESS=continue]\ngroup: files\n'), true);
  });
});

// ---------------------------------------------------------------------------
// 3. trustedDirectory with fake stats
// ---------------------------------------------------------------------------

describe('identityFileTrusted (B-1471)', () => {
  test('root-owned and not group/other-writable is trusted', () => {
    assert.equal(identityFileTrusted({ uid: 0, mode: 0o100644 }), true);
    assert.equal(identityFileTrusted({ uid: 0, mode: 0o100600 }), true);
  });
  test('a non-root owner is refused unless it is the injected owner', () => {
    assert.equal(identityFileTrusted({ uid: 1000, mode: 0o100644 }), false);
    assert.equal(identityFileTrusted({ uid: 1000, mode: 0o100644 }, 1000), true);
  });
  test('group- or other-writable is refused even for root', () => {
    assert.equal(identityFileTrusted({ uid: 0, mode: 0o100664 }), false);
    assert.equal(identityFileTrusted({ uid: 0, mode: 0o100646 }), false);
  });
  test('a missing or malformed stat is refused', () => {
    assert.equal(identityFileTrusted(undefined), false);
    assert.equal(identityFileTrusted({ uid: '0', mode: 0o100644 }), false);
  });
});

describe('trustedDirectory', () => {
  const dir = (mode, { uid = UID, gid = GID, isDir = true } = {}) => ({ mode, uid, gid, isDirectory: () => isDir });

  test('755 owned by the server is trusted', () => { assert.equal(trustedDirectory(dir(0o755)), true); });
  test('775 is trusted only for the proven private gid', () => {
    assert.equal(trustedDirectory(dir(0o775), { privateGid: GID }), true);
    assert.equal(trustedDirectory(dir(0o775), { privateGid: null }), false);
    assert.equal(trustedDirectory(dir(0o775, { gid: OTHER }), { privateGid: GID }), false);
  });
  test('777 is never trusted unless root-owned sticky', () => {
    assert.equal(trustedDirectory(dir(0o777), { sticky: true, privateGid: GID }), false);
    assert.equal(trustedDirectory(dir(0o1777, { uid: 0, gid: 0 }), { sticky: true }), true);
    assert.equal(trustedDirectory(dir(0o1777, { uid: 0, gid: 0 }), { sticky: false }), false);
    assert.equal(trustedDirectory(dir(0o0777, { uid: 0, gid: 0 }), { sticky: true }), false);
  });
  test('behavior change: root 1775 with gid 0 is rejected even when sticky', () => {
    assert.equal(trustedDirectory(dir(0o1775, { uid: 0, gid: 0 }), { sticky: true, privateGid: null }), false);
  });
  test('foreign owner, gid 0 and non-directories are rejected', () => {
    assert.equal(trustedDirectory(dir(0o755, { uid: OTHER })), false);
    assert.equal(trustedDirectory(dir(0o775, { gid: 0 }), { privateGid: 0 }), false);
    assert.equal(trustedDirectory(dir(0o775, { gid: 0 }), { privateGid: GID }), false);
    assert.equal(trustedDirectory(dir(0o755, { isDir: false })), false);
  });
});

// ---------------------------------------------------------------------------
// 4. loadPrivateGid against real temp files
// ---------------------------------------------------------------------------

describe('loadPrivateGid', { skip: GID === 0 ? 'gid 0 never qualifies' : false }, () => {
  test('a private primary group yields the gid, then a cache hit reads nothing', async () => {
    const files = await writeIdentity();
    const first = countingOpen();
    assert.equal(await loadPrivateGid(files, { openFile: first.openFile }), GID);
    assert.ok(first.reads > 0);
    const second = countingOpen();
    assert.equal(await loadPrivateGid(files, { openFile: second.openFile }), GID);
    assert.equal(second.reads, 0);
  });

  test('rewriting a file invalidates the cache', async () => {
    const files = await writeIdentity();
    assert.equal(await loadPrivateGid(files), GID);
    await writeFile(files.groupPath, groupFor('alice'));
    assert.equal(await loadPrivateGid(files), null);
  });

  test('a missing file yields null', async () => {
    const files = await writeIdentity();
    await rm(files.nsswitchPath);
    assert.equal(await loadPrivateGid(files), null);
  });

  test('a file changed between its two fstats is not trusted nor cached', async () => {
    const files = await writeIdentity();
    const racing = countingOpen({ mutateOnSecondStat: { path: files.passwdPath,
      run: () => appendFile(files.passwdPath, `other:x:${OTHER}:${OTHER}::/:/bin/false\n`) } });
    assert.equal(await loadPrivateGid(files, { openFile: racing.openFile }), null);
    const next = countingOpen();
    assert.equal(await loadPrivateGid(files, { openFile: next.openFile }), GID);
    assert.ok(next.reads > 0, 'the unstable snapshot must not have been cached');
  });

  test('a non-local nsswitch source yields null', async () => {
    const files = await writeIdentity({ nsswitch: 'passwd: files sss\ngroup: files sss\n' });
    assert.equal(await loadPrivateGid(files), null);
  });

  test('a trusted initgroups line keeps the group private; a remote one yields null', async () => {
    const trusted = await writeIdentity({ nsswitch: `${LOCAL_NSS}initgroups: files\n` });
    assert.equal(await loadPrivateGid(trusted), GID);
    const remote = await writeIdentity({ nsswitch: `${LOCAL_NSS}initgroups: files ldap\n` });
    assert.equal(await loadPrivateGid(remote), null);
  });

  test('a FIFO in place of an identity file yields null without blocking', async () => {
    const files = await writeIdentity();
    await rm(files.groupPath);
    execFileSync('mkfifo', [files.groupPath]);
    assert.equal(await loadPrivateGid(files), null);
  });

  test('growth during the read is caught by the size+1 read even when fstat looks stable', async () => {
    const files = await writeIdentity();
    const growing = countingOpen({ freezeStat: true, mutateOnFirstRead: { path: files.groupPath,
      run: () => appendFile(files.groupPath, 'late:x:4343:\n') } });
    assert.equal(await loadPrivateGid(files, { openFile: growing.openFile }), null);
  });

  test('B-1471: identity files are trusted only from the expected owner (root by default)', async () => {
    const files = await writeIdentity();
    const { ownerUid, ...rootExpected } = files;
    assert.equal(ownerUid, UID);
    assert.equal(await loadPrivateGid(rootExpected), UID === 0 ? GID : null);
    assert.equal(await loadPrivateGid({ ...files, ownerUid: OTHER }), null);
    assert.equal(await loadPrivateGid({ ...files, ownerUid: 'x' }), null);
  });

  for (const [label, mode] of [['group', 0o664], ['other', 0o646]]) {
    test(`B-1471: a ${label}-writable identity file yields null, even after a cached verdict`, async () => {
      const files = await writeIdentity();
      assert.equal(await loadPrivateGid(files), GID);
      await chmod(files.groupPath, mode);
      assert.equal(await loadPrivateGid(files), null);
      await chmod(files.groupPath, 0o644);
      assert.equal(await loadPrivateGid(files), GID);
    });
  }

  test('an identity file over 4 MiB yields null', async () => {
    const files = await writeIdentity();
    await truncate(files.passwdPath, 4 * 1024 * 1024 + 1);
    assert.equal(await loadPrivateGid(files), null);
  });
});

// ---------------------------------------------------------------------------
// 5. Router over real HTTP with 775 chains
// ---------------------------------------------------------------------------

/** mkdir each segment below `from` and force its mode (umask-independent). */
async function mkdirChain(from, segments, mode) {
  let current = from;
  for (const segment of segments) {
    current = path.join(current, segment);
    await mkdir(current, { recursive: true });
    await chmod(current, mode);
  }
  return current;
}

async function startRouter(identityFiles, rootsBySession) {
  const app = express();
  app.use('/img', createAssistantImagesRouter({
    authenticateToken: (req, _res, next) => {
      req.user = { id: 1 };
      req.assertCurrentIdentity = () => true;
      next();
    },
    resolveAllowedRoots: (sessionId) => (rootsBySession[sessionId]
      ? { roots: rootsBySession[sessionId], isCurrent: () => true } : null),
    limiter: (_req, _res, next) => next(),
    identityFiles,
  }));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const status = async (session, file) => (await fetch(`http://127.0.0.1:${server.address().port}/img?`
    + `session=${session}&path=${encodeURIComponent(file)}`)).status;
  return { status, close: () => new Promise(resolve => server.close(resolve)) };
}

describe('router with group-writable chains', { skip: GID === 0 ? 'gid 0 never qualifies' : false }, () => {
  const sid = 'sess-1';
  const instance = '7f87b639-7adb-4c1b-97a1-590fc7c9baee';
  let fx;

  before(async () => {
    const top = await mkdtemp(path.join(tmpRoot, 'chain-'));
    const parent775 = await mkdirChain(top, ['parent775'], 0o775);
    const projectRoot = await mkdirChain(parent775, ['proj'], 0o775);
    const overlay = await mkdirChain(projectRoot,
      ['.git', 'nassaj-session-overlays', 'instances', instance, 'workspace'], 0o775);
    const scratchBase = await mkdirChain(top, ['tmp775', `claude-${UID}`], 0o775);
    const encoding = encodeProjectPathForScratchpad(projectRoot);
    const scratchpad = await mkdirChain(scratchBase, [encoding, sid, 'scratchpad'], 0o775);
    const otherScratch = await mkdirChain(scratchBase, [encoding, 'other', 'scratchpad'], 0o775);
    await symlink(path.join(scratchBase, encoding, 'other'), path.join(scratchBase, encoding, 'linked'));
    for (const file of [path.join(overlay, 'shot.png'), path.join(overlay, '.hidden.png'),
      path.join(scratchpad, 'shot.png'), path.join(otherScratch, 'peek.png')]) await writeFile(file, PNG_SIG);
    const overlayRoots = deriveAllowedRoots({ projectRoot, sessionId: sid, overlayWorkspace: overlay,
      encodings: [encodeProjectPathForScratchpad(overlay)], scratchpadBases: [scratchBase], tmpBases: [] });
    const linkedRoots = deriveAllowedRoots({ projectRoot, sessionId: 'linked', scratchpadBases: [scratchBase],
      tmpBases: [] });
    fx = { overlay, scratchpad, scratchBase, encoding, roots: { [sid]: overlayRoots, linked: linkedRoots } };
  });

  test('private group: 775 scratchpad and 775 overlay chains are served', async () => {
    const router = await startRouter(await writeIdentity(), fx.roots);
    try {
      assert.equal(await router.status(sid, path.join(fx.scratchpad, 'shot.png')), 200);
      assert.equal(await router.status(sid, path.join(fx.overlay, 'shot.png')), 200);
    } finally { await router.close(); }
  });

  test('private group still refuses 777, hidden files and symlinked session roots', async () => {
    const router = await startRouter(await writeIdentity(), fx.roots);
    try {
      assert.equal(await router.status(sid, path.join(fx.overlay, '.hidden.png')), 403);
      const linked = path.join(fx.scratchBase, fx.encoding, 'linked', 'scratchpad', 'peek.png');
      assert.equal(await router.status('linked', linked), 403);
      await chmod(fx.scratchpad, 0o777);
      try { assert.equal(await router.status(sid, path.join(fx.scratchpad, 'shot.png')), 403); }
      finally { await chmod(fx.scratchpad, 0o775); }
    } finally { await router.close(); }
  });

  test('an extra group member refuses the 775 chains', async () => {
    const router = await startRouter(await writeIdentity({ group: groupFor('alice') }), fx.roots);
    try {
      assert.equal(await router.status(sid, path.join(fx.scratchpad, 'shot.png')), 403);
      assert.equal(await router.status(sid, path.join(fx.overlay, 'shot.png')), 403);
    } finally { await router.close(); }
  });

  test('unreadable identity files refuse the 775 chains', async () => {
    const missing = path.join(tmpRoot, 'no-such-dir');
    const router = await startRouter({ passwdPath: path.join(missing, 'passwd'),
      groupPath: path.join(missing, 'group'), nsswitchPath: path.join(missing, 'nsswitch.conf') }, fx.roots);
    try {
      assert.equal(await router.status(sid, path.join(fx.scratchpad, 'shot.png')), 403);
    } finally { await router.close(); }
  });

  test('lazy: a 755-only chain is served without consulting identity files', async () => {
    const top = await mkdtemp(path.join(tmpRoot, 'plain-'));
    const base = await mkdirChain(top, ['tmp755', `claude-${UID}`], 0o755);
    const encoding = encodeProjectPathForScratchpad('/srv/plain');
    const pad = await mkdirChain(base, [encoding, sid, 'scratchpad'], 0o755);
    await writeFile(path.join(pad, 'shot.png'), PNG_SIG);
    const roots = deriveAllowedRoots({ projectRoot: '/srv/plain', sessionId: sid, scratchpadBases: [base],
      tmpBases: [] });
    const missing = path.join(tmpRoot, 'absent-identity');
    const router = await startRouter({ passwdPath: path.join(missing, 'passwd'),
      groupPath: path.join(missing, 'group'), nsswitchPath: path.join(missing, 'nsswitch.conf') }, { [sid]: roots });
    try {
      assert.equal(await router.status(sid, path.join(pad, 'shot.png')), 200);
    } finally { await router.close(); }
  });

  test('resolveImageWithinRoots honours identityFiles the same way', async () => {
    const target = path.join(fx.scratchpad, 'shot.png');
    const ok = await resolveImageWithinRoots(fx.roots[sid], target, { identityFiles: await writeIdentity() });
    assert.equal(ok.ok, true);
    const shared = await resolveImageWithinRoots(fx.roots[sid], target,
      { identityFiles: await writeIdentity({ passwd: passwdFor(`bob:x:${OTHER}:${GID}::/:/bin/sh\n`) }) });
    assert.equal(shared.status, 403);
  });
});

test('static: the router never takes identityFiles from the request', async () => {
  const source = await readFile(new URL('./assistant-images.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /req\.(query|body|params|headers)[^\n;]*identityFiles/);
  assert.doesNotMatch(source, /identityFiles[^\n;]*req\.(query|body|params|headers)/);
  const handler = source.slice(source.indexOf("router.get('/'"));
  assert.match(handler, /\{ retainHandle: true, identityFiles \}/);
  assert.doesNotMatch(handler, /identityFiles\s*=/);
});
