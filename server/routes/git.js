import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';

import express from 'express';

import {
  appendBoundedDiagnostic,
  createGitAskpassLease,
  parseCanonicalGitHubUrl,
} from '@/modules/projects/services/git-transport-security.service.js';
import {
  readSessionSubmittedBlobs,
  requireBoundSessionWorkspace,
} from '@/modules/session-workspaces/index.js';
import { runPermissionExecutionAdapter } from '@/modules/execution-permissions/adapter.js';

import { projectsDb } from '../modules/database/index.js';
import { queryClaudeSDK } from '../claude-sdk.js';
import { spawnCursor } from '../cursor-cli.js';
import { buildGitAuthorEnv, getUserGithubToken } from '../utils/gitIdentity.js';
import { coerceUserId } from '../modules/projects/services/project-visibility-guard.service.js';
import { isResolvedPathInsideRootReal } from '../utils/path-guard.js';
import {
  acquireLease,
  captureRequest,
  commitRequest,
  inspectRequest,
  releaseLease,
  resumeRequest,
} from '../../scripts/session-commit-arbiter.mjs';
import { dispatchCommittedPreview } from '../../scripts/preview-oid-dispatch.mjs';
import { stampWriterEpoch } from '../shared/user-revocation-epoch.js';

const router = express.Router();
const COMMIT_DIFF_CHARACTER_LIMIT = 500_000;
const CONVENTIONAL_COMMIT_PATTERN = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\r\n]+\))?!?: .+/;

/** Final device-generation fence immediately before a request's first write. */
function claimCurrentIdentity(req, res) {
  if (req.assertCurrentIdentity?.() !== false) return true;
  res.status(409).set('Cache-Control', 'no-store').json({
    error: 'Identity changed during request', code: 'identity_changed',
  });
  return false;
}

/**
 * Commit exactly the selected worktree paths without staging through Git's
 * shared default index, then hand the immutable commit contract to the preview
 * queue. A clean legacy index is reconciled to the new HEAD atomically; staged
 * intent is rebased onto the new HEAD before the compare-and-swap.
 *
 * The worktree lease is deliberately short-lived and generation-fenced. It is
 * released after success. Conflicts retain both their durable request and lease
 * so the explicit resolve endpoint can resume them under a fresh fence.
 */
export async function commitSelectedPathsWithArbiter({
  repositoryRootPath,
  repositoryRelativeFilePaths,
  message,
  authorEnv = {},
  sessionId = `git-route-${randomUUID()}`,
  dispatchPreview = dispatchCommittedPreview,
}) {
  const lease = acquireLease({
    repo: repositoryRootPath,
    session: sessionId,
    paths: repositoryRelativeFilePaths,
    isolation: 'worktree',
  });

  let request;
  let preserveLease = false;
  try {
    request = captureRequest({
      repo: repositoryRootPath,
      session: sessionId,
      generation: lease.generation,
      paths: repositoryRelativeFilePaths,
    });
    const result = commitRequest({
      repo: repositoryRootPath,
      requestId: request.requestId,
      message,
      authorEnv,
    });

    try {
      const preview = await dispatchPreview(
        repositoryRootPath,
        `git-${result.commit}`,
        result,
      );
      return { ...result, preview };
    } catch (error) {
      // HEAD has already advanced. Preserve that fact so the route never tells
      // the client to retry an already-successful commit.
      error.committedResult = result;
      throw error;
    }
  } catch (error) {
    if (request && /owned-path conflict|default index staged-intent conflict|default index changed during cutover/.test(error?.message || '')) {
      preserveLease = true;
      error.commitConflict = { requestId: request.requestId, sessionId, generation: lease.generation };
    }
    throw error;
  } finally {
    if (!preserveLease) releaseLease({ repo: repositoryRootPath, session: sessionId, generation: lease.generation });
  }
}

