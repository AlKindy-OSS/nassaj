import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { promises as fs } from 'fs';
import { projectsDb } from '../modules/database/index.js';
import { queryClaudeSDK } from '../claude-sdk.js';
import { spawnCursor } from '../cursor-cli.js';
import { buildGitAuthorEnv, getUserGithubToken, buildTokenPushUrl } from '../utils/gitIdentity.js';
import { coerceUserId } from '../modules/projects/services/project-visibility-guard.service.js';
import { isResolvedPathInsideRootReal } from '../utils/path-guard.js';

const router = express.Router();
const COMMIT_DIFF_CHARACTER_LIMIT = 500_000;

/**
 * Credential redaction for anything derived from a git invocation (B-GIT-SEC-3).
 *
 * Push credentials reach git as a token-embedded https URL
 * (`https://<token>@github.com/...`). Any string derived from a failed git run —
 * the Error message, stderr, stdout — can therefore carry a live GitHub PAT, and
 * this router both LOGS those strings and returns them to the client as
 * `details`. Every such string is passed through here first, so a token can
 * never reach a log line or an HTTP response body.
 *
 * Two patterns:
 *   1. userinfo in any `scheme://user[:pass]@host` URL  -> `scheme://***@host`
 *      (an email address is untouched: it has no scheme prefix).
 *   2. bare GitHub token shapes (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_) -> `***`,
 *      covering a token that appears outside a URL.
 */
const CREDENTIAL_IN_URL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g;
const BARE_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

export function redactCredentials(text) {
  if (typeof text !== 'string' || text === '') {
    return '';
  }
  return text
    .replace(CREDENTIAL_IN_URL_PATTERN, '$1***@')
    .replace(BARE_TOKEN_PATTERN, '***');
}

export function spawnAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      // SECURITY (B-GIT-SEC-3): the argv is NEVER embedded in the message —
      // push argv used to carry `https://<PAT>@github.com/...`, and this message
      // is both logged and returned to the client as `details`. Only the command
      // name and the exit code are safe to expose; the actual git diagnostics
      // live in `stderr` (redacted below), which the error branches now read.
      const error = new Error(`Command failed: ${command} (exit code ${code})`);
      error.code = code;
      error.stdout = redactCredentials(stdout);
      error.stderr = redactCredentials(stderr);
      reject(error);
    });
  });
}

/**
 * Resolves the per-user push credentials for a remote (B-MU-UX-GIT-ID), handed
 * to git through the ENVIRONMENT instead of argv (B-GIT-SEC-3).
 *
 * WHY NOT argv ANY MORE
 * ---------------------
 * The previous implementation returned `https://<PAT>@github.com/...` and the
 * callers passed it as a positional argument to `git push`. argv is world
 * readable through /proc/<pid>/cmdline (the host runs several tools under one
 * shared uid), and it also ended up inside the spawn failure message, which is
 * logged and returned to the client. The token is now injected as git's own
 * environment-based configuration (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_i`/
 * `GIT_CONFIG_VALUE_i`, git >= 2.31; host runs 2.47), overriding
 * `remote.<name>.url` (and `pushurl`, which would otherwise take precedence)
 * for that single spawn only. The caller then pushes to the plain remote NAME.
 *
 * Credential semantics are unchanged: the effective push URL is byte-identical
 * to the URL the old code passed on the command line, so GitHub sees exactly the
 * same authentication as before. Nothing is written to .git/config (env config
 * is transient), which is what the old code hand-rolled in /publish.
 *
 * @param {string} projectPath repo working directory
 * @param {string} remoteName validated remote name (e.g. 'origin')
 * @param {number|undefined} userId authenticated user id (req.user.id)
 * @returns {Promise<Record<string,string>|null>} env overrides, or null to push
 *          with the repository's own (shared) remote credentials.
 */
async function resolvePushCredentialEnv(projectPath, remoteName, userId) {
  const token = getUserGithubToken(userId);
  if (!token) {
    return null; // No per-user token -> shared remote credentials.
  }
  let remoteUrl;
  try {
    const { stdout } = await spawnAsync('git', ['remote', 'get-url', remoteName], { cwd: projectPath });
    remoteUrl = stdout.trim();
  } catch {
    return null; // Remote absent/unresolvable -> fall back.
  }
  // buildTokenPushUrl returns null for non-https-github remotes (SSH, other
  // hosts, agy/placeholder repos) so a GitHub token is never offered to a
  // foreign host.
  const tokenUrl = buildTokenPushUrl(remoteUrl, token);
  if (!tokenUrl) {
    return null;
  }
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `remote.${remoteName}.url`,
    GIT_CONFIG_VALUE_0: tokenUrl,
    // pushurl wins over url when set in .git/config; override it too so the
    // effective destination is exactly the URL the old argv-based code used.
    GIT_CONFIG_KEY_1: `remote.${remoteName}.pushurl`,
    GIT_CONFIG_VALUE_1: tokenUrl,
  };
}

/** Spawn options for a push: cwd plus the transient credential env, if any. */
function buildPushSpawnOptions(projectPath, pushCredentialEnv) {
  return pushCredentialEnv
    ? { cwd: projectPath, env: { ...process.env, ...pushCredentialEnv } }
    : { cwd: projectPath };
}

/**
 * Client-safe failure text for a git command: git's own diagnostics (stderr,
 * then stdout), redacted and length-capped. Never the raw argv.
 */
function toSafeGitFailureDetails(error, fallback) {
  const details = redactCredentials(getGitErrorDetails(error)).replace(/\s+/g, ' ').trim();
  if (!details) {
    return fallback;
  }
  return details.length > 2000 ? `${details.slice(0, 2000)}…` : details;
}

// Input validation helpers (defense-in-depth)
//
// OPTION-INJECTION NOTE (B-GIT-SEC-4): every validator below also rejects a
// LEADING '-'. Without it a value such as `--upload-pack=...` passed the regex
// and git parsed it as an OPTION rather than a ref/remote (verified: `git
// checkout --evil` -> "unknown option `evil'"). Call sites additionally place
// `--end-of-options` before user-derived positionals wherever the command
// accepts it. Git itself forbids refnames that start with '-' or contain '..',
// so nothing legitimate is rejected here.
function validateCommitRef(commit) {
  // Allow hex hashes, HEAD, HEAD~N, HEAD^N, tag names, branch names
  if (typeof commit !== 'string' || !/^[a-zA-Z0-9._~^{}@\/-]+$/.test(commit) || commit.startsWith('-')) {
    throw new Error('Invalid commit reference');
  }
  return commit;
}

