/**
 * B-738: Claude's spawn uses per-user CLAUDE_CONFIG_DIR, so transcript discovery
 * and live watching must use those same homes rather than only ~/.claude.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FSWatcher } from 'chokidar';

const sandbox = fs.mkdtempSync('/var/tmp/nassaj-claude-session-iso-');
const originalHome = process.env.HOME;
const originalDatabasePath = process.env.DATABASE_PATH;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalHomedir = os.homedir;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
const operatorClaudeTarget = path.join(sandbox, 'operator-claude-target');
fs.mkdirSync(operatorClaudeTarget, { recursive: true });
fs.symlinkSync(operatorClaudeTarget, path.join(sandboxHome, '.claude'));
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
delete process.env.CLAUDE_CONFIG_DIR;
(os as { homedir: () => string }).homedir = () => sandboxHome;

const { closeConnection, getConnection, initializeDatabase, scanStateDb, sessionsDb } = await import(
  '@/modules/database/index.js'
);
const { setProviderSharingConfig, _resetProviderSharingCache } = await import(
  '@/services/provider-sharing.js'
);
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const { operatorClaudeHome, resolveClaudeHomeForUser, resolveClaudeHomes } = await import(
  '@/modules/providers/list/claude/claude-home.js'
);
const { ClaudeSessionSynchronizer } = await import(
  '@/modules/providers/list/claude/claude-session-synchronizer.provider.js'
);
const { closeSessionsWatcher, initializeSessionsWatcher } = await import(
  '@/modules/providers/services/sessions-watcher.service.js'
);

await initializeDatabase();

const USER_ID = 8738;
getConnection().prepare("INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, 'x')")
  .run(USER_ID, 'claude-isolation-user');

_resetProviderSharingCache();
setProviderSharingConfig({
  claude: 'isolated', codex: 'shared', agy: 'shared', cursor: 'shared', opencode: 'shared',
});

after(async () => {
  await closeSessionsWatcher();
  closeConnection();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  (os as { homedir: () => string }).homedir = originalHomedir;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeTranscript(home: string, sessionId: string, display?: string): string {
  const projectsDir = path.join(home, 'projects', '-workspace-demo');
  fs.mkdirSync(projectsDir, { recursive: true });
  if (display) {
    fs.writeFileSync(path.join(home, 'history.jsonl'), `${JSON.stringify({ sessionId, display })}\n`);
  }
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, `${JSON.stringify({ sessionId, cwd: '/workspace/demo', type: 'user' })}\n`);
  return filePath;
}

describe('Claude session paths honor CLAUDE_CONFIG_DIR (B-738)', () => {
  it('resolves isolated homes while anonymous/shared fallback remains the operator home', () => {
    const isolatedHome = userConfigDir(USER_ID, '.claude');
    assert.equal(resolveClaudeHomeForUser(USER_ID), isolatedHome);
    assert.equal(resolveClaudeHomeForUser(null), operatorClaudeHome());
    assert.deepEqual(new Set(resolveClaudeHomes()), new Set([operatorClaudeHome(), isolatedHome]));
  });

  it('indexes an isolated transcript with its matching history index and preserves operator discovery', async () => {
    const isolatedHome = userConfigDir(USER_ID, '.claude');
    const isolatedFile = writeTranscript(isolatedHome, 'claude-isolated-session', 'Isolated Claude title');
    writeTranscript(operatorClaudeHome(), 'claude-operator-session', 'Operator Claude title');

    const processed = await new ClaudeSessionSynchronizer().synchronize();
    assert.ok(processed >= 2);
    const isolated = sessionsDb.getSessionById('claude-isolated-session');
    assert.equal(isolated?.jsonl_path, isolatedFile);
    assert.equal(isolated?.custom_name, 'Isolated Claude title');
    assert.ok(sessionsDb.getSessionById('claude-operator-session'));
  });

  it('repairs a pre-existing null jsonl_path from an older transcript through a symlinked Claude root', async () => {
    const sessionId = 'claude-stale-null-path';
    const operatorHome = operatorClaudeHome();
    writeTranscript(operatorHome, sessionId, 'Recovered from transcript');
    // Reproduce the reported state: an old scan cursor and a DB row created
    // without the transcript path. The operator home used by discovery is a
    // real symlink, matching the clustered deployment layout.
    scanStateDb.updateLastScannedAt(new Date(Date.now() + 60_000));
    sessionsDb.createSession(sessionId, 'claude', '/workspace/demo');

    const processed = await new ClaudeSessionSynchronizer().synchronize();
    assert.ok(processed >= 1);
    const repaired = sessionsDb.getSessionById(sessionId);
    assert.equal(repaired?.jsonl_path, path.join(operatorHome, 'projects', '-workspace-demo', `${sessionId}.jsonl`));
    assert.equal(repaired?.custom_name, 'Recovered from transcript');
  });

  it('scans a projects tree shared through an isolated-user symlink only once', async () => {
    const operatorProjects = path.join(operatorClaudeHome(), 'projects');
    const isolatedProjects = path.join(userConfigDir(USER_ID, '.claude'), 'projects');
    fs.rmSync(operatorProjects, { recursive: true, force: true });
    fs.mkdirSync(operatorProjects, { recursive: true });
    fs.rmSync(isolatedProjects, { recursive: true, force: true });
    fs.symlinkSync(operatorProjects, isolatedProjects);
    writeTranscript(operatorClaudeHome(), 'claude-shared-physical-root', 'One physical tree');

    const processed = await new ClaudeSessionSynchronizer().synchronize();
    assert.equal(processed, 1, 'a shared projects symlink must not multiply one transcript per user');
  });

  it('watches both the operator and isolated Claude projects roots', async () => {
    class FakeWatcher extends EventEmitter {
      closed = 0;
      async close(): Promise<void> { this.closed += 1; }
    }
    const roots: string[] = [];
    const created: FakeWatcher[] = [];
    await initializeSessionsWatcher({
      ensureRoot: async () => undefined,
      watch: ((rootPath: string) => {
        roots.push(rootPath);
        const watcher = new FakeWatcher();
        created.push(watcher);
        queueMicrotask(() => watcher.emit('ready'));
        return watcher as unknown as FSWatcher;
      }) as never,
      requestSynchronization: () => undefined,
      scheduleUsageIngestion: async () => undefined,
      startUsageBackfill: async () => undefined,
      resumeUsageBackfill: async () => undefined,
    });
    const sharedPhysicalRoot = fs.realpathSync(path.join(operatorClaudeHome(), 'projects'));
    assert.equal(
      fs.realpathSync(path.join(userConfigDir(USER_ID, '.claude'), 'projects')),
      sharedPhysicalRoot,
      'fixture models provisioning’s shared projects symlink',
    );
    assert.equal(
      roots.filter((root) => root === sharedPhysicalRoot).length,
      1,
      'operator and isolated symlink aliases create one watcher for one physical root',
    );
    await closeSessionsWatcher();
    assert.equal(created.filter((watcher) => watcher.closed === 1).length, created.length);
  });

  it('normalizes a symlink root and starts initial synchronization before watcher readiness', async () => {
    class FakeWatcher extends EventEmitter {
      async close(): Promise<void> {}
    }
    const actualRoot = path.join(sandbox, 'claude-projects-target');
    const symlinkRoot = path.join(sandbox, 'claude-projects-link');
    fs.mkdirSync(actualRoot, { recursive: true });
    fs.symlinkSync(actualRoot, symlinkRoot);

    let watchedRoot: string | undefined;
    let watcher: FakeWatcher | undefined;
    let synchronizationRequests = 0;
    const initializing = initializeSessionsWatcher({
      targets: [{ provider: 'claude', rootPath: symlinkRoot }],
      ensureRoot: async () => undefined,
      watch: ((rootPath: string) => {
        watchedRoot = rootPath;
        watcher = new FakeWatcher();
        return watcher as unknown as FSWatcher;
      }) as never,
      requestSynchronization: () => { synchronizationRequests += 1; },
      scheduleUsageIngestion: async () => undefined,
      startUsageBackfill: async () => undefined,
      resumeUsageBackfill: async () => undefined,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    assert.equal(watchedRoot, fs.realpathSync(actualRoot));
    assert.equal(synchronizationRequests, 1);
    watcher?.emit('ready');
    await initializing;
    await closeSessionsWatcher();
  });
});
