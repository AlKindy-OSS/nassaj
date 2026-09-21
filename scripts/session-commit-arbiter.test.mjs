import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { acquireLease, canonicalizeOwnedPaths, captureRequest, commitRequest, heartbeatLease, releaseLease, reservePreviewReplay, resumeRequest } from './session-commit-arbiter.mjs';
import { listPreviewEvents } from './preview-oid-consumer.mjs';

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function fixture() {
  const repo = fs.mkdtempSync(path.join('/var/tmp', 'nassaj-arbiter-'));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Arbiter Test');
  git(repo, 'config', 'user.email', 'arbiter@example.test');
  fs.writeFileSync(path.join(repo, 'shared.txt'), 'alpha\nmiddle\nomega\n');
  fs.writeFileSync(path.join(repo, 'other.txt'), 'old\n');
  git(repo, 'add', 'shared.txt', 'other.txt');
  git(repo, 'commit', '-m', 'chore: baseline');
  return repo;
}

function cleanup(repo) {
  if (!fs.existsSync(repo)) return;
  const makeWritable = (entry) => {
    const metadata = fs.lstatSync(entry);
    if (metadata.isSymbolicLink()) return;
    fs.chmodSync(entry, metadata.isDirectory() ? 0o700 : 0o600);
    if (metadata.isDirectory()) {
      for (const child of fs.readdirSync(entry)) makeWritable(path.join(entry, child));
    }
  };
  makeWritable(repo);
  fs.rmSync(repo, { recursive: true, force: true });
}

function arbiterStateDir(repo) {
  const common = git(repo, 'rev-parse', '--git-common-dir');
  return path.join(path.resolve(repo, common), 'nassaj', 'commit-arbiter');
}