function validateBranchName(branch) {
  if (
    typeof branch !== 'string'
    || !/^[a-zA-Z0-9._\/-]+$/.test(branch)
    || branch.startsWith('-')
    || branch.startsWith('/')
    || branch.includes('..')
  ) {
    throw new Error('Invalid branch name');
  }
  return branch;
}

/**
 * Validates a client-supplied file path against the project it belongs to
 * (B-GIT-SEC-2).
 *
 * `projectPath` is MANDATORY. It used to be optional and the single caller
 * passed only one argument, so the entire traversal block was dead code and the
 * function degenerated into a NUL-byte check — while the value went on to
 * `path.join()` for reads and unlinks. Passing no root now throws instead of
 * silently skipping the guard, so the failure mode is closed, not open.
 *
 * Two layers:
 *   1. lexical  — resolve against the root and require containment;
 *   2. canonical — `isResolvedPathInsideRootReal` (fs.realpath on both sides),
 *      which catches a symlink INSIDE the tree pointing outside it.
 */
export function validateFilePath(file, projectPath) {
  if (!file || typeof file !== 'string' || file.includes('\0')) {
    throw new Error('Invalid file path');
  }
  if (!projectPath) {
    // Fail closed: a caller that forgot the root gets an error, not a bypass.
    throw new Error('Invalid file path: project root is required');
  }
  // Prevent path traversal: resolve the file relative to the project root
  // and ensure the result stays within the project directory
  const resolved = path.resolve(projectPath, file);
  const normalizedRoot = path.resolve(projectPath) + path.sep;
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(projectPath)) {
    throw new Error('Invalid file path: path traversal detected');
  }
  if (!isResolvedPathInsideRootReal(projectPath, resolved)) {
    throw new Error('Invalid file path: path traversal detected');
  }
  return file;
}

function validateRemoteName(remote) {
  if (
    typeof remote !== 'string'
    || !/^[a-zA-Z0-9._-]+$/.test(remote)
    || remote.startsWith('-')
    || remote.includes('..')
  ) {
    throw new Error('Invalid remote name');
  }
  return remote;
}

function validateProjectPath(projectPath) {
  if (!projectPath || projectPath.includes('\0')) {
    throw new Error('Invalid project path');
  }
  const resolved = path.resolve(projectPath);
  // Must be an absolute path after resolution
  if (!path.isAbsolute(resolved)) {
    throw new Error('Invalid project path: must be absolute');
  }
  // Block obviously dangerous paths
  if (resolved === '/' || resolved === path.sep) {
    throw new Error('Invalid project path: root directory not allowed');
  }
  return resolved;
}

/**
 * Marker left on the request by the router-level authorization guard below.
 * A Symbol (not a string key) so nothing in the request payload can forge it.
 */
const GIT_PROJECT_AUTHORIZATION = Symbol('gitProjectAuthorization');

/**
 * Resolve the absolute project directory for a given DB `projectId`.
 *
 * After the projectName → projectId migration, every git endpoint receives
 * the DB primary key (`project` query/body param). The legacy filesystem
 * resolver that walked Claude's JSONL history is no longer used here; the
 * path comes straight from the `projects` table and is then sanity-checked
 * by `validateProjectPath` before any `git` command runs against it.
 *
 * AUTHORIZATION (B-GIT-SEC-1): this is the single funnel every endpoint uses to
 * turn a `projectId` into a filesystem path, so it is also the place that
 * REFUSES to hand out a path the request was not authorized for. The decision
 * itself is made once, in the router-level guard below; here we only assert that
 * the guard actually ran AND that it authorized THIS exact id. That closes the
 * drift hole where a future endpoint reads the project id from a differently
 * named field (which the guard would not have seen): the assertion fails and no
 * path is returned. Fail-closed by construction.
 */
async function getActualProjectPath(projectId, req) {
  const requestedProjectId = typeof projectId === 'number' ? String(projectId) : projectId;
  const authorization = req?.[GIT_PROJECT_AUTHORIZATION];
  if (!authorization || authorization.projectId !== requestedProjectId) {
    // Not authorized (or the guard never saw this id) -> behave exactly like a
    // missing project: never disclose that it exists.
    const error = new Error('Project not found');
    error.statusCode = 404;
    throw error;
  }

  const projectPath = await projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    throw new Error(`Unable to resolve project path for "${projectId}"`);
  }
  return validateProjectPath(projectPath);
}

// Helper function to strip git diff headers
function stripDiffHeaders(diff) {
  if (!diff) return '';

  const lines = diff.split('\n');
  const filteredLines = [];
  let startIncluding = false;

  for (const line of lines) {
    // Skip all header lines including diff --git, index, file mode, and --- / +++ file paths
    if (line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('---') ||
        line.startsWith('+++')) {
      continue;
    }

    // Start including lines from @@ hunk headers onwards
    if (line.startsWith('@@') || startIncluding) {
      startIncluding = true;
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

// Helper function to validate git repository
async function validateGitRepository(projectPath) {
  try {
    // Check if directory exists
    await fs.access(projectPath);
  } catch {
    throw new Error(`Project path not found: ${projectPath}`);
  }

  try {
    // Allow any directory that is inside a work tree (repo root or nested folder).
    const { stdout: insideWorkTreeOutput } = await spawnAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath });
    const isInsideWorkTree = insideWorkTreeOutput.trim() === 'true';
    if (!isInsideWorkTree) {
      throw new Error('Not inside a git work tree');
    }

    // Ensure git can resolve the repository root for this directory.
    await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  } catch {
    throw new Error('Not a git repository. This directory does not contain a .git folder. Initialize a git repository with "git init" to use source control features.');
  }
}

function getGitErrorDetails(error) {
  return `${error?.message || ''} ${error?.stderr || ''} ${error?.stdout || ''}`;
}

function isMissingHeadRevisionError(error) {
  const errorDetails = getGitErrorDetails(error).toLowerCase();
  return errorDetails.includes('unknown revision')
    || errorDetails.includes('ambiguous argument')
    || errorDetails.includes('needed a single revision')
    || errorDetails.includes('bad revision');
}

async function getCurrentBranchName(projectPath) {
  try {
    // symbolic-ref works even when the repository has no commits.
    const { stdout } = await spawnAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: projectPath });
    const branchName = stdout.trim();
    if (branchName) {
      return branchName;
    }
  } catch (error) {
    // Fall back to rev-parse for detached HEAD and older git edge cases.
  }

  const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath });
  return stdout.trim();
}

async function repositoryHasCommits(projectPath) {
  try {
    await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    return true;
  } catch (error) {
    if (isMissingHeadRevisionError(error)) {
      return false;
    }
    throw error;
  }
}

