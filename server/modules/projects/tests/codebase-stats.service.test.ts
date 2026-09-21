/** Filesystem-adversarial tests for the bounded codebase scanner (T-1169). */
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  existsSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const {
  CodebaseStatsUnavailableError,
  clearCodebaseStatsCache,
  getCodebaseStats,
} = await import('../services/codebase-stats.service.js');

const temporaryPaths = new Set<string>();

function temp(prefix = 'codebase-stats-'): string {
  const created = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryPaths.add(created);
  return created;
}

function reasonCount(
  stats: Awaited<ReturnType<typeof getCodebaseStats>>,
  code: string,
): number {
  return stats.incompleteReasons.find((reason) => reason.code === code)?.count ?? 0;
}

afterEach(() => {
  clearCodebaseStatsCache();
  for (const temporaryPath of temporaryPaths) {
    try {
      chmodSync(temporaryPath, 0o700);
      rmSync(temporaryPath, { recursive: true, force: true });
    } catch {
      // A nested permission fixture may survive its first removal attempt.
      rmSync(temporaryPath, { recursive: true, force: true });
    }
  }
  temporaryPaths.clear();
});

describe('codebase-stats service', () => {
  it('counts the project tree completely without following skipped or symlinked trees', async () => {
    const root = temp();
    const outside = temp('codebase-outside-');
    writeFileSync(path.join(root, 'index.ts'), 'a\nb\nc\n');
    writeFileSync(path.join(root, 'README.md'), '# title');
    writeFileSync(path.join(root, 'logo.png'), Buffer.alloc(2_048, 0x0a));
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored\n');
    for (const generatedDir of [
      '.worktrees/branch',
      '.codex-tasks',
      '.claude/worktrees/branch',
      '.publish-release.abc',
      'dist-server',
      'dist-server.bak-20260731',
      'dist-server.bak-previous',
      'dist.atomic.predeploy-previous-123',
      'dist.bak-20260731',
      '.artifacts',
      '.backups',
      'graphify-out',
      'playwright-report',
      'test-results',
    ]) {
      mkdirSync(path.join(root, generatedDir), { recursive: true });
      writeFileSync(path.join(root, generatedDir, 'generated.log'), 'ignored\n'.repeat(100));
    }
    writeFileSync(path.join(outside, 'secret.ts'), 'secret\n'.repeat(100));
    symlinkSync(outside, path.join(root, 'linked'), 'dir');

    const stats = await getCodebaseStats(root, { force: true });

    assert.equal(stats.complete, true);
    assert.deepEqual(stats.incompleteReasons, []);
    assert.equal(stats.fileCount, 3);
    assert.equal(stats.totalLines, 4);
    assert.equal(stats.linesCounted, 2);
    const rows = [...stats.largestFiles, ...stats.recentlyModified];
    assert.ok(rows.every((row) => !path.isAbsolute(row.path) && !row.path.includes('..')));
    assert.ok(rows.every((row) => !row.path.includes('secret')));
  });

  it('reports file and depth caps instead of presenting partial figures as complete', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'a.ts'), 'a\n');
    writeFileSync(path.join(root, 'b.ts'), 'b\n');
    mkdirSync(path.join(root, 'deep'));
    writeFileSync(path.join(root, 'deep', 'c.ts'), 'c\n');

    const fileLimited = await getCodebaseStats(root, {
      force: true,
      limits: { maxFiles: 1 },
    });
    const depthLimited = await getCodebaseStats(root, {
      force: true,
      limits: { maxDepth: 0 },
    });

    assert.equal(fileLimited.complete, false);
    assert.equal(fileLimited.truncated, true);
    assert.ok(reasonCount(fileLimited, 'FILE_LIMIT') > 0);
    assert.equal(depthLimited.complete, false);
    assert.ok(reasonCount(depthLimited, 'DEPTH_LIMIT') > 0);
  });

  it('streams large directories with independent entry and directory budgets', async () => {
    const entryRoot = temp();
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(path.join(entryRoot, `entry-${index}.ts`), 'line\n');
    }
    const entryLimited = await getCodebaseStats(entryRoot, {
      force: true,
      limits: { maxDirectoryEntries: 7 },
    });

    const directoryRoot = temp();
    for (let index = 0; index < 8; index += 1) {
      mkdirSync(path.join(directoryRoot, `dir-${index}`));
      writeFileSync(path.join(directoryRoot, `dir-${index}`, 'index.ts'), 'line\n');
    }
    const directoryLimited = await getCodebaseStats(directoryRoot, {
      force: true,
      limits: { maxDirectories: 1 },
    });

    assert.equal(entryLimited.complete, false);
    assert.ok(entryLimited.fileCount <= 7);
    assert.ok(reasonCount(entryLimited, 'DIRECTORY_ENTRY_LIMIT') > 0);
    assert.equal(directoryLimited.complete, false);
    assert.equal(directoryLimited.fileCount, 0);
    assert.ok(reasonCount(directoryLimited, 'DIRECTORY_LIMIT') > 0);
  });

  it('centrally excludes ignored outputs, tool state, runtime data, and credential files', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'visible.ts'), 'visible\n');
    for (const innocentSource of ['tokenizer.ts', 'credential-form.tsx', 'useToken.ts']) {
      writeFileSync(path.join(root, innocentSource), 'visible\n');
    }
    const excludedFiles = [
      '.env', '.env.local', '.env.bak-20260811', '.envrc', '.ENVRC.local',
      'config/.nassaj-rc',
      'production.env', 'trace.log', 'trace.log.1', 'credentials.json',
      'CREDENTIALS.production.yaml', 'secrets.toml', 'Secrets.backup.json',
      'token.txt', 'TOKEN.production.json', 'service-account.production.json', 'private.pem',
      'database.sqlite', 'process.pid', 'ecosystem.node.config.cjs',
    ];
    mkdirSync(path.join(root, 'config'), { recursive: true });
    for (const excludedFile of excludedFiles) {
      writeFileSync(path.join(root, excludedFile), 'must not surface\n'.repeat(100));
    }
    for (const excludedDirectory of [
      'logs', 'tmp', '.nassaj-uploads', '.gemini', '.claude', '.worktrees',
      'dist', 'dist-server', 'dist-ssr', 'coverage', '.vite', '.playwright-mcp',
      '.artifacts', '.backups', 'dist-server.bak-20260811',
      'dist-server.bak-previous', 'dist.atomic.predeploy-previous-123',
      '.nassaj-rc/runtime-cache',
    ]) {
      mkdirSync(path.join(root, excludedDirectory), { recursive: true });
      writeFileSync(path.join(root, excludedDirectory, 'artifact.txt'), 'must not surface\n'.repeat(100));
    }

    const stats = await getCodebaseStats(root, { force: true });
    const surfacedPaths = [...stats.largestFiles, ...stats.recentlyModified].map((row) => row.path);

    assert.equal(stats.complete, true);
    assert.equal(stats.fileCount, 4);
    assert.equal(stats.totalLines, 4);
    assert.equal(stats.totalBytes, 32);
    assert.ok(excludedFiles.every((filePath) => !surfacedPaths.includes(filePath)));
    assert.ok(surfacedPaths.includes('tokenizer.ts'));
    assert.ok(surfacedPaths.includes('credential-form.tsx'));
  });

  it('reports unreadable directories while keeping safe sibling measurements', async () => {
    const root = temp();
    const denied = path.join(root, 'denied');
    writeFileSync(path.join(root, 'visible.ts'), 'visible\n');
    mkdirSync(denied);
    writeFileSync(path.join(denied, 'hidden.ts'), 'hidden\n');
    chmodSync(denied, 0o000);

    const stats = await getCodebaseStats(root, { force: true });
    chmodSync(denied, 0o700);

    if (typeof process.getuid === 'function' && process.getuid() === 0) return;
    assert.equal(stats.fileCount, 1);
    assert.ok(reasonCount(stats, 'DIRECTORY_UNREADABLE') > 0);
    assert.equal(stats.complete, false);
  });

  it('fails closed when a file is swapped to an external symlink before open', async () => {
    const root = temp();
    const outside = temp('codebase-outside-');
    const candidate = path.join(root, 'race.txt');
    const secret = path.join(outside, 'secret.txt');
    writeFileSync(candidate, 'safe\n');
    writeFileSync(secret, 'outside\n'.repeat(50));

    const stats = await getCodebaseStats(root, {
      force: true,
      hooks: {
        beforeOpenFile: (relativePath) => {
          if (relativePath !== 'race.txt') return;
          unlinkSync(candidate);
          symlinkSync(secret, candidate, 'file');
        },
      },
    });

    assert.equal(stats.fileCount, 0);
    assert.equal(stats.totalLines, 0);
    assert.ok(reasonCount(stats, 'FILE_STAT_FAILED') > 0);
    assert.ok(stats.largestFiles.every((row) => !row.path.includes('secret')));
  });

  it('reports a read failure and does not count a partially read file', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'broken.txt'), 'one\ntwo\n');

    const stats = await getCodebaseStats(root, {
      force: true,
      hooks: { beforeReadFile: async (_relativePath, handle) => handle.close() },
    });

    assert.equal(stats.fileCount, 1);
    assert.equal(stats.linesCounted, 0);
    assert.equal(stats.totalLines, 0);
    assert.ok(reasonCount(stats, 'FILE_READ_FAILED') > 0);
  });

  it('does not read huge text files and names the omitted line total', async () => {
    const root = temp();
    const huge = path.join(root, 'huge.txt');
    writeFileSync(huge, 'prefix\n');
    truncateSync(huge, 8 * 1024 * 1024);

    const stats = await getCodebaseStats(root, {
      force: true,
      limits: { maxLineFileBytes: 1_024 },
    });

    assert.equal(stats.fileCount, 1);
    assert.equal(stats.linesCounted, 0);
    assert.equal(stats.totalBytes, 8 * 1024 * 1024);
    assert.ok(reasonCount(stats, 'LINE_FILE_TOO_LARGE') > 0);
  });

  it('stops on total read-byte and deadline budgets with explicit reasons', async () => {
    const byteRoot = temp();
    writeFileSync(path.join(byteRoot, 'bytes.txt'), '123456789\n');
    const byteLimited = await getCodebaseStats(byteRoot, {
      force: true,
      limits: { maxReadBytes: 3, readChunkBytes: 2 },
    });

    const timeRoot = temp();
    writeFileSync(path.join(timeRoot, 'time.txt'), 'time\n');
    const timeLimited = await getCodebaseStats(timeRoot, {
      force: true,
      limits: { deadlineMs: 5 },
      hooks: { beforeOpenFile: () => new Promise((resolve) => setTimeout(resolve, 15)) },
    });

    assert.ok(reasonCount(byteLimited, 'READ_BYTE_BUDGET_EXCEEDED') > 0);
    assert.equal(byteLimited.linesCounted, 0);
    assert.ok(reasonCount(timeLimited, 'TIME_BUDGET_EXCEEDED') > 0);
    assert.equal(timeLimited.linesCounted, 0);
  });

  it('checks deadlines immediately after opening directories and files', async (t) => {
    // Freeze both deadline clocks while real filesystem operations complete.
    // Advance only at the post-open seam so root resolution cannot time out first.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
    const deadlineMs = 5;
    const directoryRoot = temp();
    writeFileSync(path.join(directoryRoot, 'never-counted.ts'), 'line\n');
    let openedDirectory: import('node:fs').Dir | undefined;
    let directoryReads = 0;
    const directoryTimedOut = await getCodebaseStats(directoryRoot, {
      force: true,
      limits: { deadlineMs },
      hooks: {
        afterOpenDirectory: (_relativePath, directory) => {
          openedDirectory = directory;
          const read = directory.read.bind(directory);
          t.mock.method(directory, 'read', () => {
            directoryReads += 1;
            return read();
          });
          t.mock.timers.tick(deadlineMs + 1);
        },
      },
    });

    assert.ok(openedDirectory, 'the directory was opened before the deadline expired');
    assert.equal(directoryReads, 0, 'the expired directory is never read');
    assert.equal(directoryTimedOut.fileCount, 0);
    assert.ok(reasonCount(directoryTimedOut, 'TIME_BUDGET_EXCEEDED') > 0);
    await assert.rejects(openedDirectory.read(), { code: 'ERR_DIR_CLOSED' });

    const fileRoot = temp();
    writeFileSync(path.join(fileRoot, 'never-recorded.ts'), 'line\n');
    let openedFile: import('node:fs/promises').FileHandle | undefined;
    let fileStats = 0;
    const fileTimedOut = await getCodebaseStats(fileRoot, {
      force: true,
      limits: { deadlineMs },
      hooks: {
        afterOpenFile: (_relativePath, handle) => {
          openedFile = handle;
          const stat = handle.stat.bind(handle);
          t.mock.method(handle, 'stat', () => {
            fileStats += 1;
            return stat();
          });
          t.mock.timers.tick(deadlineMs + 1);
        },
      },
    });

    assert.ok(openedFile, 'the file was opened before the deadline expired');
    assert.equal(fileStats, 0, 'the expired file is never statted');
    assert.equal(fileTimedOut.fileCount, 0);
    assert.ok(reasonCount(fileTimedOut, 'TIME_BUDGET_EXCEEDED') > 0);
    assert.equal(openedFile.fd, -1, 'timed-out file handle is closed');
    await assert.rejects(openedFile.stat(), { code: 'EBADF' });
  });

  it('closes an opened file handle when a post-open check throws', async () => {
    const root = temp();
    writeFileSync(path.join(root, 'failure.ts'), 'line\n');
    let openedDescriptor = -1;

    const stats = await getCodebaseStats(root, {
      force: true,
      hooks: {
        afterOpenFile: (_relativePath, handle) => {
          openedDescriptor = handle.fd;
          throw new Error('injected post-open failure');
        },
      },
    });

    assert.equal(stats.fileCount, 0);
    assert.ok(reasonCount(stats, 'FILE_STAT_FAILED') > 0);
    if (process.platform === 'linux') {
      assert.equal(existsSync(`/proc/self/fd/${openedDescriptor}`), false, 'failed file handle is closed');
    }
  });

  it('deduplicates concurrent forced scans and canonical path aliases', async () => {
    const root = temp();
    const aliasParent = temp('codebase-alias-');
    const alias = path.join(aliasParent, 'project-link');
    writeFileSync(path.join(root, 'one.ts'), 'one\n');
    symlinkSync(root, alias, 'dir');
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let opens = 0;
    const options = {
      force: true,
      hooks: { beforeOpenFile: async () => { opens += 1; await gate; } },
    };

    const first = getCodebaseStats(root, options);
    await new Promise((resolve) => setImmediate(resolve));
    const second = getCodebaseStats(alias, options);
    release?.();
    const [firstStats, secondStats] = await Promise.all([first, second]);

    assert.equal(opens, 1);
    assert.strictEqual(firstStats, secondStats);
  });

  it('throws a structured unavailable error when the project root is gone', async () => {
    const root = temp();
    rmSync(root, { recursive: true, force: true });
    temporaryPaths.delete(root);

    await assert.rejects(
      () => getCodebaseStats(root, { force: true }),
      (error: unknown) =>
        error instanceof CodebaseStatsUnavailableError &&
        error.code === 'CODEBASE_ROOT_UNAVAILABLE',
    );
  });

  it('bounds canonical root resolution inside the original scan deadline', { timeout: 500 }, async () => {
    const root = temp();
    writeFileSync(path.join(root, 'never-scanned.ts'), 'line\n');
    const startedAt = Date.now();

    await assert.rejects(
      () => getCodebaseStats(root, {
        force: true,
        limits: { deadlineMs: 10 },
        hooks: {
          beforeCanonicalRoot: () => new Promise<never>(() => {}),
        },
      }),
      (error: unknown) =>
        error instanceof CodebaseStatsUnavailableError &&
        error.code === 'CODEBASE_ROOT_UNAVAILABLE',
    );

    assert.ok(Date.now() - startedAt < 250, 'root resolution timeout must not await the stuck operation');
  });
});
