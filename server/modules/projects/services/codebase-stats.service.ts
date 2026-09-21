/**
 * Bounded, fail-closed working-tree statistics (T-1169).
 *
 * The scanner reports every reason that can make a number a floor. It never
 * follows symlinks, never exposes host paths, and reads files in bounded chunks.
 */
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { Dir, Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

/**
 * One fail-closed policy boundary for paths that must never become statistics.
 * Keep generated/tool state and credential-bearing paths here rather than
 * scattering exclusions through the walker. Comparisons are case-insensitive.
 */
const POLICY_EXCLUDED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', 'dist', 'dist-server', 'build', 'out',
  'coverage', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'target',
  'vendor', '.gradle', '.idea', '.vscode', '.pnpm-store', '.worktrees',
  '.codex-tasks', 'graphify-out', 'playwright-report', 'test-results', '.nyc_output',
  'logs', 'log', 'tmp', 'temp', '.tmp', '.temp', '.nassaj-uploads', '.gemini',
  '.claude', '.cursor', '.roo', '.taskmaster', '.cline', '.windsurf', '.serena',
  '.claude-cache', '.codex-cache', '.opencode-cache', '.agy-cache', '.playwright-mcp',
  '.vite', '.netlify', '.npm', '.out', '.storybook-out', 'jspm_packages', 'wiki-audit',
  'dist-ssr', '.artifacts', '.backups',
  '.nassaj-rc',
]);

const POLICY_EXCLUDED_FILE_NAMES = new Set([
  '.envrc', '.npmrc', '.yarnrc', '.pypirc', '.netrc', '.authinfo', '.git-credentials',
  'credentials.json', 'service-account.json', 'id_rsa', 'id_ed25519',
  '.eslintcache', '.stylelintcache', '.ds_store', '.mcp.json', '.node_repl_history',
  '.yarn-integrity', 'claude.md', 'gemini.md', 'agents.md',
  '.nassaj-rc',
]);

/**
 * Credential-shaped basenames are deliberately anchored. This covers files
 * such as `secrets.production.json`, `CREDENTIALS.yaml`, and `token.txt`
 * without hiding ordinary source names such as `tokenizer.ts`,
 * `credential-form.tsx`, or `useToken.ts`.
 */
const POLICY_CREDENTIAL_BASENAME = /^(?:secrets?|credentials?|tokens?)(?:\..+)?$/;

const POLICY_EXCLUDED_FILE_EXTENSIONS = new Set([
  '.log', '.pem', '.key', '.p12', '.pfx', '.jks', '.keystore',
  '.db', '.sqlite', '.sqlite3', '.pid', '.seed', '.lcov', '.tgz', '.swp', '.swo',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.mp4', '.wav', '.mov', '.avi', '.mkv', '.webm', '.ogg',
  '.woff', '.woff2', '.ttf', '.otf', '.eot', '.so', '.dylib', '.dll',
  '.exe', '.bin', '.wasm', '.class', '.jar', '.sqlite', '.db', '.pyc',
  '.pack', '.idx',
]);

const DEFAULT_LIMITS = {
  maxFiles: 20_000,
  maxDirectories: 5_000,
  maxDirectoryEntries: 100_000,
  maxDepth: 12,
  maxLineFileBytes: 2 * 1024 * 1024,
  maxReadBytes: 64 * 1024 * 1024,
  deadlineMs: 5_000,
  readChunkBytes: 64 * 1024,
} as const;
const SCAN_TTL_MS = 60_000;
const TOP_N = 6;

export type CodebaseStatsIncompleteCode =
  | 'FILE_LIMIT'
  | 'DIRECTORY_LIMIT'
  | 'DIRECTORY_ENTRY_LIMIT'
  | 'DEPTH_LIMIT'
  | 'DIRECTORY_UNREADABLE'
  | 'FILE_STAT_FAILED'
  | 'FILE_READ_FAILED'
  | 'LINE_FILE_TOO_LARGE'
  | 'TIME_BUDGET_EXCEEDED'
  | 'READ_BYTE_BUDGET_EXCEEDED';

export type CodebaseStatsIncompleteReason = {
  code: CodebaseStatsIncompleteCode;
  count: number;
};

export type CodebaseExtensionRow = { extension: string; files: number; bytes: number };
export type CodebaseFileRow = { path: string; bytes: number; modifiedAt: number };