async function getRepositoryRootPath(projectPath) {
  const { stdout } = await spawnAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectPath });
  return stdout.trim();
}

function normalizeRepositoryRelativeFilePath(filePath) {
  return String(filePath)
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .trim();
}

function parseStatusFilePaths(statusOutput) {
  return statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .map((line) => {
      const statusPath = line.substring(3);
      const renamedFilePath = statusPath.split(' -> ')[1];
      return normalizeRepositoryRelativeFilePath(renamedFilePath || statusPath);
    })
    .filter(Boolean);
}

function buildFilePathCandidates(projectPath, repositoryRootPath, filePath) {
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  const projectRelativePath = normalizeRepositoryRelativeFilePath(path.relative(repositoryRootPath, projectPath));
  const candidates = [normalizedFilePath];

  if (
    projectRelativePath
    && projectRelativePath !== '.'
    && !normalizedFilePath.startsWith(`${projectRelativePath}/`)
  ) {
    candidates.push(`${projectRelativePath}/${normalizedFilePath}`);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

/**
 * Final boundary assertion for a resolved repository-relative path
 * (B-GIT-SEC-2).
 *
 * `repositoryRootPath` is git's toplevel, which may be an ANCESTOR of the
 * project directory (a project registered on a sub-directory of a bigger repo).
 * The authorization unit is the PROJECT, not the repository, so the candidate
 * that the caller is about to `path.join()` and read/delete must be inside the
 * project directory — checked lexically and then canonically (symlink-aware).
 * Every return path of resolveRepositoryFilePath goes through here.
 */
function assertResolvedFilePathInsideProject(projectPath, repositoryRootPath, repositoryRelativeFilePath) {
  const projectRootAbs = path.resolve(projectPath);
  const resolvedTarget = path.resolve(repositoryRootPath, repositoryRelativeFilePath);

  if (resolvedTarget !== projectRootAbs && !resolvedTarget.startsWith(projectRootAbs + path.sep)) {
    throw new Error('Invalid file path: path traversal detected');
  }
  if (!isResolvedPathInsideRootReal(projectRootAbs, resolvedTarget)) {
    throw new Error('Invalid file path: path traversal detected');
  }

  return { repositoryRootPath, repositoryRelativeFilePath };
}

async function resolveRepositoryFilePath(projectPath, filePath) {
  // The project root is passed EXPLICITLY: the previous single-argument call
  // left the whole traversal guard dead (B-GIT-SEC-2).
  validateFilePath(filePath, projectPath);

  const repositoryRootPath = await getRepositoryRootPath(projectPath);
  const candidateFilePaths = buildFilePathCandidates(projectPath, repositoryRootPath, filePath);

  for (const candidateFilePath of candidateFilePaths) {
    const { stdout } = await spawnAsync('git', ['status', '--porcelain', '--', candidateFilePath], { cwd: repositoryRootPath });
    if (stdout.trim()) {
      return assertResolvedFilePathInsideProject(projectPath, repositoryRootPath, candidateFilePath);
    }
  }

  // If the caller sent a bare filename (e.g. "hello.ts"), recover it from changed files.
  const normalizedFilePath = normalizeRepositoryRelativeFilePath(filePath);
  if (!normalizedFilePath.includes('/')) {
    const { stdout: repositoryStatusOutput } = await spawnAsync('git', ['status', '--porcelain'], { cwd: repositoryRootPath });
    const changedFilePaths = parseStatusFilePaths(repositoryStatusOutput);
    const suffixMatches = changedFilePaths.filter(
      (changedFilePath) => changedFilePath === normalizedFilePath || changedFilePath.endsWith(`/${normalizedFilePath}`),
    );

    if (suffixMatches.length === 1) {
      return assertResolvedFilePathInsideProject(projectPath, repositoryRootPath, suffixMatches[0]);
    }
  }

  return assertResolvedFilePathInsideProject(projectPath, repositoryRootPath, candidateFilePaths[0]);
}

/**
 * ── B-GIT-SEC-1: project authorization guard for the WHOLE /api/git surface ──
 *
 * server/index.js mounts this router behind `authenticateToken` only, so before
 * this guard ANY authenticated account (the live DB carries plain `user` roles)
 * could read another project's diffs and file contents, delete its untracked
 * files, and commit/push in the owner's name — 20 endpoints, zero visibility or
 * write checks.
 *
 * The decision is made ONCE here, for every request that carries a project id,
 * instead of being copy-pasted into 20 handlers (where the next endpoint added
 * would silently miss it). Because it is `router.use()` declared BEFORE every
 * route below, it also covers endpoints added later by default.
 *
 *   - read verbs (GET/HEAD)  -> projectsDb.isProjectVisibleToUser
 *   - every other verb       -> projectsDb.isProjectWritableByUser
 *     (membership-based: 'public' confers read, never write — see B-138.)
 *
 * POST /generate-commit-message is deliberately on the WRITE side: it launches
 * an AI agent with `permissionMode: 'bypassPermissions'` in the project's cwd,
 * i.e. it can modify the working tree.
 *
 * Denials answer 404 with the same body as a missing project (never 403), so a
 * private project is not disclosed by probing — the B-PRIV guarantee already
 * used by the /api/projects routes.
 *
 * A request with NO project id falls through untouched: those handlers answer
 * their own 400, and `getActualProjectPath` refuses to resolve a path without an
 * authorization marker anyway.
 */
const GIT_READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function extractRequestedProjectId(req) {
  const raw = req.query?.project ?? req.body?.project;
  if (typeof raw === 'string') {
    return raw.trim() === '' ? null : raw;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  return null; // absent, array, object, … -> not an authorizable id.
}

router.use((req, res, next) => {
  const projectId = extractRequestedProjectId(req);
  if (projectId === null) {
    next();
    return;
  }

  const userId = coerceUserId(req.user?.id);
  const requiresWrite = !GIT_READ_ONLY_METHODS.has(req.method);
  const authorized = requiresWrite
    ? projectsDb.isProjectWritableByUser(projectId, userId)
    : projectsDb.isProjectVisibleToUser(projectId, userId);

  if (!authorized) {
    console.error('[git] project access denied', {
      userId,
      projectId,
      method: req.method,
      route: req.path,
      access: requiresWrite ? 'write' : 'read',
    });
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  req[GIT_PROJECT_AUTHORIZATION] = { projectId, access: requiresWrite ? 'write' : 'read' };
  next();
});

// Get git status for a project
router.get('/status', async (req, res) => {
  const { project } = req.query;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);

    // Validate git repository
    await validateGitRepository(projectPath);

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    // Get git status
    const { stdout: statusOutput } = await spawnAsync('git', ['status', '--porcelain'], { cwd: projectPath });

    const modified = [];
    const added = [];
    const deleted = [];
    const untracked = [];

    statusOutput.split('\n').forEach(line => {
      if (!line.trim()) return;

      const status = line.substring(0, 2);
      const file = line.substring(3);

      if (status === 'M ' || status === ' M' || status === 'MM') {
        modified.push(file);
      } else if (status === 'A ' || status === 'AM') {
        added.push(file);
      } else if (status === 'D ' || status === ' D') {
        deleted.push(file);
      } else if (status === '??') {
        untracked.push(file);
      }
    });

    res.json({
      branch,
      hasCommits,
      modified,
      added,
      deleted,
      untracked
    });
  } catch (error) {
    console.error('Git status error:', error);
    res.json({
      error: error.message.includes('not a git repository') || error.message.includes('Project directory is not a git repository')
        ? error.message
        : 'Git operation failed',
      details: error.message.includes('not a git repository') || error.message.includes('Project directory is not a git repository')
        ? error.message
        : `Failed to get git status: ${error.message}`
    });
  }
});

// Get diff for a specific file
router.get('/diff', async (req, res) => {
  const { project, file } = req.query;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    
    // Validate git repository
    await validateGitRepository(projectPath);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check if file is untracked or deleted
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let diff;
    if (isUntracked) {
      // For untracked files, show the entire file content as additions
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        // For directories, show a simple message
        diff = `Directory: ${repositoryRelativeFilePath}\n(Cannot show diff for directories)`;
      } else {
        const fileContent = await fs.readFile(filePath, 'utf-8');
        const lines = fileContent.split('\n');
        diff = `--- /dev/null\n+++ b/${repositoryRelativeFilePath}\n@@ -0,0 +1,${lines.length} @@\n` +
               lines.map(line => `+${line}`).join('\n');
      }
    } else if (isDeleted) {
      // For deleted files, show the entire file content from HEAD as deletions
      const { stdout: fileContent } = await spawnAsync(
        'git',
        ['show', `HEAD:${repositoryRelativeFilePath}`],
        { cwd: repositoryRootPath },
      );
      const lines = fileContent.split('\n');
      diff = `--- a/${repositoryRelativeFilePath}\n+++ /dev/null\n@@ -1,${lines.length} +0,0 @@\n` +
             lines.map(line => `-${line}`).join('\n');
    } else {
      // Get diff for tracked files
      // First check for unstaged changes (working tree vs index)
      const { stdout: unstagedDiff } = await spawnAsync(
        'git',
        ['diff', '--', repositoryRelativeFilePath],
        { cwd: repositoryRootPath },
      );

      if (unstagedDiff) {
        // Show unstaged changes if they exist
        diff = stripDiffHeaders(unstagedDiff);
      } else {
        // If no unstaged changes, check for staged changes (index vs HEAD)
        const { stdout: stagedDiff } = await spawnAsync(
          'git',
          ['diff', '--cached', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath },
        );
        diff = stripDiffHeaders(stagedDiff) || '';
      }
    }

    res.json({ diff });
  } catch (error) {
    console.error('Git diff error:', error);
    res.json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Get file content with diff information for CodeEditor
router.get('/file-with-diff', async (req, res) => {
  const { project, file } = req.query;

  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);

    // Validate git repository
    await validateGitRepository(projectPath);

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check file status
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    const isUntracked = statusOutput.startsWith('??');
    const isDeleted = statusOutput.trim().startsWith('D ') || statusOutput.trim().startsWith(' D');

    let currentContent = '';
    let oldContent = '';

    if (isDeleted) {
      // For deleted files, get content from HEAD
      const { stdout: headContent } = await spawnAsync(
        'git',
        ['show', `HEAD:${repositoryRelativeFilePath}`],
        { cwd: repositoryRootPath },
      );
      oldContent = headContent;
      currentContent = headContent; // Show the deleted content in editor
    } else {
      // Get current file content
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        // Cannot show content for directories
        return res.status(400).json({ error: 'Cannot show diff for directories' });
      }

      currentContent = await fs.readFile(filePath, 'utf-8');

      if (!isUntracked) {
        // Get the old content from HEAD for tracked files
        try {
          const { stdout: headContent } = await spawnAsync(
            'git',
            ['show', `HEAD:${repositoryRelativeFilePath}`],
            { cwd: repositoryRootPath },
          );
          oldContent = headContent;
        } catch (error) {
          // File might be newly added to git (staged but not committed)
          oldContent = '';
        }
      }
    }

    res.json({
      currentContent,
      oldContent,
      isDeleted,
      isUntracked
    });
  } catch (error) {
    console.error('Git file-with-diff error:', error);
    res.json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Create initial commit
router.post('/initial-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);

    // Validate git repository
    await validateGitRepository(projectPath);

    // Check if there are already commits
    try {
      await spawnAsync('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
      return res.status(400).json({ error: 'Repository already has commits. Use regular commit instead.' });
    } catch (error) {
      // No HEAD - this is good, we can create initial commit
    }

    // Add all files
    await spawnAsync('git', ['add', '.'], { cwd: projectPath });

    // Create initial commit, attributed to the requesting user (B-MU-UX-GIT-ID).
    // GIT_AUTHOR_*/GIT_COMMITTER_* are injected transiently for this spawn only;
    // when the user has no stored identity this is empty and git falls back to
    // the system/global config (current behavior).
    const authorEnv = buildGitAuthorEnv(req.user?.id);
    const { stdout } = await spawnAsync('git', ['commit', '-m', 'Initial commit'], {
      cwd: projectPath,
      env: { ...process.env, ...authorEnv },
    });

    res.json({ success: true, output: stdout, message: 'Initial commit created successfully' });
  } catch (error) {
    console.error('Git initial commit error:', error);

    // "nothing to commit" is printed by git on STDOUT, never in error.message
    // (which is the command name + exit code), so match on the full details.
    if (getGitErrorDetails(error).includes('nothing to commit')) {
      return res.status(400).json({
        error: 'Nothing to commit',
        details: 'No files found in the repository. Add some files first.'
      });
    }

    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Commit changes
router.post('/commit', async (req, res) => {
  const { project, message, files } = req.body;
  
  if (!project || !message || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project name, commit message, and files are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    
    // Validate git repository
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    
    // Stage selected files
    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
      await spawnAsync('git', ['add', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }

    // Commit with message, attributed to the requesting user (B-MU-UX-GIT-ID).
    // The per-user identity is injected transiently via GIT_AUTHOR_*/
    // GIT_COMMITTER_* for this spawn only — no global git config is touched.
    // Empty when the user has no stored identity -> falls back to system config.
    const authorEnv = buildGitAuthorEnv(req.user?.id);
    const { stdout } = await spawnAsync('git', ['commit', '-m', message], {
      cwd: repositoryRootPath,
      env: { ...process.env, ...authorEnv },
    });

    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git commit error:', error);
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Revert latest local commit (keeps changes staged)
router.post('/revert-local-commit', async (req, res) => {
  const { project } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);

    try {
      await spawnAsync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectPath });
    } catch (error) {
      return res.status(400).json({
        error: 'No local commit to revert',
        details: 'This repository has no commit yet.',
      });
    }

    try {
      // Soft reset rewinds one commit while preserving all file changes in the index.
      await spawnAsync('git', ['reset', '--soft', 'HEAD~1'], { cwd: projectPath });
    } catch (error) {
      // Read git's own diagnostics (stderr/stdout): error.message is only the
      // command name + exit code since B-GIT-SEC-3.
      const errorDetails = getGitErrorDetails(error);
      const isInitialCommit = errorDetails.includes('HEAD~1') &&
        (errorDetails.includes('unknown revision') || errorDetails.includes('ambiguous argument'));

      if (!isInitialCommit) {
        throw error;
      }

      // Initial commit has no parent; deleting HEAD uncommits it and keeps files staged.
      await spawnAsync('git', ['update-ref', '-d', 'HEAD'], { cwd: projectPath });
    }

    res.json({
      success: true,
      output: 'Latest local commit reverted successfully. Changes were kept staged.',
    });
  } catch (error) {
    console.error('Git revert local commit error:', error);
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Get list of branches
router.get('/branches', async (req, res) => {
  const { project } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    
    // Validate git repository
    await validateGitRepository(projectPath);
    
    // Get all branches
    const { stdout } = await spawnAsync('git', ['branch', '-a'], { cwd: projectPath });

    const rawLines = stdout
      .split('\n')
      .map(b => b.trim())
      .filter(b => b && !b.includes('->'));

    // Local branches (may start with '* ' for current)
    const localBranches = rawLines
      .filter(b => !b.startsWith('remotes/'))
      .map(b => (b.startsWith('* ') ? b.substring(2) : b));

    // Remote branches — strip 'remotes/<remote>/' prefix
    const remoteBranches = rawLines
      .filter(b => b.startsWith('remotes/'))
      .map(b => b.replace(/^remotes\/[^/]+\//, ''))
      .filter(name => !localBranches.includes(name)); // skip if already a local branch

    // Backward-compat flat list (local + unique remotes, deduplicated)
    const branches = [...localBranches, ...remoteBranches]
      .filter((b, i, arr) => arr.indexOf(b) === i);

    res.json({ branches, localBranches, remoteBranches });
  } catch (error) {
    console.error('Git branches error:', error);
    res.json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Checkout branch
router.post('/checkout', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    
    // Checkout the branch. --end-of-options stops git from re-parsing a
    // '-'-prefixed name as an option (B-GIT-SEC-4); the validator rejects such
    // names anyway, so this is the second layer.
    validateBranchName(branch);
    const { stdout } = await spawnAsync('git', ['checkout', '--end-of-options', branch], { cwd: projectPath });
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git checkout error:', error);
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Create new branch
router.post('/create-branch', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    
    // Create and checkout new branch. `-b` consumes the NEXT argv element as its
    // value verbatim (verified: `git checkout -b --orphan-x` -> "'--orphan-x' is
    // not a valid branch name", i.e. parsed as a name, not an option), so the
    // slot cannot be turned into an option; `--end-of-options` cannot be used
    // here because it would swallow `-b` itself. The validator's leading-'-'
    // rejection is the guard (B-GIT-SEC-4).
    validateBranchName(branch);
    const { stdout } = await spawnAsync('git', ['checkout', '-b', branch], { cwd: projectPath });
    
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git create branch error:', error);
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Delete a local branch
router.post('/delete-branch', async (req, res) => {
  const { project, branch } = req.body;

  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch name are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);

    // This endpoint had NO name validation at all: `branch` went straight into
    // argv, so a '-'-prefixed value was parsed as an option (B-GIT-SEC-4).
    validateBranchName(branch);

    // Safety: cannot delete the currently checked-out branch
    const { stdout: currentBranch } = await spawnAsync('git', ['branch', '--show-current'], { cwd: projectPath });
    if (currentBranch.trim() === branch) {
      return res.status(400).json({ error: 'Cannot delete the currently checked-out branch' });
    }

    const { stdout } = await spawnAsync('git', ['branch', '-d', '--end-of-options', branch], { cwd: projectPath });
    res.json({ success: true, output: stdout });
  } catch (error) {
    console.error('Git delete branch error:', error);
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Get recent commits
router.get('/commits', async (req, res) => {
  const { project, limit = 10 } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);
    const parsedLimit = Number.parseInt(String(limit), 10);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 10;
    
    // Get commit log with stats
    const { stdout } = await spawnAsync(
      'git',
      ['log', '--pretty=format:%H|%an|%ae|%ad|%s', '--date=iso-strict', '-n', String(safeLimit)],
      { cwd: projectPath },
    );
    
    const commits = stdout
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [hash, author, email, date, ...messageParts] = line.split('|');
        return {
          hash,
          author,
          email,
          date,
          message: messageParts.join('|')
        };
      });
    
    // Get stats for each commit
    for (const commit of commits) {
      try {
        const { stdout: stats } = await spawnAsync(
          'git', ['show', '--stat', '--format=', '--end-of-options', commit.hash],
          { cwd: projectPath }
        );
        commit.stats = stats.trim().split('\n').pop(); // Get the summary line
      } catch (error) {
        commit.stats = '';
      }
    }
    
    res.json({ commits });
  } catch (error) {
    console.error('Git commits error:', error);
    res.json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Get diff for a specific commit
router.get('/commit-diff', async (req, res) => {
  const { project, commit } = req.query;
  
  if (!project || !commit) {
    return res.status(400).json({ error: 'Project id and commit hash are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);

    // Validate commit reference (defense-in-depth)
    validateCommitRef(commit);

    // Get diff for the commit (--end-of-options: the ref can never be re-parsed
    // as an option, e.g. `--output=<file>` — B-GIT-SEC-4).
    const { stdout } = await spawnAsync(
      'git', ['show', '--end-of-options', commit],
      { cwd: projectPath }
    );

    const isTruncated = stdout.length > COMMIT_DIFF_CHARACTER_LIMIT;
    const diff = isTruncated
      ? `${stdout.slice(0, COMMIT_DIFF_CHARACTER_LIMIT)}\n\n... Diff truncated to keep the UI responsive ...`
      : stdout;

    res.json({ diff, isTruncated });
  } catch (error) {
    console.error('Git commit diff error:', error);
    res.json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Generate commit message based on staged changes using AI
router.post('/generate-commit-message', async (req, res) => {
  const { project, files, provider = 'claude' } = req.body;

  if (!project || !files || files.length === 0) {
    return res.status(400).json({ error: 'Project id and files are required' });
  }

  // Validate provider
  if (!['claude', 'cursor'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude" or "cursor"' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);

    // Get diff for selected files
    let diffContext = '';
    for (const file of files) {
      try {
        const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
        const { stdout } = await spawnAsync(
          'git', ['diff', 'HEAD', '--', repositoryRelativeFilePath],
          { cwd: repositoryRootPath }
        );
        if (stdout) {
          diffContext += `\n--- ${repositoryRelativeFilePath} ---\n${stdout}`;
        }
      } catch (error) {
        console.error(`Error getting diff for ${file}:`, error);
      }
    }

    // If no diff found, might be untracked files
    if (!diffContext.trim()) {
      // Try to get content of untracked files
      for (const file of files) {
        try {
          const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
          const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
          const stats = await fs.stat(filePath);

          if (!stats.isDirectory()) {
            const content = await fs.readFile(filePath, 'utf-8');
            diffContext += `\n--- ${repositoryRelativeFilePath} (new file) ---\n${content.substring(0, 1000)}\n`;
          } else {
            diffContext += `\n--- ${repositoryRelativeFilePath} (new directory) ---\n`;
          }
        } catch (error) {
          console.error(`Error reading file ${file}:`, error);
        }
      }
    }

    // Generate commit message using AI
    const message = await generateCommitMessageWithAI(files, diffContext, provider, projectPath);

    res.json({ message });
  } catch (error) {
    console.error('Generate commit message error:', error);
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

/**
 * Generates a commit message using AI (Claude SDK or Cursor CLI)
 * @param {Array<string>} files - List of changed files
 * @param {string} diffContext - Git diff content
 * @param {string} provider - 'claude' or 'cursor'
 * @param {string} projectPath - Project directory path
 * @returns {Promise<string>} Generated commit message
 */
async function generateCommitMessageWithAI(files, diffContext, provider, projectPath) {
  // Create the prompt
  const prompt = `Generate a conventional commit message for these changes.

REQUIREMENTS:
- Format: type(scope): subject
- Include body explaining what changed and why
- Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore
- Subject under 50 chars, body wrapped at 72 chars
- Focus on user-facing changes, not implementation details
- Consider what's being added AND removed
- Return ONLY the commit message (no markdown, explanations, or code blocks)

FILES CHANGED:
${files.map(f => `- ${f}`).join('\n')}

DIFFS:
${diffContext.substring(0, 4000)}

Generate the commit message:`;

  try {
    // Create a simple writer that collects the response
    let responseText = '';
    const writer = {
      send: (data) => {
        try {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          console.log('🔍 Writer received message type:', parsed.type);

          // Handle different message formats from Claude SDK and Cursor CLI
          // Claude SDK sends: {type: 'claude-response', data: {message: {content: [...]}}}
          if (parsed.type === 'claude-response' && parsed.data) {
            const message = parsed.data.message || parsed.data;
            console.log('📦 Claude response message:', JSON.stringify(message, null, 2).substring(0, 500));
            if (message.content && Array.isArray(message.content)) {
              // Extract text from content array
              for (const item of message.content) {
                if (item.type === 'text' && item.text) {
                  console.log('✅ Extracted text chunk:', item.text.substring(0, 100));
                  responseText += item.text;
                }
              }
            }
          }
          // Cursor CLI sends: {type: 'cursor-output', output: '...'}
          else if (parsed.type === 'cursor-output' && parsed.output) {
            console.log('✅ Cursor output:', parsed.output.substring(0, 100));
            responseText += parsed.output;
          }
          // Also handle direct text messages
          else if (parsed.type === 'text' && parsed.text) {
            console.log('✅ Direct text:', parsed.text.substring(0, 100));
            responseText += parsed.text;
          }
        } catch (e) {
          // Ignore parse errors
          console.error('Error parsing writer data:', e);
        }
      },
      setSessionId: () => {}, // No-op for this use case
    };

    console.log('🚀 Calling AI agent with provider:', provider);
    console.log('📝 Prompt length:', prompt.length);

    // Call the appropriate agent
    if (provider === 'claude') {
      await queryClaudeSDK(prompt, {
        cwd: projectPath,
        permissionMode: 'bypassPermissions',
        model: 'sonnet'
      }, writer);
    } else if (provider === 'cursor') {
      await spawnCursor(prompt, {
        cwd: projectPath,
        skipPermissions: true
      }, writer);
    }

    console.log('📊 Total response text collected:', responseText.length, 'characters');
    console.log('📄 Response preview:', responseText.substring(0, 200));

    // Clean up the response
    const cleanedMessage = cleanCommitMessage(responseText);
    console.log('🧹 Cleaned message:', cleanedMessage.substring(0, 200));

    return cleanedMessage || 'chore: update files';
  } catch (error) {
    console.error('Error generating commit message with AI:', error);
    // Fallback to simple message
    return `chore: update ${files.length} file${files.length !== 1 ? 's' : ''}`;
  }
}

/**
 * Cleans the AI-generated commit message by removing markdown, code blocks, and extra formatting
 * @param {string} text - Raw AI response
 * @returns {string} Clean commit message
 */
function cleanCommitMessage(text) {
  if (!text || !text.trim()) {
    return '';
  }

  let cleaned = text.trim();

  // Remove markdown code blocks
  cleaned = cleaned.replace(/```[a-z]*\n/g, '');
  cleaned = cleaned.replace(/```/g, '');

  // Remove markdown headers
  cleaned = cleaned.replace(/^#+\s*/gm, '');

  // Remove leading/trailing quotes
  cleaned = cleaned.replace(/^["']|["']$/g, '');

  // If there are multiple lines, take everything (subject + body)
  // Just clean up extra blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Remove any explanatory text before the actual commit message
  // Look for conventional commit pattern and start from there
  const conventionalCommitMatch = cleaned.match(/(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+?\))?:.+/s);
  if (conventionalCommitMatch) {
    cleaned = cleaned.substring(cleaned.indexOf(conventionalCommitMatch[0]));
  }

  return cleaned.trim();
}

// Get remote status (ahead/behind commits with smart remote detection)
router.get('/remote-status', async (req, res) => {
  const { project } = req.query;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(projectPath);

    const { stdout: remoteOutput } = await spawnAsync('git', ['remote'], { cwd: projectPath });
    const remotes = remoteOutput.trim().split('\n').filter(r => r.trim());
    const hasRemote = remotes.length > 0;
    const fallbackRemoteName = hasRemote
      ? (remotes.includes('origin') ? 'origin' : remotes[0])
      : null;

    // Repositories initialized with `git init` can have a branch but no commits.
    // Return a non-error state so the UI can show the initial-commit workflow.
    if (!hasCommits) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        ahead: 0,
        behind: 0,
        isUpToDate: false,
        message: 'Repository has no commits yet'
      });
    }

    // Check if there's a remote tracking branch (smart detection)
    let trackingBranch;
    let remoteName;
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      trackingBranch = stdout.trim();
      remoteName = trackingBranch.split('/')[0]; // Extract remote name (e.g., "origin/main" -> "origin")
    } catch (error) {
      return res.json({
        hasRemote,
        hasUpstream: false,
        branch,
        remoteName: fallbackRemoteName,
        message: 'No remote tracking branch configured'
      });
    }

    // Get ahead/behind counts
    const { stdout: countOutput } = await spawnAsync(
      'git', ['rev-list', '--count', '--left-right', `${trackingBranch}...HEAD`],
      { cwd: projectPath }
    );
    
    const [behind, ahead] = countOutput.trim().split('\t').map(Number);

    res.json({
      hasRemote: true,
      hasUpstream: true,
      branch,
      remoteBranch: trackingBranch,
      remoteName,
      ahead: ahead || 0,
      behind: behind || 0,
      isUpToDate: ahead === 0 && behind === 0
    });
  } catch (error) {
    console.error('Git remote status error:', error);
    res.json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Fetch from remote (using smart remote detection)
router.post('/fetch', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      remoteName = stdout.trim().split('/')[0]; // Extract remote name
    } catch (error) {
      // No upstream, try to fetch from origin anyway
      console.log('No upstream configured, using origin as fallback');
    }

    validateRemoteName(remoteName);
    // --end-of-options: a remote name can never be re-parsed as a git option.
    const { stdout } = await spawnAsync('git', ['fetch', '--end-of-options', remoteName], { cwd: projectPath });

    res.json({ success: true, output: stdout || 'Fetch completed successfully', remoteName });
  } catch (error) {
    const failureDetails = toSafeGitFailureDetails(error, 'Fetch failed');
    console.error('Git fetch error:', { exitCode: error?.code, details: failureDetails });
    res.status(500).json({
      error: 'Fetch failed',
      details: failureDetails.includes('Could not resolve host')
        ? 'Unable to connect to remote repository. Check your internet connection.'
        : failureDetails.includes('does not appear to be a git repository')
        ? 'No remote repository configured. Add a remote with: git remote add origin <url>'
        : failureDetails
    });
  }
});

// Pull from remote (fetch + merge using smart remote detection)
router.post('/pull', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);
    // --end-of-options: neither positional can be re-parsed as a git option.
    const { stdout } = await spawnAsync('git', ['pull', '--end-of-options', remoteName, remoteBranch], { cwd: projectPath });

    res.json({
      success: true,
      output: stdout || 'Pull completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    const failureDetails = toSafeGitFailureDetails(error, 'Pull failed');
    console.error('Git pull error:', { exitCode: error?.code, details: failureDetails });

    // Enhanced error handling for common pull scenarios
    let errorMessage = 'Pull failed';
    let details = failureDetails;

    if (failureDetails.includes('CONFLICT')) {
      errorMessage = 'Merge conflicts detected';
      details = 'Pull created merge conflicts. Please resolve conflicts manually in the editor, then commit the changes.';
    } else if (failureDetails.includes('Please commit your changes or stash them')) {
      errorMessage = 'Uncommitted changes detected';
      details = 'Please commit or stash your local changes before pulling.';
    } else if (failureDetails.includes('Could not resolve host')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (failureDetails.includes('does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (failureDetails.includes('diverged')) {
      errorMessage = 'Branches have diverged';
      details = 'Your local branch and remote branch have diverged. Consider fetching first to review changes.';
    }

    res.status(500).json({ 
      error: errorMessage, 
      details: details
    });
  }
});

// Push commits to remote repository
router.post('/push', async (req, res) => {
  const { project } = req.body;
  
  if (!project) {
    return res.status(400).json({ error: 'Project id is required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);

    // Get current branch and its upstream remote
    const branch = await getCurrentBranchName(projectPath);

    let remoteName = 'origin'; // fallback
    let remoteBranch = branch; // fallback
    try {
      const { stdout } = await spawnAsync('git', ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: projectPath });
      const tracking = stdout.trim();
      remoteName = tracking.split('/')[0]; // Extract remote name
      remoteBranch = tracking.split('/').slice(1).join('/'); // Extract branch name
    } catch (error) {
      // No upstream, use fallback
      console.log('No upstream configured, using origin/branch as fallback');
    }

    validateRemoteName(remoteName);
    validateBranchName(remoteBranch);

    // Per-user push credentials (B-MU-UX-GIT-ID): if the requesting user has
    // their own active GitHub token and the remote is an https github.com URL,
    // the token-embedded URL is injected as transient git ENV CONFIG for this
    // spawn (B-GIT-SEC-3) — never as an argv positional, never written into
    // .git/config. argv below carries only the validated remote NAME.
    // No token / non-https-github remote -> shared remote credentials.
    const pushCredentialEnv = await resolvePushCredentialEnv(projectPath, remoteName, req.user?.id);
    const { stdout } = await spawnAsync(
      'git',
      ['push', remoteName, remoteBranch],
      buildPushSpawnOptions(projectPath, pushCredentialEnv),
    );

    res.json({
      success: true,
      output: redactCredentials(stdout) || 'Push completed successfully',
      remoteName,
      remoteBranch
    });
  } catch (error) {
    // git's diagnostics live in stderr, NOT in error.message (which never held
    // them: the message used to be the raw argv, so every branch below silently
    // failed to match and `details` fell through to the argv — the string that
    // carried the push token). getGitErrorDetails reads message+stderr+stdout,
    // all already credential-redacted by spawnAsync.
    const failureDetails = toSafeGitFailureDetails(error, 'Push failed');
    console.error('Git push error:', { exitCode: error?.code, details: failureDetails });

    // Enhanced error handling for common push scenarios
    let errorMessage = 'Push failed';
    let details = failureDetails;

    if (failureDetails.includes('non-fast-forward')) {
      errorMessage = 'Non-fast-forward push';
      details = 'Your branch is behind the remote. Pull the latest changes first.';
    } else if (failureDetails.includes('rejected')) {
      errorMessage = 'Push rejected';
      details = 'The remote has newer commits. Pull first to merge changes before pushing.';
    } else if (failureDetails.includes('Could not resolve host')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (failureDetails.includes('does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'No remote repository configured. Add a remote with: git remote add origin <url>';
    } else if (failureDetails.includes('Permission denied') || failureDetails.includes('Authentication failed')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (failureDetails.includes('no upstream branch')) {
      errorMessage = 'No upstream branch';
      details = 'No upstream branch configured. Use: git push --set-upstream origin <branch>';
    }

    res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

// Publish branch to remote (set upstream and push)
router.post('/publish', async (req, res) => {
  const { project, branch } = req.body;
  
  if (!project || !branch) {
    return res.status(400).json({ error: 'Project id and branch are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);

    // Validate branch name
    validateBranchName(branch);

    // Get current branch to verify it matches the requested branch
    const currentBranchName = await getCurrentBranchName(projectPath);

    if (currentBranchName !== branch) {
      return res.status(400).json({
        error: `Branch mismatch. Current branch is ${currentBranchName}, but trying to publish ${branch}`
      });
    }

    // Check if remote exists
    let remoteName = 'origin';
    try {
      const { stdout } = await spawnAsync('git', ['remote'], { cwd: projectPath });
      const remotes = stdout.trim().split('\n').filter(r => r.trim());
      if (remotes.length === 0) {
        return res.status(400).json({
          error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
        });
      }
      remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
    } catch (error) {
      return res.status(400).json({
        error: 'No remote repository configured. Add a remote with: git remote add origin <url>'
      });
    }

    // Publish the branch (set upstream and push).
    // Per-user push credentials (B-MU-UX-GIT-ID): when the requesting user has
    // their own token (https github remote) it is injected as transient git ENV
    // CONFIG overriding remote.<name>.url for this spawn only (B-GIT-SEC-3), so
    // the push is attributed to them while argv stays token-free. Because the
    // push now targets the NAMED remote, `--set-upstream` records the clean
    // remote name itself — the hand-rolled `git config branch.*` fallback that
    // existed to keep the token out of .git/config is no longer needed, and the
    // token path and the shared path are one and the same command.
    validateRemoteName(remoteName);
    const pushCredentialEnv = await resolvePushCredentialEnv(projectPath, remoteName, req.user?.id);
    const { stdout } = await spawnAsync(
      'git',
      ['push', '--set-upstream', remoteName, branch],
      buildPushSpawnOptions(projectPath, pushCredentialEnv),
    );

    res.json({
      success: true,
      output: redactCredentials(stdout) || 'Branch published successfully',
      remoteName,
      branch
    });
  } catch (error) {
    // Same reasoning as /push: match on git's redacted stderr, never on the
    // raw message/argv (B-GIT-SEC-3).
    const failureDetails = toSafeGitFailureDetails(error, 'Publish failed');
    console.error('Git publish error:', { exitCode: error?.code, details: failureDetails });

    // Enhanced error handling for common publish scenarios
    let errorMessage = 'Publish failed';
    let details = failureDetails;

    if (failureDetails.includes('rejected')) {
      errorMessage = 'Publish rejected';
      details = 'The remote branch already exists and has different commits. Use push instead.';
    } else if (failureDetails.includes('Could not resolve host')) {
      errorMessage = 'Network error';
      details = 'Unable to connect to remote repository. Check your internet connection.';
    } else if (failureDetails.includes('Permission denied') || failureDetails.includes('Authentication failed')) {
      errorMessage = 'Authentication failed';
      details = 'Permission denied. Check your credentials or SSH keys.';
    } else if (failureDetails.includes('does not appear to be a git repository')) {
      errorMessage = 'Remote not configured';
      details = 'Remote repository not properly configured. Check your remote URL.';
    }

    res.status(500).json({
      error: errorMessage,
      details: details
    });
  }
});

// Discard changes for a specific file
router.post('/discard', async (req, res) => {
  const { project, file } = req.body;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check file status to determine correct discard command
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );

    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'No changes to discard for this file' });
    }

    const status = statusOutput.substring(0, 2);

    if (status === '??') {
      // Untracked file or directory - delete it
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);

      if (stats.isDirectory()) {
        await fs.rm(filePath, { recursive: true, force: true });
      } else {
        await fs.unlink(filePath);
      }
    } else if (status.includes('M') || status.includes('D')) {
      // Modified or deleted file - restore from HEAD
      await spawnAsync('git', ['restore', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    } else if (status.includes('A')) {
      // Added file - unstage it
      await spawnAsync('git', ['reset', 'HEAD', '--', repositoryRelativeFilePath], { cwd: repositoryRootPath });
    }
    
    res.json({ success: true, message: `Changes discarded for ${repositoryRelativeFilePath}` });
  } catch (error) {
    console.error('Git discard error:', error);
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Delete untracked file
router.post('/delete-untracked', async (req, res) => {
  const { project, file } = req.body;
  
  if (!project || !file) {
    return res.status(400).json({ error: 'Project id and file path are required' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);
    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(projectPath, file);

    // Check if file is actually untracked
    const { stdout: statusOutput } = await spawnAsync(
      'git',
      ['status', '--porcelain', '--', repositoryRelativeFilePath],
      { cwd: repositoryRootPath },
    );
    
    if (!statusOutput.trim()) {
      return res.status(400).json({ error: 'File is not untracked or does not exist' });
    }

    const status = statusOutput.substring(0, 2);
    
    if (status !== '??') {
      return res.status(400).json({ error: 'File is not untracked. Use discard for tracked files.' });
    }

    // Delete the untracked file or directory
    const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
    const stats = await fs.stat(filePath);

    if (stats.isDirectory()) {
      // Use rm with recursive option for directories
      await fs.rm(filePath, { recursive: true, force: true });
      res.json({ success: true, message: `Untracked directory ${repositoryRelativeFilePath} deleted successfully` });
    } else {
      await fs.unlink(filePath);
      res.json({ success: true, message: `Untracked file ${repositoryRelativeFilePath} deleted successfully` });
    }
  } catch (error) {
    console.error('Git delete untracked error:', error);
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

export default router;
