import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const OVERLAY_SCHEMA = 1;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
const DEFAULT_REAP_AGE_MS = 24 * 60 * 60_000;
const CANONICAL_OVERLAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function runGit(cwd, args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', ['-C', cwd, ...args], {
    encoding,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  if (result.status !== 0 && !allowFailure) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString() : result.stderr;
    throw new Error(`git ${args.join(' ')} failed: ${detail.trim() || `exit ${result.status}`}`);
  }
  return result;
}

function gitText(cwd, args) {
  return runGit(cwd, args).stdout.trim();
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function resolveProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new Error('logical project path is required');
  }
  const inputProjectPath = path.resolve(projectPath.trim());
  const logicalProjectPath = fs.realpathSync(inputProjectPath);
  if (!fs.statSync(logicalProjectPath).isDirectory()) {
    throw new Error('logical project path must be a directory');
  }
  return { inputProjectPath, logicalProjectPath };
}

function tryResolveOverlayRepository(projectPath) {
  const { inputProjectPath, logicalProjectPath } = resolveProjectPath(projectPath);
  const rootProbe = runGit(logicalProjectPath, ['rev-parse', '--show-toplevel'], {
    allowFailure: true,
  });
  if (rootProbe.status !== 0) {
    const detail = Buffer.isBuffer(rootProbe.stderr)
      ? rootProbe.stderr.toString()
      : String(rootProbe.stderr ?? '');
    if (/\bfatal: not a git repository\b/.test(detail)) {
      return {
        kind: 'non_repository',
        logicalProjectPath,
        canonicalInput: inputProjectPath === logicalProjectPath,
      };
    }
    throw new Error(`git rev-parse --show-toplevel failed: ${detail.trim() || `exit ${rootProbe.status}`}`);
  }
  const repositoryRoot = fs.realpathSync(rootProbe.stdout.trim());
  if (logicalProjectPath !== repositoryRoot) {
    return {
      kind: 'repository_subdirectory',
      logicalProjectPath,
      repositoryRoot,
      canonicalInput: inputProjectPath === logicalProjectPath,
    };
  }
  const commonDirText = gitText(repositoryRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonGitDir = fs.realpathSync(commonDirText);
  return {
    kind: 'exact_repository',
    logicalProjectPath,
    repository: { logicalProjectPath, repositoryRoot, commonGitDir },
  };
}

function resolveRepository(projectPath) {
  const resolved = tryResolveOverlayRepository(projectPath);
  if (resolved.kind !== 'exact_repository') {
    throw new Error('session overlays currently require the project path to be the repository root');
  }
  return resolved.repository;
}

function stateRoot(repository) {
  return path.join(repository.commonGitDir, 'nassaj-session-overlays');
}

function withStateLock(root, operation, timeoutMs = 15_000) {
  const lock = path.join(root, '.lock');
  fs.mkdirSync(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || Date.now() >= deadline) {
        throw new Error('session overlay lock timeout');
      }
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
        if (Date.now() - owner.at > timeoutMs * 2) fs.rmSync(lock, { recursive: true, force: true });
      } catch {}
      Atomics.wait(sleepBuffer, 0, 0, 20);
    }
  }
  try {
    return operation();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonNoFollow(file) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error('workspace metadata is not a regular file');
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function aliasFile(root, kind, key) {
  return path.join(root, 'aliases', kind, `${digest(key)}.json`);
}

function manifestFile(root, overlayId) {
  return path.join(root, 'instances', overlayId, 'manifest.json');
}

function readAliasedManifest(root, kind, key) {
  const alias = readJson(aliasFile(root, kind, key));
  if (!alias || typeof alias.overlayId !== 'string') return null;
  const manifest = readJson(manifestFile(root, alias.overlayId));
  if (!manifest || manifest.schema !== OVERLAY_SCHEMA) return null;
  return manifest;
}

/**
 * Resume-time alias reader. Unlike the idempotent creation helper above, this
 * distinguishes a genuinely absent alias from corrupt or dangling state. Only
 * genuine absence may cross the one-time legacy compatibility boundary.
 */
function readStrictSessionManifest(root, sessionId, repository, ownerPrincipalId, checkPrincipal = true) {
  const file = aliasFile(root, 'session', sessionId);
  try {
    const aliasStat = fs.lstatSync(file);
    if (!aliasStat.isFile() || aliasStat.isSymbolicLink()) {
      throw new Error('unsafe alias node');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('session overlay alias is malformed');
  }
  let alias;
  try {
    alias = readJsonNoFollow(file);
  } catch {
    throw new Error('session overlay alias is malformed');
  }
  if (!alias || alias.schema !== OVERLAY_SCHEMA || typeof alias.overlayId !== 'string'
      || !CANONICAL_OVERLAY_ID.test(alias.overlayId)) {
    throw new Error('session overlay alias is malformed');
  }
  const instancesRoot = path.join(root, 'instances');
  const instanceRoot = path.join(instancesRoot, alias.overlayId);
  let trustedInstancesRoot;
  let trustedInstanceRoot;
  try {
    const instancesStat = fs.lstatSync(instancesRoot);
    const instanceStat = fs.lstatSync(instanceRoot);
    if (!instancesStat.isDirectory() || instancesStat.isSymbolicLink()
        || !instanceStat.isDirectory() || instanceStat.isSymbolicLink()) {
      throw new Error('unsafe overlay instance node');
    }
    trustedInstancesRoot = fs.realpathSync(instancesRoot);
    trustedInstanceRoot = fs.realpathSync(instanceRoot);
  } catch {
    throw new Error('session overlay instance is malformed');
  }
  if (path.dirname(trustedInstanceRoot) !== trustedInstancesRoot
      || path.basename(trustedInstanceRoot) !== alias.overlayId) {
    throw new Error('session overlay instance escaped its trusted root');
  }
  let manifest;
  try {
    manifest = readJsonNoFollow(path.join(trustedInstanceRoot, 'manifest.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('session overlay alias is dangling');
    throw new Error('session overlay manifest is malformed');
  }
  if (!manifest) throw new Error('session overlay alias is dangling');
  if (manifest.schema !== OVERLAY_SCHEMA || manifest.overlayId !== alias.overlayId
      || manifest.sessionId !== sessionId || manifest.state !== 'active'
      || manifest.logicalProjectPath !== repository.logicalProjectPath
      || manifest.repositoryRoot !== repository.repositoryRoot) {
    throw new Error('session overlay manifest mismatch');
  }
  if (checkPrincipal && manifest.ownerPrincipalId !== ownerPrincipalId) {
    throw new Error('session overlay principal mismatch');
  }
  let workspace;
  try {
    const workspaceStat = fs.lstatSync(manifest.cwd);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw new Error('unsafe workspace node');
    }
    workspace = fs.realpathSync(manifest.cwd);
  } catch {
    throw new Error('session overlay workspace is unavailable');
  }
  const expected = path.join(trustedInstanceRoot, 'workspace');
  if (workspace !== fs.realpathSync(expected)) throw new Error('session overlay cwd mismatch');
  return manifest;
}

/** Boot-only structural probe used to ratchet pre-existing valid aliases in the ledger. */
export function probeSessionWorkspaceAlias({ projectPath, sessionId }) {
  const resolved = tryResolveOverlayRepository(projectPath);
  // Overlay creation requires an exact repository root. Therefore a declared
  // shared workspace (non-repository or repository subdirectory) cannot own an
  // alias at this logical path; absence is the only valid state. Canonical-path
  // enforcement keeps aliases/symlink substitutions deny-fenced.
  if (resolved.kind === 'non_repository' || resolved.kind === 'repository_subdirectory') {
    return resolved.canonicalInput ? 'absent' : 'present_invalid';
  }
  const { repository } = resolved;
  const root = stateRoot(repository);
  const file = aliasFile(root, 'session', sessionId);
  try {
    fs.lstatSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'absent';
    return 'present_invalid';
  }
  try {
    return readStrictSessionManifest(root, sessionId, repository, null, false)
      ? 'present_valid'
      : 'present_invalid';
  } catch {
    return 'present_invalid';
  }
}

function publicBinding(manifest, isolation = 'overlay') {
  return Object.freeze({
    isolation,
    logicalProjectPath: manifest.logicalProjectPath,
    cwd: manifest.cwd,
    baseOid: manifest.baseOid,
    overlayId: manifest.overlayId,
    sessionId: manifest.sessionId ?? null,
    generation: manifest.generation ?? null,
  });
}

/**
 * Declared non-overlay binding for a project that cannot host a linked
 * worktree. A non-git folder or a repository subdirectory degrades onto its own
 * canonical directory instead of failing the launch. The `isolation` tag is
 * always explicit — never 'overlay' — so upper layers can surface the reduced
 * isolation to the user, log it, and record resume eligibility, while every
 * overlay-only API (patch capture, durable submit) keeps rejecting it
 * fail-closed. The cwd is the realpath-resolved logical path, so no symlink can
 * substitute the directory after resolution.
 * @param {'legacy_shared'} isolation
 * @param {string} logicalProjectPath canonical (realpath-resolved) directory
 * @param {string|null} sessionId
 */
function sharedWorkspaceBinding(isolation, logicalProjectPath, sessionId) {
  return Object.freeze({
    isolation,
    logicalProjectPath,
    cwd: logicalProjectPath,
    baseOid: null,
    overlayId: null,
    sessionId: sessionId ?? null,
    generation: null,
  });
}

function normalizePrincipalId(principalId) {
  if (principalId == null) return null;
  if ((typeof principalId !== 'string' && typeof principalId !== 'number')
      || !String(principalId).trim() || String(principalId).length > 128) {
    throw new Error('invalid overlay principal');
  }
  return String(principalId);
}

/**
 * Creates an immutable-HEAD linked worktree for a new launch. The linked
 * worktree lives on disk under the repository's common `.git` directory; no
 * tmpfs path and no shared working-tree file is used.
 * @param {{projectPath: string, launchKey: string, baseRef?: string, principalId?: string|number|null}} input
 */
export function createSessionWorkspace({ projectPath, launchKey, baseRef = 'HEAD', principalId = null }) {
  if (typeof launchKey !== 'string' || !launchKey.trim() || launchKey.length > 512) {
    throw new Error('a bounded launch key is required');
  }
  const repository = resolveRepository(projectPath);
  const root = stateRoot(repository);
  const ownerPrincipalId = normalizePrincipalId(principalId);
  return withStateLock(root, () => {
    const existing = readAliasedManifest(root, 'launch', launchKey);
    if (existing) {
      if (existing.logicalProjectPath !== repository.logicalProjectPath) {
        throw new Error('launch key is already bound to another project');
      }
      if (existing.ownerPrincipalId !== ownerPrincipalId) {
        throw new Error('launch key is already bound to another principal');
      }
      return publicBinding(existing);
    }

    const baseOid = gitText(repository.repositoryRoot, ['rev-parse', `${baseRef}^{commit}`]);
    const overlayId = crypto.randomUUID();
    const instanceRoot = path.join(root, 'instances', overlayId);
    const cwd = path.join(instanceRoot, 'workspace');
    fs.mkdirSync(instanceRoot, { recursive: true });
    try {
      runGit(repository.repositoryRoot, ['worktree', 'add', '--detach', cwd, baseOid]);
      const manifest = {
        schema: OVERLAY_SCHEMA,
        overlayId,
        logicalProjectPath: repository.logicalProjectPath,
        repositoryRoot: repository.repositoryRoot,
        cwd,
        baseOid,
        sessionId: null,
        generation: crypto.randomUUID(),
        ownerPrincipalId,
        state: 'active',
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        launchAliasDigest: digest(launchKey),
      };
      atomicJson(manifestFile(root, overlayId), manifest);
      atomicJson(aliasFile(root, 'launch', launchKey), { schema: OVERLAY_SCHEMA, overlayId });
      return publicBinding(manifest);
    } catch (error) {
      runGit(repository.repositoryRoot, ['worktree', 'remove', '--force', cwd], { allowFailure: true });
      fs.rmSync(instanceRoot, { recursive: true, force: true });
      throw error;
    }
  });
}

/**
 * Bind the provider's durable id to the already-created launch overlay.
 * @param {{projectPath: string, launchKey: string, sessionId: string, principalId?: string|number|null}} input
 */
export function bindSessionWorkspace({ projectPath, launchKey, sessionId, principalId = null }) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 512) {
    throw new Error('a bounded session id is required');
  }
  const repository = resolveRepository(projectPath);
  const root = stateRoot(repository);
  const ownerPrincipalId = normalizePrincipalId(principalId);
  return withStateLock(root, () => {
    const manifest = readAliasedManifest(root, 'launch', launchKey);
    if (!manifest || manifest.logicalProjectPath !== repository.logicalProjectPath) {
      throw new Error('launch overlay was not found');
    }
    if (manifest.ownerPrincipalId !== ownerPrincipalId) {
      throw new Error('launch overlay principal mismatch');
    }
    const existing = readAliasedManifest(root, 'session', sessionId);
    if (existing && existing.overlayId !== manifest.overlayId) {
      throw new Error('session id is already bound to another overlay');
    }
    const bound = { ...manifest, sessionId, lastUsedAt: new Date().toISOString() };
    atomicJson(manifestFile(root, manifest.overlayId), bound);
    atomicJson(aliasFile(root, 'session', sessionId), {
      schema: OVERLAY_SCHEMA,
      overlayId: manifest.overlayId,
    });
    return publicBinding(bound);
  });
}

/**
 * Resolves a launch cwd. Unknown resumed sessions are deliberately quarantined
 * on the legacy shared cwd; they are never silently migrated mid-conversation.
 * @param {{projectPath: string, sessionId?: string|null, launchKey?: string|null, principalId?: string|number|null}} input
 */
export function resolveSessionWorkspace({ projectPath, sessionId = null, launchKey = null, principalId = null }) {
  const repository = resolveRepository(projectPath);
  const root = stateRoot(repository);
  const ownerPrincipalId = normalizePrincipalId(principalId);
  if (sessionId) {
    const manifest = readStrictSessionManifest(
      root, sessionId, repository, ownerPrincipalId,
    );
    if (!manifest) {
      throw new Error('legacy session has no isolated workspace');
    }
    return publicBinding(manifest);
  }
  return createSessionWorkspace({
    projectPath: repository.logicalProjectPath,
    launchKey,
    principalId: ownerPrincipalId,
  });
}

/**
 * Launch-only resolver used at the provider boundary.
 *
 * - new launch on a repository root: creates an isolated overlay;
 * - new launch on a non-git folder or a repository subdirectory: cannot host a
 *   linked worktree, so it degrades onto the canonical project directory as a
 *   declared `legacy_shared` binding — graceful, never silent, so the launch is never
 *   blocked merely because the project is not a git repository root;
 * - resumed valid alias: returns its overlay (overlay always wins);
 * - resumed, genuinely missing alias + migration eligibility: returns the
 *   trusted legacy project directory as `legacy_shared`;
 * - every malformed/dangling/mismatched alias throws fail-closed.
 *
 * Non-overlay shapes are trusted only at their canonical physical path, closing
 * alias substitution uniformly for new launch and resume. The resume
 * eligibility bit must come from the server's migration ledger; the resolver
 * never re-derives it. A missing project directory throws ENOENT and must be
 * refused before provider launch. Client cwd is deliberately not accepted by
 * this API.
 * @param {{projectPath: string, sessionId?: string|null, launchKey?: string|null,
 *   principalId?: string|number|null, legacyEligible?: boolean}} input
 */
export function resolveSessionWorkspaceForLaunch({
  projectPath,
  sessionId = null,
  launchKey = null,
  principalId = null,
  legacyEligible = false,
}) {
  const resolved = tryResolveOverlayRepository(projectPath);
  // Alias-substitution guard for every non-overlay shape (non-git folder or
  // repository subdirectory): trust it only at its canonical physical path. An
  // exact repository root is already canonicalized by the Git probe.
  if (resolved.kind !== 'exact_repository' && resolved.canonicalInput !== true) {
    throw new Error('legacy project path must be its canonical physical path');
  }
  const repository = resolved.kind === 'exact_repository' ? resolved.repository : null;
  const ownerPrincipalId = normalizePrincipalId(principalId);

  if (!sessionId) {
    if (repository) {
      return createSessionWorkspace({
        projectPath: repository.logicalProjectPath,
        launchKey,
        principalId: ownerPrincipalId,
      });
    }
    // A non-git folder or a repository subdirectory cannot own a linked
    // worktree. Degrade explicitly onto the canonical directory; the declared
    // `legacy_shared` isolation preserves the existing cross-layer contract and
    // lets the upper layer persist resume eligibility. It is deliberately not
    // 'overlay', so patch capture and
    // durable submit keep rejecting it.
    return sharedWorkspaceBinding('legacy_shared', resolved.logicalProjectPath, null);
  }

  // Resume is driven solely by the exact migration/runtime ledger binding.
  // Repository subdirectories never own overlay aliases, but a ledger-attested
  // shared session resumes on that same canonical subdirectory.
  const manifest = repository
    ? readStrictSessionManifest(
      stateRoot(repository), sessionId, repository, ownerPrincipalId,
    )
    : null;
  if (manifest) return publicBinding(manifest);
  if (legacyEligible !== true) throw new Error('session has no isolated workspace');
  // This compatibility path is shared by definition. Canonicalization narrows
  // alias substitution, while filesystem TOCTOU remains bounded to legacy use.
  return sharedWorkspaceBinding('legacy_shared', resolved.logicalProjectPath, sessionId);
}

/** Resolve an exact, owner-bound session generation for a production submit. */
export function requireBoundSessionWorkspace({ projectPath, sessionId, generation, principalId }) {
  if (typeof generation !== 'string' || !generation.trim() || generation.length > 128) {
    throw new Error('invalid overlay generation');
  }
  const binding = resolveSessionWorkspace({ projectPath, sessionId, principalId });
  if (binding.isolation !== 'overlay' || !binding.overlayId) {
    throw new Error('session overlay not found');
  }
  if (binding.generation !== generation) throw new Error('stale overlay generation');
  return binding;
}

function normalizeOverlayPath(candidate) {
  if (typeof candidate !== 'string' || !candidate || path.isAbsolute(candidate)
      || candidate.includes('\0')) throw new Error('invalid overlay path');
  const ownedPath = candidate.replaceAll('\\', '/').replace(/^\.\//, '');
  const segments = ownedPath.split('/');
  if (segments.some((segment) => !segment || segment === '..' || segment === '.')) {
    throw new Error('invalid overlay path');
  }
  return { ownedPath, segments };
}

/**
 * Read immutable bytes through a held directory-descriptor chain. `/proc/self/fd`
 * gives Node an openat-like resolution anchor: replacing any pathname parent
 * after it is opened cannot redirect the final read outside that directory.
 */
export function readSessionFileBlob(binding, candidate, options = {}) {
  if (!binding || binding.isolation !== 'overlay' || typeof binding.cwd !== 'string') {
    throw new Error('an active overlay binding is required');
  }
  const { ownedPath, segments } = normalizeOverlayPath(candidate);
  const tracked = runGit(binding.cwd, ['cat-file', '-e', `${binding.baseOid}:${ownedPath}`], {
    allowFailure: true,
  }).status === 0;
  const descriptors = [];
  try {
    let parentFd = fs.openSync(
      fs.realpathSync(binding.cwd),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    descriptors.push(parentFd);
    for (const segment of segments.slice(0, -1)) {
      parentFd = fs.openSync(
        `/proc/self/fd/${parentFd}/${segment}`,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      descriptors.push(parentFd);
    }
    options.beforeTargetOpen?.();
    let targetFd;
    try {
      targetFd = fs.openSync(
        `/proc/self/fd/${parentFd}/${segments.at(-1)}`,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (error.code === 'ENOENT' && tracked) return { path: ownedPath, deleted: true };
      throw error;
    }
    descriptors.push(targetFd);
    const stat = fs.fstatSync(targetFd);
    if (!stat.isFile()) throw new Error(`overlay path is not a safe file: ${ownedPath}`);
    const body = fs.readFileSync(targetFd);
    const mode = stat.mode & 0o111 ? '100755' : '100644';
    const base = runGit(binding.cwd, ['show', `${binding.baseOid}:${ownedPath}`], {
      allowFailure: true,
      encoding: null,
    });
    if (tracked && base.status === 0 && Buffer.compare(base.stdout, body) === 0) {
      throw new Error(`overlay path has no change: ${ownedPath}`);
    }
    return { path: ownedPath, body, mode };
  } finally {
    for (const descriptor of descriptors.reverse()) fs.closeSync(descriptor);
  }
}

/** Capture several immutable tracked, added, deleted, or rename-side blobs. */
export function readSessionSubmittedBlobs(binding, ownedPaths) {
  if (!Array.isArray(ownedPaths) || ownedPaths.length === 0) {
    throw new Error('at least one overlay path is required');
  }
  const unique = [...new Set(ownedPaths)];
  if (unique.length !== ownedPaths.length) throw new Error('duplicate overlay path');
  return unique.map((ownedPath) => readSessionFileBlob(binding, ownedPath));
}

function removeOverlayRefs(repositoryRoot, overlayId) {
  const prefix = `refs/nassaj/requests/overlay-${overlayId}/`;
  const listed = gitText(repositoryRoot, ['for-each-ref', '--format=%(refname)', prefix]);
  for (const ref of listed.split('\n').filter(Boolean)) {
    runGit(repositoryRoot, ['update-ref', '-d', ref], { allowFailure: true });
  }
}

/** Reap stale overlay worktrees, aliases, durable request refs, and manifests. */
export function reapSessionWorkspaces({ projectPath, maxAgeMs = DEFAULT_REAP_AGE_MS, now = Date.now() }) {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) throw new Error('invalid overlay reap age');
  const repository = resolveRepository(projectPath);
  const root = stateRoot(repository);
  return withStateLock(root, () => {
    const instancesRoot = path.join(root, 'instances');
    const reaped = [];
    for (const entry of fs.existsSync(instancesRoot) ? fs.readdirSync(instancesRoot) : []) {
      const manifest = readJson(manifestFile(root, entry));
      const lastUsed = Date.parse(manifest?.lastUsedAt ?? manifest?.createdAt ?? '');
      // A durable provider session owns its worktree until an explicit session
      // lifecycle action removes it. Age-based cleanup is only for launches
      // that never reached a provider session id.
      if (!manifest || manifest.sessionId || !Number.isFinite(lastUsed)
          || now - lastUsed < maxAgeMs) continue;
      runGit(repository.repositoryRoot, ['worktree', 'remove', '--force', manifest.cwd], {
        allowFailure: true,
      });
      removeOverlayRefs(repository.repositoryRoot, manifest.overlayId);
      if (manifest.sessionId) {
        fs.rmSync(aliasFile(root, 'session', manifest.sessionId), { force: true });
      }
      if (manifest.launchAliasDigest) {
        fs.rmSync(path.join(root, 'aliases', 'launch', `${manifest.launchAliasDigest}.json`), {
          force: true,
        });
      }
      fs.rmSync(path.join(instancesRoot, entry), { recursive: true, force: true });
      reaped.push(manifest.overlayId);
    }
    runGit(repository.repositoryRoot, ['worktree', 'prune'], { allowFailure: true });
    return reaped;
  });
}

/** Map a physical overlay cwd back to the project identity used by auth/history. */
export function logicalProjectPathForWorkspace(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return cwd;
  try {
    const workspace = fs.realpathSync(cwd.trim());
    const commonGitDir = fs.realpathSync(
      gitText(workspace, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    );
    const trustedInstancesRoot = path.join(commonGitDir, 'nassaj-session-overlays', 'instances');
    const instanceRoot = path.dirname(workspace);
    if (path.basename(workspace) !== 'workspace'
        || path.dirname(instanceRoot) !== trustedInstancesRoot) return cwd;

    const manifest = readJson(path.join(instanceRoot, 'manifest.json'));
    if (!manifest || manifest.schema !== OVERLAY_SCHEMA
        || manifest.overlayId !== path.basename(instanceRoot)
        || fs.realpathSync(manifest.cwd) !== workspace
        || typeof manifest.logicalProjectPath !== 'string') return cwd;

    const logicalRepository = resolveRepository(manifest.logicalProjectPath);
    if (logicalRepository.commonGitDir !== commonGitDir) return cwd;
    return logicalRepository.logicalProjectPath;
  } catch {
    return cwd;
  }
}