export type CodebaseStats = {
  totalBytes: number;
  totalLines: number;
  fileCount: number;
  linesCounted: number;
  complete: boolean;
  incompleteReasons: CodebaseStatsIncompleteReason[];
  /** Compatibility alias for older clients; FILE_LIMIT is the precise reason. */
  truncated: boolean;
  byExtension: CodebaseExtensionRow[];
  largestFiles: CodebaseFileRow[];
  recentlyModified: CodebaseFileRow[];
  scannedAt: number;
};

type ScanLimits = {
  maxFiles: number;
  maxDirectories: number;
  maxDirectoryEntries: number;
  maxDepth: number;
  maxLineFileBytes: number;
  maxReadBytes: number;
  deadlineMs: number;
  readChunkBytes: number;
};

type ScanHooks = {
  /** Deterministic root-resolution deadline seam; production never supplies this. */
  beforeCanonicalRoot?: (projectPath: string) => Promise<void> | void;
  /** Deterministic race/deadline seam; production never supplies this. */
  afterOpenDirectory?: (relativePath: string, directory: Dir) => Promise<void> | void;
  beforeOpenFile?: (relativePath: string) => Promise<void> | void;
  afterOpenFile?: (relativePath: string, handle: FileHandle) => Promise<void> | void;
  beforeReadFile?: (relativePath: string, handle: FileHandle) => Promise<void> | void;
};

type ScanOptions = {
  force?: boolean;
  limits?: Partial<ScanLimits>;
  hooks?: ScanHooks;
};

type Walker = {
  totalBytes: number;
  totalLines: number;
  fileCount: number;
  directoryCount: number;
  directoryEntryCount: number;
  linesCounted: number;
  readBytes: number;
  deadlineAt: number;
  halted: boolean;
  reasons: Map<CodebaseStatsIncompleteCode, number>;
  byExtension: Map<string, { files: number; bytes: number }>;
  files: CodebaseFileRow[];
};

type CacheEntry = { at: number; stats: CodebaseStats };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CodebaseStats>>();

/** A project root that cannot be measured is an unavailable service, not zero. */
export class CodebaseStatsUnavailableError extends Error {
  readonly code = 'CODEBASE_ROOT_UNAVAILABLE';

  constructor() {
    super('The project working tree is unavailable for statistics.');
    this.name = 'CodebaseStatsUnavailableError';
  }
}

function addReason(state: Walker, code: CodebaseStatsIncompleteCode): void {
  state.reasons.set(code, (state.reasons.get(code) ?? 0) + 1);
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function shouldExcludeDirectory(root: string, current: string, name: string): boolean {
  const normalizedName = name.toLowerCase();
  if (
    POLICY_EXCLUDED_DIRECTORIES.has(normalizedName) ||
    normalizedName.startsWith('.publish-') ||
    normalizedName.startsWith('dist.bak-') ||
    normalizedName.startsWith('dist-server.bak') ||
    normalizedName.startsWith('dist.atomic')
  ) return true;
  const parent = path.relative(root, current).split(path.sep).join('/');
  return parent === '.claude' && normalizedName === 'worktrees';
}

function shouldExcludeFile(name: string): boolean {
  const normalizedName = name.toLowerCase();
  if (
    normalizedName === '.env' ||
    normalizedName.startsWith('.env.') ||
    normalizedName.startsWith('.env-') ||
    normalizedName === '.envrc' ||
    normalizedName.startsWith('.envrc.') ||
    normalizedName.startsWith('.envrc-') ||
    normalizedName.endsWith('.env') ||
    POLICY_CREDENTIAL_BASENAME.test(normalizedName) ||
    normalizedName.endsWith('.log.gz') ||
    normalizedName.includes('.log.') ||
    normalizedName.startsWith('service-account.') ||
    (normalizedName.startsWith('ecosystem.') &&
      normalizedName.endsWith('.config.cjs') &&
      normalizedName !== 'ecosystem.config.example.cjs') ||
    normalizedName.endsWith('~') ||
    normalizedName.startsWith('._') ||
    POLICY_EXCLUDED_FILE_NAMES.has(normalizedName)
  ) return true;
  return POLICY_EXCLUDED_FILE_EXTENSIONS.has(path.extname(normalizedName));
}

function checkDeadline(state: Walker): boolean {
  if (state.halted) return false;
  if (Date.now() <= state.deadlineAt) return true;
  addReason(state, 'TIME_BUDGET_EXCEEDED');
  state.halted = true;
  return false;
}

async function withinRootDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new CodebaseStatsUnavailableError();

  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new CodebaseStatsUnavailableError()), remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function canonicalRoot(
  projectPath: string,
  deadlineAt: number,
  hooks: ScanHooks,
): Promise<string> {
  try {
    await withinRootDeadline(
      async () => hooks.beforeCanonicalRoot?.(projectPath),
      deadlineAt,
    );
    const canonical = await withinRootDeadline(() => fs.realpath(projectPath), deadlineAt);
    const rootStat = await withinRootDeadline(() => fs.stat(canonical), deadlineAt);
    await withinRootDeadline(
      () => fs.access(canonical, fsConstants.R_OK | fsConstants.X_OK),
      deadlineAt,
    );
    if (Date.now() >= deadlineAt) throw new CodebaseStatsUnavailableError();
    if (!rootStat.isDirectory()) throw new Error('not-directory');
    return canonical;
  } catch {
    throw new CodebaseStatsUnavailableError();
  }
}