/**
 * Submit one session-owned overlay file without reading the shared worktree.
 * The opaque overlay generation and authenticated principal must both match the
 * durable session binding before a submittedPatch request reaches the arbiter.
 */
export async function submitSessionOverlay({
  repositoryRootPath,
  projectPath,
  repositoryRelativeFilePaths,
  renames = [],
  sessionId,
  generation,
  principalId,
  message,
  authorEnv = {},
  dispatchPreview = dispatchCommittedPreview,
}) {
  const binding = requireBoundSessionWorkspace({
    projectPath,
    sessionId,
    generation,
    principalId,
  });
  const submittedBlobs = readSessionSubmittedBlobs(binding, repositoryRelativeFilePaths);
  const arbiterSession = `overlay-${binding.overlayId}`;
  const lease = acquireLease({
    repo: repositoryRootPath,
    session: arbiterSession,
    paths: repositoryRelativeFilePaths,
    isolation: 'overlay',
  });

  let request;
  let preserveLease = false;
  try {
    request = captureRequest({
      repo: repositoryRootPath,
      session: arbiterSession,
      generation: lease.generation,
      renames,
      submittedBlobs,
      baselineRef: binding.baseOid,
    });
    const result = commitRequest({
      repo: repositoryRootPath,
      requestId: request.requestId,
      message,
      authorEnv,
    });
    try {
      const preview = await dispatchPreview(
        repositoryRootPath,
        `overlay-${result.commit}`,
        result,
      );
      return { ...result, preview };
    } catch (error) {
      error.committedResult = result;
      throw error;
    }
  } catch (error) {
    if (request && /owned-path conflict|default index staged-intent conflict|default index changed during cutover/.test(error?.message || '')) {
      preserveLease = true;
      error.commitConflict = {
        requestId: request.requestId,
        sessionId,
        generation,
        overlayId: binding.overlayId,
        files: [...repositoryRelativeFilePaths],
        renames: renames.map((rename) => ({ ...rename })),
        arbiterGeneration: lease.generation,
      };
    }
    throw error;
  } finally {
    if (!preserveLease) releaseLease({
      repo: repositoryRootPath,
      session: arbiterSession,
      generation: lease.generation,
    });
  }
}

/** Re-capture the original conflict paths from the same authenticated overlay. */
export async function resolveSessionOverlayConflict({
  repositoryRootPath,
  projectPath,
  requestId,
  sessionId,
  generation,
  principalId,
  message,
  authorEnv = {},
  dispatchPreview = dispatchCommittedPreview,
}) {
  const binding = requireBoundSessionWorkspace({
    projectPath, sessionId, generation, principalId,
  });
  const original = inspectRequest({ repo: repositoryRootPath, requestId });
  if (original.session !== `overlay-${binding.overlayId}`) {
    throw new Error('session overlay conflict mismatch');
  }
  return submitSessionOverlay({
    repositoryRootPath,
    projectPath,
    repositoryRelativeFilePaths: original.ownedPaths,
    renames: original.renames,
    sessionId,
    generation,
    principalId,
    message,
    authorEnv,
    dispatchPreview,
  });
}

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
    const {
      sensitiveValues = [],
      maxOutputBytes = null,
      ...spawnOptions
    } = options;
    const child = spawn(command, args, {
      ...spawnOptions,
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout = maxOutputBytes
        ? appendBoundedDiagnostic(stdout, data)
        : stdout + data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr = maxOutputBytes
        ? appendBoundedDiagnostic(stderr, data)
        : stderr + data.toString();
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
      const redactExact = (value) => sensitiveValues.reduce(
        (result, secret) => typeof secret === 'string' && secret
          ? result.split(secret).join('***')
          : result,
        redactCredentials(value),
      );
      error.stdout = redactExact(stdout);
      error.stderr = redactExact(stderr);
      reject(error);
    });
  });
}