function runReplayChild(repo, replayId, oid, domains = ['client']) {
  const moduleUrl = new URL('./session-commit-arbiter.mjs', import.meta.url).href;
  const source = [
    `import { reservePreviewReplay } from ${JSON.stringify(moduleUrl)};`,
    `const result = await reservePreviewReplay(${JSON.stringify({ repo, replayId, oid, domains })});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(JSON.parse(stdout))
      : reject(new Error(`replay child exited ${code}: ${stderr}`)));
  });
}

function runCommitChild(repo, requestId, message) {
  const moduleUrl = new URL('./session-commit-arbiter.mjs', import.meta.url).href;
  const source = [
    `import { commitRequest } from ${JSON.stringify(moduleUrl)};`,
    `const result = commitRequest(${JSON.stringify({ repo, requestId, message })});`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve(JSON.parse(stdout))
      : reject(new Error(`commit child exited ${code}: ${stderr}`)));
  });
}

test('reserves an idempotent replay from the arbiter sequence source and rejects changed facts', async () => {
  const repo = fixture();
  try {
    const oid = git(repo, 'rev-parse', 'HEAD');
    const first = await reservePreviewReplay({ repo, replayId: 'client-publisher-b799', oid, domains: ['client'] });
    const retried = await reservePreviewReplay({ repo, replayId: 'client-publisher-b799', oid, domains: ['client'] });
    assert.equal(first.sequence, 1);
    assert.equal(retried.sequence, first.sequence);
    assert.equal(fs.existsSync(path.join(first.sourceRoot, 'shared.txt')), true);
    assert.deepEqual(listPreviewEvents(repo).map(({ sequence, oid: eventOid, domains }) => ({ sequence, eventOid, domains })), [{
      sequence: 1, eventOid: oid, domains: ['client'],
    }]);
    await assert.rejects(
      reservePreviewReplay({ repo, replayId: 'client-publisher-b799', oid, domains: ['server'] }),
      /already bound to different facts/,
    );
    assert.equal(JSON.parse(fs.readFileSync(path.join(arbiterStateDir(repo), 'sequence.json'), 'utf8')).last, 1);
  } finally { cleanup(repo); }
});

test('ratchets a replay above event refs when sequence.json is stale', async () => {
  const repo = fixture();
  try {
    const oid = git(repo, 'rev-parse', 'HEAD');
    fs.mkdirSync(arbiterStateDir(repo), { recursive: true });
    fs.writeFileSync(path.join(arbiterStateDir(repo), 'sequence.json'), JSON.stringify({ schema: 1, last: 20 }));
    git(repo, 'update-ref', 'refs/nassaj/previews/v1/events/0000000000000024/event', oid);
    git(repo, 'update-ref', 'refs/nassaj/previews/v1/events/0000000000000024/client', oid);
    const replay = await reservePreviewReplay({ repo, replayId: 'ratchet-highwater', oid, domains: ['client'] });
    assert.equal(replay.sequence, 25);
    assert.equal(JSON.parse(fs.readFileSync(path.join(arbiterStateDir(repo), 'sequence.json'), 'utf8')).last, 25);
  } finally { cleanup(repo); }
});

test('serializes concurrent replay reservations without duplicate sequences', async () => {
  const repo = fixture();
  try {
    const oid = git(repo, 'rev-parse', 'HEAD');
    const results = await Promise.all([
      runReplayChild(repo, 'concurrent-client-a', oid),
      runReplayChild(repo, 'concurrent-client-b', oid),
    ]);
    assert.deepEqual(results.map((item) => item.sequence).sort((a, b) => a - b), [1, 2]);
    assert.deepEqual(listPreviewEvents(repo).map((event) => event.sequence), [1, 2]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(arbiterStateDir(repo), 'sequence.json'), 'utf8')).last, 2);
  } finally { cleanup(repo); }
});

test('deduplicates concurrent retries of one replay id', async () => {
  const repo = fixture();
  try {
    const oid = git(repo, 'rev-parse', 'HEAD');
    const results = await Promise.all([
      runReplayChild(repo, 'same-concurrent-replay', oid),
      runReplayChild(repo, 'same-concurrent-replay', oid),
    ]);
    assert.deepEqual(results.map((item) => item.sequence), [1, 1]);
    assert.deepEqual(listPreviewEvents(repo).map((event) => event.sequence), [1]);
  } finally { cleanup(repo); }
});

test('serializes a replay racing a normal commit in the shared sequence namespace', async () => {
  const repo = fixture();
  try {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/client.txt'), 'old\n');
    git(repo, 'add', 'src/client.txt');
    git(repo, 'commit', '-m', 'chore: add concurrent sequence fixture');
    const replayOid = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'src/client.txt'), 'new\n');
    const lease = acquireLease({ repo, session: 'concurrent-commit', paths: ['src/client.txt'], isolation: 'worktree' });
    const request = captureRequest({
      repo, session: 'concurrent-commit', generation: lease.generation, paths: ['src/client.txt'],
    });
    const [replay, committed] = await Promise.all([
      runReplayChild(repo, 'racing-existing-oid', replayOid),
      runCommitChild(repo, request.requestId, 'fix: race a normal commit with replay'),
    ]);
    assert.deepEqual([replay.sequence, committed.sequence].sort((a, b) => a - b), [1, 2]);
    assert.deepEqual(listPreviewEvents(repo).map((event) => event.sequence), [1, 2]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(arbiterStateDir(repo), 'sequence.json'), 'utf8')).last, 2);
  } finally { cleanup(repo); }
});

test('shares one sequence namespace between replay and the next normal commit', async () => {
  const repo = fixture();
  try {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src/client.txt'), 'old\n');
    git(repo, 'add', 'src/client.txt');
    git(repo, 'commit', '-m', 'chore: add client sequence fixture');
    const replayOid = git(repo, 'rev-parse', 'HEAD');
    const replay = await reservePreviewReplay({
      repo, replayId: 'existing-oid-client-replay', oid: replayOid, domains: ['client'],
    });
    fs.writeFileSync(path.join(repo, 'src/client.txt'), 'new\n');
    const lease = acquireLease({ repo, session: 'commit-after-replay', paths: ['src/client.txt'], isolation: 'worktree' });
    const request = captureRequest({
      repo, session: 'commit-after-replay', generation: lease.generation, paths: ['src/client.txt'],
    });
    const committed = commitRequest({ repo, requestId: request.requestId, message: 'fix: commit after replay reservation' });
    assert.equal(replay.sequence, 1);
    assert.equal(committed.sequence, 2);
    assert.deepEqual(listPreviewEvents(repo).map((event) => event.sequence), [1, 2]);
  } finally { cleanup(repo); }
});

test('recovers crashes on either side of atomic replay ref creation before another reservation', async () => {
  for (const [replayId, hook, refsInitiallyVisible] of [
    ['crash-before-refs', 'afterJournalBeforeRefs', false],
    ['crash-after-refs', 'afterRefsBeforeComplete', true],
  ]) {
    const repo = fixture();
    try {
      const oid = git(repo, 'rev-parse', 'HEAD');
      const moduleUrl = new URL('./session-commit-arbiter.mjs', import.meta.url).href;
      const source = [
        `import { reservePreviewReplay } from ${JSON.stringify(moduleUrl)};`,
        `await reservePreviewReplay(${JSON.stringify({ repo, replayId, oid, domains: ['client'] })},`,
        `{ ${hook}() { process.kill(process.pid, 'SIGKILL'); } });`,
      ].join('\n');
      const killed = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
      assert.equal(killed.signal, 'SIGKILL');
      assert.equal(listPreviewEvents(repo).length > 0, refsInitiallyVisible);
      const recovered = await reservePreviewReplay({ repo, replayId, oid, domains: ['client'] });
      assert.equal(recovered.sequence, 1);
      const next = await reservePreviewReplay({ repo, replayId: `${replayId}-next`, oid, domains: ['client'] });
      assert.equal(next.sequence, 2, 'recovery must finish before reserving another sequence');
      assert.deepEqual(listPreviewEvents(repo).map((event) => event.sequence), [1, 2]);
    } finally { cleanup(repo); }
  }
});

test('fails closed on partial replay refs and invalid or abbreviated OIDs', async () => {
  const repo = fixture();
  try {
    const oid = git(repo, 'rev-parse', 'HEAD');
    await assert.rejects(
      reservePreviewReplay({ repo, replayId: 'abbreviated', oid: oid.slice(0, 12), domains: ['client'] }),
      /full exact commit OID/,
    );
    await assert.rejects(
      reservePreviewReplay({ repo, replayId: 'missing', oid: 'f'.repeat(40), domains: ['client'] }),
      /git rev-parse failed/,
    );
    for (const replayId of ['line\nbreak', 'tab\tbreak', `nul${String.fromCharCode(0)}break`, ' leading-space']) {
      await assert.rejects(
        reservePreviewReplay({ repo, replayId, oid, domains: ['client'] }),
        /replay id is invalid/,
      );
    }
    const moduleUrl = new URL('./session-commit-arbiter.mjs', import.meta.url).href;
    const source = [
      `import { reservePreviewReplay } from ${JSON.stringify(moduleUrl)};`,
      `await reservePreviewReplay(${JSON.stringify({ repo, replayId: 'partial', oid, domains: ['client'] })},`,
      "{ afterJournalBeforeRefs() { process.kill(process.pid, 'SIGKILL'); } });",
    ].join('\n');
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGKILL');
    git(repo, 'update-ref', 'refs/nassaj/previews/v1/events/0000000000000001/event', oid);
    await assert.rejects(
      reservePreviewReplay({ repo, replayId: 'partial', oid, domains: ['client'] }),
      /partial or mismatched refs/,
    );
  } finally { cleanup(repo); }
});

test('merges independent hunks captured from the same baseline', () => {
  const repo = fixture();
  try {
    const leaseA = acquireLease({ repo, session: 'same-session', paths: ['shared.txt'], isolation: 'worktree' });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'ALPHA\nmiddle\nomega\n');
    const requestA = captureRequest({ repo, session: 'same-session', generation: leaseA.generation, paths: ['shared.txt'] });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'alpha\nmiddle\nOMEGA\n');
    const requestB = captureRequest({ repo, session: 'same-session', generation: leaseA.generation, paths: ['shared.txt'] });
    commitRequest({ repo, requestId: requestA.requestId, message: 'fix: first independent hunk' });
    commitRequest({ repo, requestId: requestB.requestId, message: 'fix: second independent hunk' });
    assert.equal(git(repo, 'show', 'HEAD:shared.txt'), 'ALPHA\nmiddle\nOMEGA');
  } finally { cleanup(repo); }
});

test('rebuilds the merge from the new tip after a CAS race', () => {
  const repo = fixture();
  try {
    const lease = acquireLease({ repo, session: 'race', paths: ['shared.txt'], isolation: 'worktree' });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'ALPHA\nmiddle\nomega\n');
    const request = captureRequest({ repo, session: 'race', generation: lease.generation, paths: ['shared.txt'] });
    let raced = false;
    const result = commitRequest({
      repo,
      requestId: request.requestId,
      message: 'fix: survive compare and swap race',
      beforeCas({ attempt, latest }) {
        if (attempt !== 1) return;
        raced = true;
        const blob = git(repo, 'hash-object', '-w', '--stdin');
        void blob;
        const tree = git(repo, 'show', '-s', '--format=%T', latest);
        const external = git(repo, 'commit-tree', tree, '-p', latest, '-m', 'chore: external race');
        git(repo, 'update-ref', 'refs/heads/main', external, latest);
      },
    });
    assert.equal(raced, true);
    assert.equal(result.attempts, 2);
    assert.equal(git(repo, 'show', 'HEAD:shared.txt'), 'ALPHA\nmiddle\nomega');
  } finally { cleanup(repo); }
});

test('applies optional author and committer identity only to the final commit', () => {
  const repo = fixture();
  try {
    const lease = acquireLease({ repo, session: 'identity', paths: ['shared.txt'], isolation: 'worktree' });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'authored\nmiddle\nomega\n');
    const request = captureRequest({ repo, session: 'identity', generation: lease.generation, paths: ['shared.txt'] });
    const result = commitRequest({
      repo,
      requestId: request.requestId,
      message: 'fix: preserve session identity',
      authorEnv: {
        GIT_AUTHOR_NAME: 'Session Author',
        GIT_AUTHOR_EMAIL: 'author@example.test',
        GIT_COMMITTER_NAME: 'Nassaj Arbiter',
        GIT_COMMITTER_EMAIL: 'arbiter@example.test',
      },
    });
    assert.equal(git(repo, 'show', '-s', '--format=%an|%ae|%cn|%ce', result.commit), 'Session Author|author@example.test|Nassaj Arbiter|arbiter@example.test');
    assert.notEqual(git(repo, 'show', '-s', '--format=%an|%ae', request.requestCommit), 'Session Author|author@example.test');
  } finally { cleanup(repo); }
});

test('captures a submitted patch against the base blob without reading overlapping worktree edits', () => {
  const repo = fixture();
  try {
    const lease = acquireLease({ repo, session: 'patch', paths: ['shared.txt'] });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'unrelated worktree edit\nmiddle\nomega\n');
    const patch = [
      'diff --git a/shared.txt b/shared.txt',
      '--- a/shared.txt',
      '+++ b/shared.txt',
      '@@ -1,3 +1,3 @@',
      '-alpha',
      '+PATCHED',
      ' middle',
      ' omega',
      '',
    ].join('\n');
    const beforeIndex = git(repo, 'write-tree');
    const request = captureRequest({
      repo,
      session: 'patch',
      generation: lease.generation,
      submittedPatches: [{ path: 'shared.txt', patch }],
    });
    assert.equal(git(repo, 'write-tree'), beforeIndex, 'shared default index must remain untouched');
    assert.equal(request.entries[0].baseBlob, git(repo, 'rev-parse', 'HEAD:shared.txt'));
    commitRequest({ repo, requestId: request.requestId, message: 'fix: commit only submitted source hunk' });
    assert.equal(git(repo, 'show', 'HEAD:shared.txt'), 'PATCHED\nmiddle\nomega');
    assert.equal(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'unrelated worktree edit\nmiddle\nomega\n');

    const escapedPatch = patch.replaceAll('shared.txt', 'other.txt').replace('-alpha', '-old').replace('+PATCHED', '+new').replace(' middle\n omega', '');
    assert.throws(() => captureRequest({ repo, session: 'patch', generation: lease.generation, submittedPatches: [{ path: 'shared.txt', patch: escapedPatch }] }), /escapes declared path|does not apply/);
  } finally { cleanup(repo); }
});

test('atomically reconciles a clean default index to the new HEAD tree', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'other.txt'), 'unselected dirty worktree content\n');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'COMMITTED\nmiddle\nomega\n');
    const lease = acquireLease({ repo, session: 'clean-index', paths: ['shared.txt'], isolation: 'worktree' });
    const request = captureRequest({ repo, session: 'clean-index', generation: lease.generation, paths: ['shared.txt'] });
    const result = commitRequest({ repo, requestId: request.requestId, message: 'fix: reconcile clean shared index' });

    assert.equal(result.needsReconciliation, false);
    assert.equal(git(repo, 'write-tree'), git(repo, 'show', '-s', '--format=%T', 'HEAD'));
    assert.equal(git(repo, 'show', 'HEAD:other.txt'), 'old');
    assert.equal(fs.readFileSync(path.join(repo, 'other.txt'), 'utf8'), 'unselected dirty worktree content\n');
  } finally { cleanup(repo); }
});

test('rebases staged intent onto the new HEAD without introducing an inverse staged diff', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'other.txt'), 'intentional staged content\n');
    git(repo, 'add', 'other.txt');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'COMMITTED\nmiddle\nomega\n');
    const lease = acquireLease({ repo, session: 'staged-index', paths: ['shared.txt'], isolation: 'worktree' });
    const request = captureRequest({ repo, session: 'staged-index', generation: lease.generation, paths: ['shared.txt'] });
    const result = commitRequest({ repo, requestId: request.requestId, message: 'fix: preserve staged index intent' });

    assert.equal(result.needsReconciliation, false);
    assert.equal(result.rebasedStagedIntent, true);
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'other.txt');
    assert.match(git(repo, 'diff', '--cached', '--', 'other.txt'), /\+intentional staged content/);
    assert.equal(git(repo, 'diff', '--cached', '--', 'shared.txt'), '', 'new commit must not appear as an inverse staged change');
    assert.equal(git(repo, 'show', 'HEAD:other.txt'), 'old');
    assert.equal(git(repo, 'show', 'HEAD:shared.txt'), 'COMMITTED\nmiddle\nomega');
  } finally { cleanup(repo); }
});

test('holds the default index lock throughout the HEAD compare-and-swap cutover', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'COMMITTED\nmiddle\nomega\n');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'writer attempt\n');
    const lease = acquireLease({ repo, session: 'index-enforcement', paths: ['shared.txt'], isolation: 'worktree' });
    const request = captureRequest({ repo, session: 'index-enforcement', generation: lease.generation, paths: ['shared.txt'] });
    let writerBlocked = false;
    commitRequest({
      repo,
      requestId: request.requestId,
      message: 'fix: enforce default index cutover lock',
      beforeCas() {
        const writer = spawnSync('git', ['-C', repo, 'add', 'other.txt'], { encoding: 'utf8' });
        writerBlocked = writer.status !== 0 && writer.stderr.includes('index.lock');
      },
    });
    assert.equal(writerBlocked, true);
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
    assert.equal(fs.readFileSync(path.join(repo, 'other.txt'), 'utf8'), 'writer attempt\n');
  } finally { cleanup(repo); }
});

test('recovers a SIGKILL between HEAD CAS and index promotion without duplicating the commit', () => {
  const repo = fixture();
  try {
    fs.mkdirSync(path.join(repo, 'server'));
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'server/crash.txt'), 'server old\n');
    fs.writeFileSync(path.join(repo, 'src/crash.txt'), 'client old\n');
    git(repo, 'add', 'server/crash.txt', 'src/crash.txt');
    git(repo, 'commit', '-m', 'chore: add crash event fixture');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'durable staged intent\n');
    git(repo, 'add', 'other.txt');
    fs.writeFileSync(path.join(repo, 'server/crash.txt'), 'server new\n');
    fs.writeFileSync(path.join(repo, 'src/crash.txt'), 'client new\n');
    const ownedPaths = ['server/crash.txt', 'src/crash.txt'];
    const lease = acquireLease({ repo, session: 'sigkill-cutover', paths: ownedPaths, isolation: 'worktree' });
    const request = captureRequest({ repo, session: 'sigkill-cutover', generation: lease.generation, paths: ownedPaths });
    const moduleUrl = new URL('./session-commit-arbiter.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `import { commitRequest } from ${JSON.stringify(moduleUrl)};`,
      `commitRequest({ repo: ${JSON.stringify(repo)}, requestId: ${JSON.stringify(request.requestId)},`,
      `message: 'fix: survive killed cutover', afterCasBeforeIndexPromotion() { process.kill(process.pid, 'SIGKILL'); } });`,
    ].join('\n')], { encoding: 'utf8' });

    assert.equal(child.signal, 'SIGKILL');
    const committedHead = git(repo, 'rev-parse', 'HEAD');
    assert.equal(git(repo, 'show', 'HEAD:server/crash.txt'), 'server new');
    assert.equal(git(repo, 'show', 'HEAD:src/crash.txt'), 'client new');
    assert.deepEqual(listPreviewEvents(repo).map(({ oid, domains }) => ({ oid, domains })), [{
      oid: committedHead,
      domains: ['client', 'server'],
    }], 'HEAD and all multi-domain event refs become visible together');
    assert.ok(fs.existsSync(path.join(repo, '.git/index.lock')), 'crash leaves the prepared index lock for recovery');

    heartbeatLease({ repo, session: 'sigkill-cutover', generation: lease.generation });
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), 'other.txt');
    assert.match(git(repo, 'diff', '--cached', '--', 'other.txt'), /\+durable staged intent/);
    assert.equal(git(repo, 'diff', '--cached', '--', 'server/crash.txt'), '');
    assert.equal(git(repo, 'diff', '--cached', '--', 'src/crash.txt'), '');
    assert.equal(fs.existsSync(path.join(repo, '.git/index.lock')), false);
    const retried = commitRequest({ repo, requestId: request.requestId, message: 'fix: survive killed cutover' });
    assert.equal(retried.commit, committedHead);
    assert.equal(retried.recovered, true);
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '3', 'retry returns recovery result without another commit');
  } finally { cleanup(repo); }
});

test('recovers a SIGKILL before the atomic ref transaction without exposing a partial event', () => {
  const repo = fixture();
  try {
    fs.mkdirSync(path.join(repo, 'server'));
    fs.writeFileSync(path.join(repo, 'server/before.txt'), 'old\n');
    git(repo, 'add', 'server/before.txt');
    git(repo, 'commit', '-m', 'chore: add pre-cas crash fixture');
    fs.writeFileSync(path.join(repo, 'server/before.txt'), 'new\n');
    const lease = acquireLease({ repo, session: 'sigkill-before-cas', paths: ['server/before.txt'], isolation: 'worktree' });
    const request = captureRequest({ repo, session: 'sigkill-before-cas', generation: lease.generation, paths: ['server/before.txt'] });
    const oldHead = git(repo, 'rev-parse', 'HEAD');
    const moduleUrl = new URL('./session-commit-arbiter.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `import { commitRequest } from ${JSON.stringify(moduleUrl)};`,
      `commitRequest({ repo: ${JSON.stringify(repo)}, requestId: ${JSON.stringify(request.requestId)},`,
      `message: 'fix: recover before atomic refs', beforeCas() { process.kill(process.pid, 'SIGKILL'); } });`,
    ].join('\n')], { encoding: 'utf8' });
    assert.equal(child.signal, 'SIGKILL');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), oldHead);
    assert.deepEqual(listPreviewEvents(repo), []);

    heartbeatLease({ repo, session: 'sigkill-before-cas', generation: lease.generation });
    const committed = commitRequest({ repo, requestId: request.requestId, message: 'fix: recover before atomic refs' });
    assert.equal(listPreviewEvents(repo).length, 1);
    assert.equal(listPreviewEvents(repo)[0].oid, committed.commit);
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD'), '3');
  } finally { cleanup(repo); }
});

test('fails before moving HEAD when staged intent conflicts with the candidate commit', () => {
  const repo = fixture();
  try {
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'STAGED\nmiddle\nomega\n');
    git(repo, 'add', 'shared.txt');
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'COMMITTED\nmiddle\nomega\n');
    const beforeHead = git(repo, 'rev-parse', 'HEAD');
    const lease = acquireLease({ repo, session: 'staged-conflict', paths: ['shared.txt'], isolation: 'worktree' });
    const request = captureRequest({ repo, session: 'staged-conflict', generation: lease.generation, paths: ['shared.txt'] });
    assert.throws(
      () => commitRequest({ repo, requestId: request.requestId, message: 'fix: conflicting staged and selected edits' }),
      /default index staged-intent conflict/,
    );
    assert.equal(git(repo, 'rev-parse', 'HEAD'), beforeHead);
    assert.match(git(repo, 'diff', '--cached', '--', 'shared.txt'), /\+STAGED/);
    assert.equal(git(repo, 'rev-parse', request.requestRef), request.requestCommit);
  } finally { cleanup(repo); }
});

test('resumes a durable conflicting request under a fresh fencing generation', () => {
  const repo = fixture();
  try {
    const lease = acquireLease({ repo, session: 'resume-conflict', paths: ['shared.txt'], isolation: 'worktree' });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'FIRST\nmiddle\nomega\n');
    const first = captureRequest({ repo, session: 'resume-conflict', generation: lease.generation, paths: ['shared.txt'] });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'SECOND\nmiddle\nomega\n');
    const second = captureRequest({ repo, session: 'resume-conflict', generation: lease.generation, paths: ['shared.txt'] });
    commitRequest({ repo, requestId: first.requestId, message: 'fix: first conflicting edit' });
    assert.throws(() => commitRequest({ repo, requestId: second.requestId, message: 'fix: second conflicting edit' }), /owned-path conflict/);
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'RESOLVED\nmiddle\nomega\n');
    const resumed = resumeRequest({ repo, requestId: second.requestId, message: 'fix: resume resolved edit' });
    assert.equal(resumed.resumedFrom, second.requestId);
    assert.equal(git(repo, 'show', 'HEAD:shared.txt'), 'RESOLVED\nmiddle\nomega');
    assert.equal(git(repo, 'rev-parse', second.requestRef), second.requestCommit, 'original conflict remains durable');
  } finally { cleanup(repo); }
});

test('allows parallel overlay leases on one path while fencing mutable worktree capture', () => {
  const repo = fixture();
  try {
    const first = acquireLease({ repo, session: 'overlay-a', paths: ['shared.txt'] });
    const second = acquireLease({ repo, session: 'overlay-b', paths: ['shared.txt'] });
    assert.equal(first.isolation, 'overlay');
    assert.equal(second.isolation, 'overlay');
    assert.throws(() => captureRequest({ repo, session: 'overlay-a', generation: first.generation, paths: ['shared.txt'] }), /worktree-isolated lease/);
  } finally { cleanup(repo); }
});

test('a stale concurrent release cannot delete a newer lease generation', () => {
  const repo = fixture();
  try {
    const first = acquireLease({ repo, session: 'renewed-session', paths: ['shared.txt'] });
    const second = acquireLease({ repo, session: 'renewed-session', paths: ['shared.txt'] });
    assert.ok(second.generation > first.generation);
    assert.deepEqual(releaseLease({ repo, session: 'renewed-session', generation: first.generation }), { released: false });
    assert.throws(() => acquireLease({ repo, session: 'other-worktree', paths: ['shared.txt'], isolation: 'worktree' }), /already leased by renewed-session/);
    assert.deepEqual(releaseLease({ repo, session: 'renewed-session', generation: second.generation }), { released: true });
    assert.doesNotThrow(() => acquireLease({ repo, session: 'other-worktree', paths: ['shared.txt'], isolation: 'worktree' }));
  } finally { cleanup(repo); }
});

test('keeps a durable request ref when same-line changes conflict', () => {
  const repo = fixture();
  try {
    const lease = acquireLease({ repo, session: 'conflict', paths: ['shared.txt'], isolation: 'worktree' });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'FIRST\nmiddle\nomega\n');
    const first = captureRequest({ repo, session: 'conflict', generation: lease.generation, paths: ['shared.txt'] });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'SECOND\nmiddle\nomega\n');
    const second = captureRequest({ repo, session: 'conflict', generation: lease.generation, paths: ['shared.txt'] });
    commitRequest({ repo, requestId: first.requestId, message: 'fix: first same line edit' });
    assert.throws(() => commitRequest({ repo, requestId: second.requestId, message: 'fix: second same line edit' }), /owned-path conflict/);
    assert.equal(git(repo, 'rev-parse', second.requestRef), second.requestCommit);
  } finally { cleanup(repo); }
});

test('preserves a conflicting request and rejects stale fencing tokens', () => {
  const repo = fixture();
  try {
    const first = acquireLease({ repo, session: 'same', paths: ['shared.txt'], isolation: 'worktree' });
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'FIRST\nmiddle\nomega\n');
    const request = captureRequest({ repo, session: 'same', generation: first.generation, paths: ['shared.txt'] });
    const second = acquireLease({ repo, session: 'same', paths: ['shared.txt'], isolation: 'worktree' });
    assert.throws(() => commitRequest({ repo, requestId: request.requestId, message: 'fix: stale request' }), /stale fencing token/);
    assert.ok(second.generation > first.generation);
    assert.equal(git(repo, 'rev-parse', request.requestRef), request.requestCommit);
  } finally { cleanup(repo); }
});

test('requires rename ownership and rejects symlink traversal', () => {
  const repo = fixture();
  try {
    fs.symlinkSync('/var/tmp', path.join(repo, 'escape'));
    assert.throws(() => canonicalizeOwnedPaths(repo, ['escape/file']), /symlink traversal/);
    const lease = acquireLease({ repo, session: 'rename', paths: ['shared.txt', 'renamed.txt'], isolation: 'worktree' });
    fs.renameSync(path.join(repo, 'shared.txt'), path.join(repo, 'renamed.txt'));
    const request = captureRequest({ repo, session: 'rename', generation: lease.generation, renames: [{ from: 'shared.txt', to: 'renamed.txt' }] });
    const result = commitRequest({ repo, requestId: request.requestId, message: 'refactor: rename owned file' });
    assert.deepEqual(result.changedPaths, ['renamed.txt', 'shared.txt']);
    assert.equal(git(repo, 'show', 'HEAD:renamed.txt'), 'alpha\nmiddle\nomega');
    assert.equal(git(repo, 'ls-tree', '--name-only', 'HEAD', 'shared.txt'), '');
  } finally { cleanup(repo); }
});