async function canonicalDirectory(
  root: string,
  current: string,
  state: Walker,
  isRoot: boolean,
): Promise<string | null> {
  try {
    const entryStat = await fs.lstat(current);
    if (!checkDeadline(state)) return null;
    const canonical = await fs.realpath(current);
    if (!checkDeadline(state)) return null;
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory() || !isContained(root, canonical)) {
      throw new Error('unsafe-directory');
    }
    return canonical;
  } catch {
    if (!checkDeadline(state)) return null;
    if (isRoot) throw new CodebaseStatsUnavailableError();
    addReason(state, 'DIRECTORY_UNREADABLE');
    return null;
  }
}

async function openedPathIsContained(
  root: string,
  handle: FileHandle,
  state: Walker,
): Promise<boolean> {
  if (process.platform !== 'linux') return true;
  try {
    const openedPath = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    if (!checkDeadline(state)) return false;
    return isContained(root, openedPath);
  } catch {
    // Linux gives us an authoritative descriptor target. Failure is unsafe.
    checkDeadline(state);
    return false;
  }
}

function sameInode(
  before: Stats,
  after: Stats,
): boolean {
  return before.dev === after.dev && before.ino === after.ino;
}

async function openContainedFile(
  root: string,
  absolute: string,
  relative: string,
  state: Walker,
  hooks: ScanHooks,
): Promise<{ handle: FileHandle; stat: Stats } | null> {
  let handle: FileHandle | undefined;
  let keepHandle = false;
  try {
    const before = await fs.lstat(absolute);
    if (!checkDeadline(state)) return null;
    if (before.isSymbolicLink() || !before.isFile()) return null;
    const resolved = await fs.realpath(absolute);
    if (!checkDeadline(state)) return null;
    if (!isContained(root, resolved)) return null;
    await hooks.beforeOpenFile?.(relative);
    if (!checkDeadline(state)) return null;
    handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    if (!checkDeadline(state)) return null;
    await hooks.afterOpenFile?.(relative, handle);
    if (!checkDeadline(state)) return null;
    const after = await handle.stat();
    if (!checkDeadline(state)) return null;
    if (!after.isFile() || !sameInode(before, after)) return null;
    if (!(await openedPathIsContained(root, handle, state))) return null;
    if (!checkDeadline(state)) return null;
    keepHandle = true;
    return { handle, stat: after };
  } catch {
    checkDeadline(state);
    return null;
  } finally {
    if (handle && !keepHandle) {
      try {
        await handle.close();
      } catch {
        // The descriptor may have been closed by a deterministic test hook.
      }
      checkDeadline(state);
    }
  }
}