/**
 * Resolves a per-user push credential into an ephemeral askpass lease. The
 * secret is absent from argv and environment values; only owner-only temporary
 * file paths are exposed to the child. When a token is used, the effective
 * remote is pinned to a canonical HTTPS GitHub repository URL so configured
 * pushurl values cannot redirect the credential to another host.
 *
 * @param {string} projectPath repo working directory
 * @param {string} remoteName validated remote name (e.g. 'origin')
 * @param {number|undefined} userId authenticated user id (req.user.id)
 * @returns {Promise<{env:NodeJS.ProcessEnv,sensitiveValues:string[],cleanup:()=>Promise<void>}>}
 */
export async function resolvePushCredentialLease(projectPath, remoteName, userId) {
  const token = getUserGithubToken(userId);
  if (!token) {
    const lease = await createGitAskpassLease(null);
    return { ...lease, sensitiveValues: [] };
  }
  const { stdout } = await spawnAsync('git', ['remote', 'get-url', remoteName], { cwd: projectPath });
  const canonical = parseCanonicalGitHubUrl(stdout.trim());
  const lease = await createGitAskpassLease(token);
  return {
    cleanup: lease.cleanup,
    sensitiveValues: [token],
    env: {
      ...lease.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: `remote.${remoteName}.url`,
      GIT_CONFIG_VALUE_0: canonical.cloneUrl,
      GIT_CONFIG_KEY_1: `remote.${remoteName}.pushurl`,
      GIT_CONFIG_VALUE_1: canonical.cloneUrl,
    },
  };
}

/** Spawn options for a bounded push using an ephemeral credential lease. */
export function buildPushSpawnOptions(projectPath, credentialLease) {
  return {
    cwd: projectPath,
    env: credentialLease.env,
    sensitiveValues: credentialLease.sensitiveValues,
    maxOutputBytes: 16 * 1024,
  };
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

function requireOwnerReleaseBroker(_req, res, _next) {
  return res.status(403).json({
    error: 'Direct remote publication is disabled. Use the owner-authorized release broker.',
  });
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

function readOverlayCoordinates(query) {
  const sessionId = query?.sessionId;
  const generation = query?.generation;
  const hasAnyCoordinate = sessionId !== undefined || generation !== undefined;
  if (!hasAnyCoordinate) return null;
  const hasSessionId = typeof sessionId === 'string' && Boolean(sessionId.trim());
  const hasGeneration = typeof generation === 'string' && Boolean(generation.trim());
  if (!hasSessionId || !hasGeneration) {
    throw new Error('session id and overlay generation must be supplied together');
  }
  return { sessionId: sessionId.trim(), generation: generation.trim() };
}

/** Resolve a read to the same principal- and generation-bound overlay as commit. */
export function requireGitReadWorkspace({ projectPath, query, principalId }) {
  const coordinates = readOverlayCoordinates(query);
  if (!coordinates) return null;
  return requireBoundSessionWorkspace({
    projectPath,
    sessionId: coordinates.sessionId,
    generation: coordinates.generation,
    principalId,
  });
}

function classifyPorcelainStatus(statusOutput) {
  const result = { modified: [], added: [], deleted: [], untracked: [] };
  for (const line of statusOutput.split('\n')) {
    if (!line.trim()) continue;
    const status = line.substring(0, 2);
    const statusPath = line.substring(3);
    const file = statusPath.split(' -> ').at(-1);
    if (status === '??') result.untracked.push(file);
    else if (status.includes('D')) result.deleted.push(file);
    else if (status.includes('A') || status.includes('R') || status.includes('C')) result.added.push(file);
    else if (status.includes('M') || status.includes('T')) result.modified.push(file);
  }
  return result;
}

/** Read status only from an already authenticated isolated linked worktree. */
export async function readGitWorkspaceStatus(binding) {
  const { stdout } = await spawnAsync('git', ['status', '--porcelain'], { cwd: binding.cwd });
  return classifyPorcelainStatus(stdout);
}

/** Read one overlay diff without opening untrusted paths through their names. */
export async function readGitWorkspaceDiff(binding, repositoryRelativeFilePath) {
  const { stdout: statusOutput } = await spawnAsync(
    'git',
    ['status', '--porcelain', '--', repositoryRelativeFilePath],
    { cwd: binding.cwd },
  );
  if (statusOutput.substring(0, 2) === '??') {
    const submitted = readSessionSubmittedBlobs(binding, [repositoryRelativeFilePath])[0];
    const lines = submitted.body.toString('utf8').split('\n');
    return `--- /dev/null\n+++ b/${repositoryRelativeFilePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
  }
  const { stdout } = await spawnAsync(
    'git',
    ['diff', binding.baseOid, '--', repositoryRelativeFilePath],
    { cwd: binding.cwd },
  );
  return stripDiffHeaders(stdout) || '';
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

/**
 * Reports whether `projectPath` is itself the root of its git repository, as
 * opposed to a nested subfolder that git resolves upward to an ancestor repo.
 *
 * A project folder that is not a repo of its own (e.g. `~/projects/App` under a
 * home directory that happens to be a git repo) would otherwise inherit the
 * ancestor's ahead/behind counts and falsely advertise unpushed commits. Both
 * sides are canonicalised with fs.realpath so symlinked or non-normalised paths
 * compare correctly. Returns false on any failure so callers fail closed and
 * treat the folder as a non-root. `validateGitRepository` intentionally still
 * accepts nested folders for the git panel; this is a separate, narrower check.
 */
export async function isProjectRepositoryRoot(projectPath) {
  try {
    const toplevel = await getRepositoryRootPath(projectPath);
    if (!toplevel) return false;
    const [realToplevel, realProject] = await Promise.all([
      fs.realpath(toplevel),
      fs.realpath(projectPath),
    ]);
    return realToplevel === realProject;
  } catch {
    return false;
  }
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
 * this guard ANY authenticated account (including plain `user` roles)
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

    const overlay = requireGitReadWorkspace({
      projectPath,
      query: req.query,
      principalId: req.user?.id ?? null,
    });

    const branch = await getCurrentBranchName(projectPath);
    const hasCommits = await repositoryHasCommits(overlay?.cwd ?? projectPath);

    if (overlay) {
      return res.json({ branch, hasCommits, ...(await readGitWorkspaceStatus(overlay)) });
    }

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
    const detail = String(error?.message || '');
    if (/principal mismatch|session overlay not found|legacy session has no isolated workspace/.test(detail)) {
      return res.status(404).json({ error: 'Session overlay not found' });
    }
    if (/stale overlay generation/.test(detail)) {
      return res.status(409).json({ error: 'Session overlay generation is stale' });
    }
    if (/must be supplied together|invalid overlay generation/.test(detail)) {
      return res.status(400).json({ error: 'Session id and overlay generation are required together' });
    }
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

    const overlay = requireGitReadWorkspace({
      projectPath,
      query: req.query,
      principalId: req.user?.id ?? null,
    });

    const {
      repositoryRootPath,
      repositoryRelativeFilePath,
    } = await resolveRepositoryFilePath(overlay?.cwd ?? projectPath, file);

    if (overlay) {
      return res.json({ diff: await readGitWorkspaceDiff(overlay, repositoryRelativeFilePath) });
    }

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
    const detail = String(error?.message || '');
    if (/principal mismatch|session overlay not found|legacy session has no isolated workspace/.test(detail)) {
      return res.status(404).json({ error: 'Session overlay not found' });
    }
    if (/stale overlay generation/.test(detail)) {
      return res.status(409).json({ error: 'Session overlay generation is stale' });
    }
    if (/must be supplied together|invalid overlay generation/.test(detail)) {
      return res.status(400).json({ error: 'Session id and overlay generation are required together' });
    }
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

    if (!claimCurrentIdentity(req, res)) return;
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
  
  if (!project || typeof message !== 'string' || !message.trim() || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'Project name, commit message, and files are required' });
  }
  if (!CONVENTIONAL_COMMIT_PATTERN.test(message.trim())) {
    return res.status(400).json({ error: 'Commit message must follow Conventional Commits' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    
    // Validate git repository
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    
    // Resolve and authorize every selected path before the arbiter captures an
    // immutable request. Selected worktree bytes never pass through the shared
    // default index.
    const repositoryRelativeFilePaths = [];
    for (const file of files) {
      const { repositoryRelativeFilePath } = await resolveRepositoryFilePath(projectPath, file);
      repositoryRelativeFilePaths.push(repositoryRelativeFilePath);
    }

    // The per-user identity remains transient and is passed only to the final
    // commit-tree operation. It is never persisted in the request manifest.
    const authorEnv = buildGitAuthorEnv(req.user?.id);
    if (!claimCurrentIdentity(req, res)) return;
    const result = await commitSelectedPathsWithArbiter({
      repositoryRootPath,
      repositoryRelativeFilePaths,
      message: message.trim(),
      authorEnv,
    });

    res.json({
      success: true,
      output: result.commit,
      commit: result.commit,
      sequence: result.sequence,
      previewQueued: true,
      needsReconciliation: result.needsReconciliation,
      reconciliationRef: result.reconciliationRef,
    });
  } catch (error) {
    console.error('Git commit error:', error);
    if (error.committedResult) {
      return res.json({
        success: true,
        output: error.committedResult.commit,
        commit: error.committedResult.commit,
        sequence: error.committedResult.sequence,
        previewQueued: false,
        needsReconciliation: error.committedResult.needsReconciliation,
        reconciliationRef: error.committedResult.reconciliationRef,
        warning: 'Commit created, but the live preview could not be queued.',
      });
    }
    if (String(error?.message || '').includes('commit message must follow Conventional Commits')) {
      return res.status(400).json({ error: 'Commit message must follow Conventional Commits' });
    }
    if (/path already leased|owned-path conflict|default index staged-intent conflict|default index changed during cutover|CAS retry limit/.test(String(error?.message || ''))) {
      return res.status(409).json({
        error: toSafeGitFailureDetails(error, 'Selected files conflict with another commit'),
        conflict: error.commitConflict ?? null,
      });
    }
    res.status(500).json({ error: toSafeGitFailureDetails(error, 'Git operation failed') });
  }
});

// Re-capture a previously conflicting request from the now-resolved worktree.
// The arbiter renews the original session fence and keeps the original request
// ref durable for audit/recovery.
router.post('/resolve-commit-conflict', async (req, res) => {
  const { project, requestId, message } = req.body;
  if (!project || typeof requestId !== 'string'
      || typeof message !== 'string' || !CONVENTIONAL_COMMIT_PATTERN.test(message.trim())) {
    return res.status(400).json({ error: 'Project, conflict request id, and Conventional Commit message are required' });
  }
  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    if (!claimCurrentIdentity(req, res)) return;
    const result = resumeRequest({
      repo: repositoryRootPath,
      requestId,
      message: message.trim(),
      authorEnv: buildGitAuthorEnv(req.user?.id),
    });
    try {
      await dispatchCommittedPreview(repositoryRootPath, `git-${result.commit}`, result);
      return res.json({ success: true, commit: result.commit, sequence: result.sequence, output: result.commit, previewQueued: true });
    } catch (error) {
      return res.json({
        success: true,
        commit: result.commit,
        sequence: result.sequence,
        output: result.commit,
        previewQueued: false,
        warning: 'Commit created, but the live preview could not be queued.',
      });
    }
  } catch (error) {
    const detail = String(error?.message || '');
    if (/owned-path conflict|default index staged-intent conflict|default index changed during cutover/.test(detail)) {
      return res.status(409).json({
        error: toSafeGitFailureDetails(error, 'Resolved files still conflict'),
        conflict: error.commitConflict ?? null,
      });
    }
    if (/invalid arbiter request id|ENOENT|request ref no longer matches/.test(detail)) {
      return res.status(404).json({ error: 'Commit conflict request not found' });
    }
    return res.status(500).json({ error: toSafeGitFailureDetails(error, 'Commit conflict could not be resumed') });
  }
});

// Commit an isolated session overlay. Unlike /commit, this route never reads
// bytes from the logical project's shared worktree.
router.post('/commit-session-overlay', async (req, res) => {
  const { project, message, files, renames = [], sessionId, generation } = req.body;
  if (!project || typeof message !== 'string' || !message.trim()
      || !Array.isArray(files) || files.length === 0
      || files.some((file) => typeof file !== 'string' || !file.trim())
      || !Array.isArray(renames)
      || renames.some((rename) => !rename || typeof rename !== 'object'
        || typeof rename.from !== 'string' || !rename.from.trim()
        || typeof rename.to !== 'string' || !rename.to.trim())
      || typeof sessionId !== 'string' || !sessionId.trim()
      || typeof generation !== 'string' || !generation.trim()) {
    return res.status(400).json({
      error: 'Project, files, commit message, session id, and overlay generation are required',
    });
  }
  if (!CONVENTIONAL_COMMIT_PATTERN.test(message.trim())) {
    return res.status(400).json({ error: 'Commit message must follow Conventional Commits' });
  }

  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    const repositoryRelativeFilePaths = [];
    for (const file of files) {
      const resolved = await resolveRepositoryFilePath(projectPath, file);
      repositoryRelativeFilePaths.push(resolved.repositoryRelativeFilePath);
    }
    const resolvedRenames = [];
    for (const rename of renames) {
      const from = await resolveRepositoryFilePath(projectPath, rename.from);
      const to = await resolveRepositoryFilePath(projectPath, rename.to);
      resolvedRenames.push({
        from: from.repositoryRelativeFilePath,
        to: to.repositoryRelativeFilePath,
      });
      repositoryRelativeFilePaths.push(from.repositoryRelativeFilePath, to.repositoryRelativeFilePath);
    }
    const uniqueRepositoryPaths = [...new Set(repositoryRelativeFilePaths)];
    if (!claimCurrentIdentity(req, res)) return;
    const result = await submitSessionOverlay({
      repositoryRootPath,
      projectPath,
      repositoryRelativeFilePaths: uniqueRepositoryPaths,
      renames: resolvedRenames,
      sessionId: sessionId.trim(),
      generation: generation.trim(),
      principalId: req.user?.id ?? null,
      message: message.trim(),
      authorEnv: buildGitAuthorEnv(req.user?.id),
    });
    return res.json({
      success: true,
      output: result.commit,
      commit: result.commit,
      sequence: result.sequence,
      previewQueued: true,
      needsReconciliation: result.needsReconciliation,
      reconciliationRef: result.reconciliationRef,
    });
  } catch (error) {
    console.error('Session overlay commit error:', error);
    if (error.committedResult) {
      return res.json({
        success: true,
        output: error.committedResult.commit,
        commit: error.committedResult.commit,
        sequence: error.committedResult.sequence,
        previewQueued: false,
        needsReconciliation: error.committedResult.needsReconciliation,
        reconciliationRef: error.committedResult.reconciliationRef,
        warning: 'Commit created, but the live preview could not be queued.',
      });
    }
    const detail = String(error?.message || '');
    if (/principal mismatch|session overlay not found/.test(detail)) {
      return res.status(404).json({ error: 'Session overlay not found' });
    }
    if (/stale overlay generation|owned-path conflict|CAS retry limit/.test(detail)) {
      return res.status(409).json({
        error: toSafeGitFailureDetails(error, 'Session overlay is stale or conflicts'),
        conflict: error.commitConflict ?? null,
      });
    }
    if (/no tracked change|invalid overlay path|submitted patch/.test(detail)) {
      return res.status(400).json({ error: toSafeGitFailureDetails(error, 'Overlay file cannot be committed') });
    }
    return res.status(500).json({ error: toSafeGitFailureDetails(error, 'Session overlay commit failed') });
  }
});

router.post('/resolve-session-overlay-conflict', async (req, res) => {
  const { project, requestId, sessionId, generation, message } = req.body;
  if (!project || typeof requestId !== 'string' || !requestId.trim()
      || typeof sessionId !== 'string' || !sessionId.trim()
      || typeof generation !== 'string' || !generation.trim()
      || typeof message !== 'string' || !CONVENTIONAL_COMMIT_PATTERN.test(message.trim())) {
    return res.status(400).json({
      error: 'Project, request id, session id, generation, and Conventional Commit message are required',
    });
  }
  try {
    const projectPath = await getActualProjectPath(project, req);
    await validateGitRepository(projectPath);
    const repositoryRootPath = await getRepositoryRootPath(projectPath);
    if (!claimCurrentIdentity(req, res)) return;
    const result = await resolveSessionOverlayConflict({
      repositoryRootPath,
      projectPath,
      requestId: requestId.trim(),
      sessionId: sessionId.trim(),
      generation: generation.trim(),
      principalId: req.user?.id ?? null,
      message: message.trim(),
      authorEnv: buildGitAuthorEnv(req.user?.id),
    });
    return res.json({
      success: true,
      commit: result.commit,
      sequence: result.sequence,
      output: result.commit,
      previewQueued: true,
    });
  } catch (error) {
    const detail = String(error?.message || '');
    if (/principal mismatch|session overlay conflict mismatch|session overlay not found|invalid arbiter request id|ENOENT|request ref no longer matches/.test(detail)) {
      return res.status(404).json({ error: 'Session overlay conflict not found' });
    }
    if (/stale overlay generation|owned-path conflict|CAS retry limit/.test(detail)) {
      return res.status(409).json({
        error: toSafeGitFailureDetails(error, 'Resolved overlay still conflicts'),
        conflict: error.commitConflict ?? null,
      });
    }
    return res.status(500).json({
      error: toSafeGitFailureDetails(error, 'Session overlay conflict could not be resolved'),
    });
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
      if (!claimCurrentIdentity(req, res)) return;
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
    if (!claimCurrentIdentity(req, res)) return;
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
    if (!claimCurrentIdentity(req, res)) return;
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

    if (!claimCurrentIdentity(req, res)) return;
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

    const registeredProject = projectsDb.getProjectPath(projectPath)
      ?? projectsDb.getProjectPath(repositoryRootPath);
    const userId = coerceUserId(req.user?.id);
    if (!registeredProject?.project_id || userId === null) {
      return res.status(503).json({
        error: 'Permission launch context is unavailable.',
        code: 'PERMISSION_LAUNCH_CONTEXT_INVALID',
        notStarted: true,
      });
    }
    let permissionExecution;
    try {
      const authorizeProviderExecution = req.app?.locals?.authorizeProviderExecution;
      if (typeof authorizeProviderExecution !== 'function') {
        throw new Error('PERMISSION_AUTHORIZER_UNAVAILABLE');
      }
      const permission = authorizeProviderExecution(req.user, {
        launchId: randomUUID(),
        principalId: `user:${userId}`,
        sessionId: null,
        projectId: registeredProject.project_id,
        workspacePath: repositoryRootPath,
        provider,
        body: provider,
        engine: provider === 'claude' ? 'sdk' : 'cli',
        entrypoint: 'rest.git.generate-commit-message',
        purpose: provider === 'claude' ? 'sdk_turn' : 'spawn',
      });
      if (permission.kind === 'denied') {
        return res.status(403).json({
          error: 'The requested permission profile is unavailable.',
          code: 'PERMISSION_DENIED',
          reasonCodes: permission.reasonCodes,
          notStarted: true,
        });
      }
      permissionExecution = permission.execution;
    } catch (error) {
      return res.status(503).json({
        error: 'Permission admission failed closed.',
        code: error?.code || 'PERMISSION_ADMISSION_UNAVAILABLE',
        notStarted: true,
      });
    }

    // Generate commit message using AI
    const message = await generateCommitMessageWithAI(
      files,
      diffContext,
      provider,
      projectPath,
      permissionExecution,
      req.user?.id ?? null,
    );

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
 * @param {object} permissionExecution - Admitted permission execution handle
 * @param {number|null} userId - Authenticated user (req.user.id); lets
 *   administrative revocation (B-1327) find and stop this run.
 * @returns {Promise<string>} Generated commit message
 */
async function generateCommitMessageWithAI(
  files,
  diffContext,
  provider,
  projectPath,
  permissionExecution,
  userId,
) {
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
    const writer = stampWriterEpoch({
      userId,
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
    });

    console.log('🚀 Calling AI agent with provider:', provider);
    console.log('📝 Prompt length:', prompt.length);

    // Call the appropriate agent
    if (provider === 'claude') {
      await queryClaudeSDK(prompt, {
        cwd: projectPath,
        permissionMode: 'bypassPermissions',
        model: 'sonnet',
        permissionExecution,
      }, writer);
    } else if (provider === 'cursor') {
      await runPermissionExecutionAdapter(permissionExecution, () => spawnCursor(prompt, {
        cwd: projectPath,
        skipPermissions: true
      }, writer));
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

    // Whether this folder is the repo root, not a nested subfolder that git
    // resolves upward to an ancestor repository. The push reminder relies on
    // this so it never inherits an ancestor repo's ahead count.
    const isRepositoryRoot = await isProjectRepositoryRoot(projectPath);

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
        isRepositoryRoot,
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
        isRepositoryRoot,
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
      isRepositoryRoot,
      branch,
      remoteBranch: trackingBranch,
      remoteName,
      ahead: ahead || 0,
      behind: behind || 0,
      isUpToDate: ahead === 0 && behind === 0
    });
  } catch (error) {
    console.error('Git remote status error:', error);
    res.json({ isRepositoryRoot: false, error: toSafeGitFailureDetails(error, 'Git operation failed') });
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
    if (!claimCurrentIdentity(req, res)) return;
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
    if (!claimCurrentIdentity(req, res)) return;
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
router.post('/push', requireOwnerReleaseBroker, async (req, res) => {
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

    if (!claimCurrentIdentity(req, res)) return;
    const credentialLease = await resolvePushCredentialLease(projectPath, remoteName, req.user?.id);
    let stdout;
    try {
      ({ stdout } = await spawnAsync(
        'git',
        ['push', remoteName, remoteBranch],
        buildPushSpawnOptions(projectPath, credentialLease),
      ));
    } finally {
      await credentialLease.cleanup();
    }

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
router.post('/publish', requireOwnerReleaseBroker, async (req, res) => {
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

    // Publish through the same canonical-remote askpass lease as ordinary push.
    validateRemoteName(remoteName);
    if (!claimCurrentIdentity(req, res)) return;
    const credentialLease = await resolvePushCredentialLease(projectPath, remoteName, req.user?.id);
    let stdout;
    try {
      ({ stdout } = await spawnAsync(
        'git',
        ['push', '--set-upstream', remoteName, branch],
        buildPushSpawnOptions(projectPath, credentialLease),
      ));
    } finally {
      await credentialLease.cleanup();
    }

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

    if (!claimCurrentIdentity(req, res)) return;

    if (status === '??') {
      // Untracked file or directory - delete it
      const filePath = path.join(repositoryRootPath, repositoryRelativeFilePath);
      const stats = await fs.stat(filePath);
      if (!claimCurrentIdentity(req, res)) return;

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

    if (!claimCurrentIdentity(req, res)) return;

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