async function countLines(
  handle: FileHandle,
  size: number,
  state: Walker,
  limits: ScanLimits,
): Promise<number | null> {
  if (size === 0) return 0;
  const buffer = Buffer.alloc(Math.min(limits.readChunkBytes, limits.maxReadBytes));
  let offset = 0;
  let lines = 0;
  let lastByte = -1;
  while (offset < size) {
    if (!checkDeadline(state)) return null;
    const remainingBudget = limits.maxReadBytes - state.readBytes;
    if (remainingBudget <= 0) {
      addReason(state, 'READ_BYTE_BUDGET_EXCEEDED');
      state.halted = true;
      return null;
    }
    const length = Math.min(buffer.length, size - offset, remainingBudget);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) return null;
    state.readBytes += bytesRead;
    if (!checkDeadline(state)) return null;
    for (let index = 0; index < bytesRead; index += 1) {
      if (buffer[index] === 0x0a) lines += 1;
    }
    lastByte = buffer[bytesRead - 1];
    offset += bytesRead;
  }
  return lastByte === 0x0a ? lines : lines + 1;
}

function recordFile(
  root: string,
  absolute: string,
  stat: Stats,
  state: Walker,
): string {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const extension = path.extname(relative).toLowerCase() || '(none)';
  state.fileCount += 1;
  state.totalBytes += stat.size;
  const bucket = state.byExtension.get(extension) ?? { files: 0, bytes: 0 };
  bucket.files += 1;
  bucket.bytes += stat.size;
  state.byExtension.set(extension, bucket);
  state.files.push({ path: relative, bytes: stat.size, modifiedAt: stat.mtimeMs });
  return extension;
}

async function measureFile(
  root: string,
  absolute: string,
  state: Walker,
  limits: ScanLimits,
  hooks: ScanHooks,
): Promise<void> {
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  const opened = await openContainedFile(root, absolute, relative, state, hooks);
  if (!opened) {
    if (!state.halted) addReason(state, 'FILE_STAT_FAILED');
    return;
  }
  try {
    if (!checkDeadline(state)) return;
    const extension = recordFile(root, absolute, opened.stat, state);
    if (BINARY_EXTENSIONS.has(extension)) return;
    if (opened.stat.size > limits.maxLineFileBytes) {
      addReason(state, 'LINE_FILE_TOO_LARGE');
      return;
    }
    await hooks.beforeReadFile?.(relative, opened.handle);
    if (!checkDeadline(state)) return;
    const lines = await countLines(opened.handle, opened.stat.size, state, limits);
    if (lines === null) {
      if (!state.halted) addReason(state, 'FILE_READ_FAILED');
      return;
    }
    state.totalLines += lines;
    state.linesCounted += 1;
  } catch {
    if (checkDeadline(state)) addReason(state, 'FILE_READ_FAILED');
  } finally {
    try {
      await opened.handle.close();
    } catch {
      // A failed/previous close must not turn a bounded partial scan into 503.
    }
    checkDeadline(state);
  }
}

async function walk(
  root: string,
  current: string,
  depth: number,
  state: Walker,
  limits: ScanLimits,
  hooks: ScanHooks,
): Promise<void> {
  if (!checkDeadline(state)) return;
  if (state.directoryCount >= limits.maxDirectories) {
    addReason(state, 'DIRECTORY_LIMIT');
    state.halted = true;
    return;
  }
  const canonical = await canonicalDirectory(root, current, state, depth === 0);
  if (!canonical) return;
  if (!checkDeadline(state)) return;
  let directory: Dir | undefined;
  try {
    directory = await fs.opendir(canonical);
    if (!checkDeadline(state)) return;
    const relativeDirectory = path.relative(root, canonical).split(path.sep).join('/') || '.';
    await hooks.afterOpenDirectory?.(relativeDirectory, directory);
    if (!checkDeadline(state)) return;
    state.directoryCount += 1;

    while (true) {
      const entry = await directory.read();
      if (!checkDeadline(state)) return;
      if (entry === null) return;
      if (state.directoryEntryCount >= limits.maxDirectoryEntries) {
        addReason(state, 'DIRECTORY_ENTRY_LIMIT');
        state.halted = true;
        return;
      }
      state.directoryEntryCount += 1;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(canonical, entry.name);
      if (entry.isDirectory()) {
        if (shouldExcludeDirectory(root, canonical, entry.name)) continue;
        if (depth >= limits.maxDepth) addReason(state, 'DEPTH_LIMIT');
        else {
          await walk(root, absolute, depth + 1, state, limits, hooks);
          if (!checkDeadline(state)) return;
        }
        continue;
      }
      if (!entry.isFile() || shouldExcludeFile(entry.name)) continue;
      if (state.fileCount >= limits.maxFiles) {
        addReason(state, 'FILE_LIMIT');
        state.halted = true;
        return;
      }
      await measureFile(root, absolute, state, limits, hooks);
      if (!checkDeadline(state)) return;
    }
  } catch {
    if (!checkDeadline(state)) return;
    if (depth === 0) throw new CodebaseStatsUnavailableError();
    addReason(state, 'DIRECTORY_UNREADABLE');
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // A closed iterator or failed directory has no remaining resource.
      }
      checkDeadline(state);
    }
  }
}

function resolveLimits(overrides: Partial<ScanLimits> = {}): ScanLimits {
  const merged = { ...DEFAULT_LIMITS, ...overrides };
  return {
    maxFiles: Math.max(1, Math.trunc(merged.maxFiles)),
    maxDirectories: Math.max(1, Math.trunc(merged.maxDirectories)),
    maxDirectoryEntries: Math.max(1, Math.trunc(merged.maxDirectoryEntries)),
    maxDepth: Math.max(0, Math.trunc(merged.maxDepth)),
    maxLineFileBytes: Math.max(1, Math.trunc(merged.maxLineFileBytes)),
    maxReadBytes: Math.max(1, Math.trunc(merged.maxReadBytes)),
    deadlineMs: Math.max(1, Math.trunc(merged.deadlineMs)),
    readChunkBytes: Math.max(1, Math.trunc(merged.readChunkBytes)),
  };
}

function newWalker(limits: ScanLimits, deadlineAt: number): Walker {
  return {
    totalBytes: 0,
    totalLines: 0,
    fileCount: 0,
    directoryCount: 0,
    directoryEntryCount: 0,
    linesCounted: 0,
    readBytes: 0,
    deadlineAt,
    halted: false,
    reasons: new Map(),
    byExtension: new Map(),
    files: [],
  };
}

function buildStats(state: Walker, scannedAt: number): CodebaseStats {
  const incompleteReasons = [...state.reasons.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => left.code.localeCompare(right.code));
  return {
    totalBytes: state.totalBytes,
    totalLines: state.totalLines,
    fileCount: state.fileCount,
    linesCounted: state.linesCounted,
    complete: incompleteReasons.length === 0,
    incompleteReasons,
    truncated: state.reasons.has('FILE_LIMIT'),
    byExtension: [...state.byExtension.entries()]
      .map(([extension, bucket]) => ({ extension, ...bucket }))
      .sort((left, right) => right.files - left.files || right.bytes - left.bytes)
      .slice(0, TOP_N + 2),
    largestFiles: [...state.files].sort((a, b) => b.bytes - a.bytes).slice(0, TOP_N),
    recentlyModified: [...state.files].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, TOP_N),
    scannedAt,
  };
}

async function scan(
  canonical: string,
  options: ScanOptions,
  limits: ScanLimits,
  deadlineAt: number,
): Promise<CodebaseStats> {
  const state = newWalker(limits, deadlineAt);
  await walk(canonical, canonical, 0, state, limits, options.hooks ?? {});
  checkDeadline(state);
  return buildStats(state, Date.now());
}

/** Scan, cache by canonical path, and collapse all concurrent scans per project. */
export async function getCodebaseStats(
  projectPath: string,
  options: ScanOptions = {},
): Promise<CodebaseStats> {
  const limits = resolveLimits(options.limits);
  const deadlineAt = Date.now() + limits.deadlineMs;
  const canonical = await canonicalRoot(projectPath, deadlineAt, options.hooks ?? {});
  const active = inFlight.get(canonical);
  if (active) return active;

  const now = Date.now();
  const useProductionCache = options.limits === undefined && options.hooks === undefined;
  const cached = cache.get(canonical);
  if (useProductionCache && !options.force && cached && now - cached.at < SCAN_TTL_MS) {
    return cached.stats;
  }

  const pending = scan(canonical, options, limits, deadlineAt);
  inFlight.set(canonical, pending);
  try {
    const stats = await pending;
    if (useProductionCache) cache.set(canonical, { at: Date.now(), stats });
    return stats;
  } finally {
    if (inFlight.get(canonical) === pending) inFlight.delete(canonical);
  }
}

/** Test seam — clears memoized answers after fixture changes. */
export function clearCodebaseStatsCache(): void {
  cache.clear();
}
