import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  providerGovernanceService,
  providerSkillsService,
  resolveCodexHomeForUser,
  type ProviderGovernanceChannel,
} from '@/modules/providers/index.js';
import { parseFrontMatter } from '@/shared/frontmatter.js';
import type { LLMProvider, ProviderSkill } from '@/shared/types.js';
import {
  AppError,
  readOptionalString,
  readProviderSkillMarkdownDefinitionFromContent,
} from '@/shared/utils.js';

export type ReferenceMaterialKind = 'instructions' | 'memory' | 'agents' | 'skills';
export type ReferenceAffectedScope = 'all_members' | 'current_user' | 'project' | 'none' | 'unknown';

export type ReferenceMaterialEntry = {
  id: string;
  material: ReferenceMaterialKind;
  title: string;
  summary: string | null;
  provider: LLMProvider | null;
  scope: 'global' | 'mine' | 'project' | 'unknown' | 'no-channel';
  affectedScope: ReferenceAffectedScope;
  canReadContent: boolean;
  canEdit: boolean;
  canCreateSibling: boolean;
  metadata: Record<string, unknown>;
};

export type ReferenceMaterialContent = ReferenceMaterialEntry & {
  content: string | null;
  contentUnavailableReason: string | null;
};

type ResolvedReference = ReferenceMaterialEntry & {
  path: string | null;
  createDir: string | null;
};

type ListOptions = {
  material: ReferenceMaterialKind;
  userId: string | number | null;
  workspacePath?: string;
  canManage: boolean;
};

const PROVIDERS: readonly LLMProvider[] = Object.freeze([
  'claude',
  'codex',
  'cursor',
  'antigravity',
  'opencode',
  'hermes',
  'kimi',
  'deepseek',
  'glm',
]);

const shaId = (parts: readonly string[]): string =>
  crypto.createHash('sha256').update(parts.join('\0')).digest('base64url').slice(0, 22);

const operatorClaudeRoot = (): string => path.join(os.homedir(), '.claude');
const memoryRoot = (): string => path.join(operatorClaudeRoot(), 'memory');
const agentCardsRoot = (): string => path.join(operatorClaudeRoot(), 'agents');

const pathExistsAsRegularFile = (target: string): boolean => {
  try {
    return fs.lstatSync(target).isFile();
  } catch {
    return false;
  }
};

const readRegularFile = (target: string): string => {
  const descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error('not a regular file');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
};

const isPathInside = (candidate: string, root: string): boolean => {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
};

const readableInstructionPath = (channel: ProviderGovernanceChannel): string | null => {
  if (!channel.path) return null;
  if (pathExistsAsRegularFile(channel.path)) return channel.path;
  const trustedLinkedNames: Readonly<Record<string, readonly string[]>> = {
    'claude-home': ['NASSAJ.md', 'CLAUDE.md'],
    'agy-home': ['GEMINI.md'],
  };
  const allowedNames = trustedLinkedNames[channel.id];
  if (!allowedNames || channel.status !== 'governed' || !channel.link) return null;
  try {
    const resolved = fs.realpathSync(channel.path);
    const declared = fs.realpathSync(channel.link);
    const governanceRoot = fs.realpathSync(path.join(os.homedir(), 'nassaj-core'));
    const allowedName = allowedNames.includes(path.basename(resolved));
    return resolved === declared && allowedName && isPathInside(resolved, governanceRoot)
      && pathExistsAsRegularFile(resolved)
      ? resolved
      : null;
  } catch {
    return null;
  }
};

const listFilesRecursive = (root: string): string[] => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (entry.isFile()) {
        files.push(child);
      }
    }
  };
  walk(root);
  return files.sort((left, right) => left.localeCompare(right));
};

const listMarkdownFiles = (root: string): string[] => {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.endsWith('.md'))
    .filter((name) => name !== 'INDEX.md' && !name.startsWith('_'))
    .map((name) => path.join(root, name))
    .sort((left, right) => left.localeCompare(right));
};

const summarizeMarkdown = (content: string): { name: string | null; description: string | null } => {
  const parsed = parseFrontMatter(content);
  const data = parsed.data && typeof parsed.data === 'object'
    ? parsed.data as Record<string, unknown>
    : {};
  return {
    name: readOptionalString(data.name) ?? null,
    description: readOptionalString(data.description) ?? null,
  };
};

const redactHome = (target: string | null): string | null => {
  if (!target) return null;
  const home = os.homedir();
  return target.startsWith(`${home}${path.sep}`) ? `~${target.slice(home.length)}` : target;
};

const instructionScope = (channel: ProviderGovernanceChannel): ReferenceMaterialEntry['scope'] => {
  if (channel.mechanism === 'none') return 'no-channel';
  if (channel.scope === 'project') return 'project';
  if (channel.linkScope === 'operator') return 'global';
  if (channel.linkScope === 'user') return 'mine';
  return 'unknown';
};

const affectedScopeForInstruction = (
  channel: ProviderGovernanceChannel,
): ReferenceAffectedScope => {
  if (channel.mechanism === 'none') return 'none';
  if (channel.scope === 'project') return 'project';
  if (channel.linkScope === 'user') return 'current_user';
  if (channel.linkScope === 'operator') return 'all_members';
  return 'unknown';
};

const skillAffectedScope = (
  skill: ProviderSkill,
  userId: string | number | null,
): ReferenceAffectedScope => {
  if (skill.scope === 'project' || skill.scope === 'repo') return 'project';
  if (skill.provider === 'codex' && skill.scope === 'system') {
    const operatorHome = path.join(os.homedir(), '.codex');
    return path.resolve(resolveCodexHomeForUser(userId)) === path.resolve(operatorHome)
      ? 'all_members'
      : 'current_user';
  }
  return 'all_members';
};

const scopeFromAffected = (affectedScope: ReferenceAffectedScope): ReferenceMaterialEntry['scope'] => {
  if (affectedScope === 'all_members') return 'global';
  if (affectedScope === 'current_user') return 'mine';
  if (affectedScope === 'project') return 'project';
  if (affectedScope === 'none') return 'no-channel';
  return 'unknown';
};

const fileFacts = (target: string | null): { size?: number; updatedAt?: string } => {
  if (!target) return {};
  try {
    const stats = fs.lstatSync(target);
    if (!stats.isFile()) return {};
    return { size: stats.size, updatedAt: stats.mtime.toISOString() };
  } catch {
    return {};
  }
};

const makeEntry = (entry: Omit<ResolvedReference, 'id'> & { idParts: readonly string[] }): ResolvedReference => ({
  ...entry,
  id: shaId(entry.idParts),
  metadata: { ...entry.metadata, ...fileFacts(entry.path) },
});

const isAppManagedSkill = (skillPath: string): boolean => {
  if (!pathExistsAsRegularFile(skillPath)) return false;
  try {
    const marker = path.join(path.dirname(skillPath), '.nassaj-skill.json');
    const parsed: unknown = JSON.parse(readRegularFile(marker));
    const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    return record?.managedBy === 'nassaj' && typeof record.provider === 'string' && typeof record.name === 'string';
  } catch {
    return false;
  }
};

const listInstructions = (options: ListOptions): ResolvedReference[] => (
  PROVIDERS.flatMap((provider) => {
    const governance = providerGovernanceService.getGovernance(provider, options.userId);
    return governance.sources.map((channel) => {
      const readablePath = readableInstructionPath(channel);
      return makeEntry({
      idParts: ['instructions', provider, channel.id, channel.path ?? channel.mechanism],
      material: 'instructions',
      title: channel.path ? path.basename(channel.path) : channel.id,
      summary: provider,
      provider,
      scope: instructionScope(channel),
      affectedScope: affectedScopeForInstruction(channel),
      canReadContent: Boolean(readablePath),
      // Governance channels are attested launch inputs (often 0444 copies or a
      // symlink to the canonical source). Replacing them here would either break
      // attestation or sever the link, so this reader never claims they are
      // editable. Their dedicated governance surface owns any future write.
      canEdit: false,
      canCreateSibling: false,
      path: readablePath,
      createDir: channel.path ? path.dirname(channel.path) : null,
      metadata: {
        channelId: channel.id,
        path: redactHome(channel.path),
        mechanism: channel.mechanism,
        verification: channel.verification,
        enforcement: channel.enforcement,
        status: channel.status,
        reason: channel.reason,
        link: redactHome(channel.link),
      },
      });
    });
  })
);

const listMemory = (options: ListOptions): ResolvedReference[] => {
  const root = memoryRoot();
  let files: string[];
  try {
    files = listFilesRecursive(root);
  } catch {
    throw new AppError('The memory material is unavailable because its root is missing or unreadable.', {
      code: 'REFERENCE_MATERIAL_ROOT_UNAVAILABLE',
      statusCode: 503,
    });
  }
  return files.map((filePath) => {
    const relativePath = path.relative(root, filePath);
    return makeEntry({
      idParts: ['memory', relativePath],
      material: 'memory',
      title: relativePath,
      summary: null,
      provider: null,
      scope: 'global',
      affectedScope: 'all_members',
      canReadContent: true,
      canEdit: options.canManage,
      canCreateSibling: options.canManage,
      path: filePath,
      createDir: root,
      metadata: { path: redactHome(filePath), relativePath },
    });
  });
};

const listAgentCards = (options: ListOptions): ResolvedReference[] => (
  (() => {
    try {
      return listMarkdownFiles(agentCardsRoot());
    } catch {
      throw new AppError('The agent-card material is unavailable because its root is missing or unreadable.', {
        code: 'REFERENCE_MATERIAL_ROOT_UNAVAILABLE',
        statusCode: 503,
      });
    }
  })().map((filePath) => {
    let name: string | null = null;
    let description: string | null = null;
    try {
      ({ name, description } = summarizeMarkdown(readRegularFile(filePath)));
    } catch {
      // Keep a readable row even when the file cannot be parsed.
    }
    return makeEntry({
      idParts: ['agents', path.basename(filePath)],
      material: 'agents',
      title: name ?? path.basename(filePath, '.md'),
      summary: description,
      provider: null,
      scope: 'global',
      affectedScope: 'all_members',
      canReadContent: true,
      // Agent cards are generated from nassaj-core and overwritten by
      // build-agents; expose the real output as read-only rather than offering a
      // save that disappears on the next generation pass.
      canEdit: false,
      canCreateSibling: false,
      path: filePath,
      createDir: agentCardsRoot(),
      metadata: { path: redactHome(filePath), fileName: path.basename(filePath) },
    });
  })
);

const warnedUnsupportedSkillProviders = new Set<string>();

/** True when the provider registry rejected the id as not registered (B-1323). */
const isUnsupportedProviderError = (error: unknown): boolean => (
  error instanceof AppError && error.code === 'UNSUPPORTED_PROVIDER'
);

/**
 * Records, once per process and provider, that a listed provider is not
 * registered. Only the provider id is logged; no paths or user data.
 */
const warnUnsupportedSkillProviderOnce = (provider: string): void => {
  if (warnedUnsupportedSkillProviders.has(provider)) return;
  warnedUnsupportedSkillProviders.add(provider);
  console.warn('[reference-materials] skipping unregistered skills provider', {
    provider,
    code: 'UNSUPPORTED_PROVIDER',
  });
};

const listSkillsForProvider = async (
  provider: LLMProvider,
  options: Omit<ListOptions, 'material'>,
): Promise<ResolvedReference[]> => {
    let skills: ProviderSkill[];
    try {
      skills = await providerSkillsService.listProviderSkills(provider, {
        workspacePath: options.workspacePath,
        userId: options.userId,
      });
    } catch (error) {
      if (isUnsupportedProviderError(error)) {
        warnUnsupportedSkillProviderOnce(provider);
        return [];
      }
      throw new AppError(`Skills for ${provider} are unavailable.`, {
        code: 'REFERENCE_MATERIAL_PROVIDER_UNAVAILABLE',
        statusCode: 503,
      });
    }
    return skills.map((skill) => {
        const affectedScope = skillAffectedScope(skill, options.userId);
        const appManaged = skill.scope === 'user' && isAppManagedSkill(skill.sourcePath);
        return makeEntry({
          idParts: ['skills', provider, skill.sourcePath],
          material: 'skills',
          title: skill.command,
          summary: skill.description || skill.name,
          provider,
          scope: scopeFromAffected(affectedScope),
          affectedScope,
          canReadContent: pathExistsAsRegularFile(skill.sourcePath),
          canEdit: options.canManage && appManaged,
          canCreateSibling: false,
          path: skill.sourcePath,
          createDir: path.dirname(skill.sourcePath),
          metadata: {
            name: skill.name,
            command: skill.command,
            description: skill.description,
            origin: skill.scope,
            path: redactHome(skill.sourcePath),
            pluginName: skill.pluginName,
            pluginId: skill.pluginId,
            appManaged,
          },
        });
      });
};

const listSkills = async (options: ListOptions): Promise<ResolvedReference[]> => {
  const rows = await Promise.all(PROVIDERS.map((provider) => (
    listSkillsForProvider(provider, options)
  )));
  return rows.flat();
};

const listResolved = async (options: ListOptions): Promise<ResolvedReference[]> => {
  if (options.material === 'instructions') return listInstructions(options);
  if (options.material === 'memory') return listMemory(options);
  if (options.material === 'agents') return listAgentCards(options);
  return listSkills(options);
};

const findResolved = async (
  material: ReferenceMaterialKind,
  id: string,
  options: Omit<ListOptions, 'material'>,
): Promise<ResolvedReference> => {
  if (material === 'skills') {
    let providerFailure: unknown = null;
    for (const provider of PROVIDERS) {
      try {
        const entry = (await listSkillsForProvider(provider, options))
          .find((candidate) => candidate.id === id);
        if (entry) return entry;
      } catch (error) {
        providerFailure ??= error;
      }
    }
    if (providerFailure) throw providerFailure;
  } else {
    const entry = (await listResolved({ ...options, material }))
      .find((candidate) => candidate.id === id);
    if (entry) return entry;
  }
  throw new AppError('Reference material not found.', {
    code: 'REFERENCE_MATERIAL_NOT_FOUND',
    statusCode: 404,
  });
};

const assertWritable = (entry: ResolvedReference): void => {
  if (!entry.path || !entry.canEdit) {
    throw new AppError('This reference material cannot be edited.', {
      code: 'REFERENCE_MATERIAL_READ_ONLY',
      statusCode: 400,
    });
  }
};

const normalizeFileSegment = (value: string, fallback: string): string => {
  const normalized = value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
};

const atomicWriteFile = (target: string, content: string, options: { overwrite: boolean }): void => {
  const dir = path.dirname(target);
  const filename = path.basename(target);
  const staged = path.join(dir, `.${filename}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existingMode = options.overwrite && pathExistsAsRegularFile(target)
      ? fs.lstatSync(target).mode & 0o777
      : 0o600;
    fs.writeFileSync(staged, content.endsWith('\n') ? content : `${content}\n`, {
      mode: existingMode,
      flag: 'wx',
      encoding: 'utf8',
    });
    if (options.overwrite) {
      fs.renameSync(staged, target);
    } else {
      // link(2) creates the final directory entry only if it does not already
      // exist. Unlike existsSync+rename this remains no-clobber under two
      // concurrent creators; the hard link is then detached from its stage name.
      fs.linkSync(staged, target);
      fs.unlinkSync(staged);
    }
  } catch (error) {
    fs.rmSync(staged, { force: true });
    if (error instanceof AppError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      throw new AppError('Reference material already exists.', {
        code: 'REFERENCE_MATERIAL_EXISTS',
        statusCode: 409,
      });
    }
    throw new AppError('Could not write reference material.', {
      code: 'REFERENCE_MATERIAL_WRITE_FAILED',
      statusCode: 500,
      details: { errno: (error as NodeJS.ErrnoException)?.code ?? null },
    });
  }
};

const createTarget = (
  material: ReferenceMaterialKind,
  input: { name?: string; provider?: LLMProvider; content: string },
): { target: string; affectedScope: ReferenceAffectedScope } => {
  if (material === 'instructions') {
    throw new AppError('Instruction channels can be edited when present, not created here.', {
      code: 'REFERENCE_MATERIAL_CREATE_UNSUPPORTED',
      statusCode: 400,
    });
  }

  if (material === 'memory') {
    const filename = `${normalizeFileSegment(input.name ?? 'memory', 'memory')}.md`;
    return { target: path.join(memoryRoot(), filename), affectedScope: 'all_members' };
  }

  if (material === 'agents') {
    throw new AppError('Agent cards are generated and cannot be created from this surface.', {
      code: 'REFERENCE_MATERIAL_CREATE_UNSUPPORTED',
      statusCode: 400,
    });
  }

  if (!input.provider) {
    throw new AppError('provider is required when creating a skill.', {
      code: 'REFERENCE_MATERIAL_PROVIDER_REQUIRED',
      statusCode: 400,
    });
  }
  throw new AppError('Skills are created through their provider-managed writer.', {
    code: 'REFERENCE_MATERIAL_CREATE_UNSUPPORTED',
    statusCode: 400,
  });
};

const pendingSkillCreates = new Set<string>();

const createSkill = async (
  input: { name?: string; provider?: LLMProvider; content: string },
  options: Omit<ListOptions, 'material'>,
): Promise<ReferenceMaterialContent> => {
  if (!input.provider) {
    throw new AppError('provider is required when creating a skill.', {
      code: 'REFERENCE_MATERIAL_PROVIDER_REQUIRED',
      statusCode: 400,
    });
  }
  const definition = readProviderSkillMarkdownDefinitionFromContent(input.content, input.name ?? 'skill');
  const directoryName = normalizeFileSegment(input.name ?? definition.name, 'skill');
  const lockKey = `${input.provider}\0${directoryName}`;
  if (pendingSkillCreates.has(lockKey)) {
    throw new AppError('Reference material already exists or is being created.', {
      code: 'REFERENCE_MATERIAL_EXISTS',
      statusCode: 409,
    });
  }
  pendingSkillCreates.add(lockKey);
  try {
    const current = await providerSkillsService.listProviderSkills(input.provider, {
      workspacePath: options.workspacePath,
      userId: options.userId,
    });
    if (current.some((skill) => (
      skill.scope === 'user'
      && path.basename(path.dirname(skill.sourcePath)) === directoryName
    ))) {
      throw new AppError('Reference material already exists.', {
        code: 'REFERENCE_MATERIAL_EXISTS',
        statusCode: 409,
      });
    }
    const [created] = await providerSkillsService.addProviderSkills(input.provider, {
      userId: options.userId,
      createOnly: true,
      entries: [{ content: input.content, directoryName }],
    });
    // Re-read only the provider just written. A different optional provider
    // being unavailable must not turn this successful mutation into a false
    // 503, nor hide the committed audit event from the route.
    const entries = await listSkillsForProvider(input.provider, options);
    const resolved = entries.find((entry) => entry.path === created?.sourcePath);
    if (!resolved) {
      throw new AppError('Reference material was written but could not be re-read.', {
        code: 'REFERENCE_MATERIAL_REREAD_FAILED',
        statusCode: 500,
      });
    }
    const { path: resolvedPath, createDir: _createDir, ...publicEntry } = resolved;
    return {
      ...publicEntry,
      content: resolvedPath ? readRegularFile(resolvedPath) : null,
      contentUnavailableReason: resolvedPath ? null : 'no_file',
    };
  } finally {
    pendingSkillCreates.delete(lockKey);
  }
};

export const referenceMaterialsService = {
  async list(options: ListOptions): Promise<ReferenceMaterialEntry[]> {
    const entries = await listResolved(options);
    return entries.map(({ path: _path, createDir: _createDir, ...entry }) => entry);
  },

  async read(
    material: ReferenceMaterialKind,
    id: string,
    options: Omit<ListOptions, 'material'>,
  ): Promise<ReferenceMaterialContent> {
    const entry = await findResolved(material, id, options);
    let content: string | null = null;
    let contentUnavailableReason: string | null = null;
    if (!entry.path) {
      contentUnavailableReason = 'no_file';
    } else {
      try {
        content = readRegularFile(entry.path);
      } catch {
        contentUnavailableReason = 'unreadable';
      }
    }
    const { path: _path, createDir: _createDir, ...publicEntry } = entry;
    return { ...publicEntry, content, contentUnavailableReason };
  },

  async update(
    material: ReferenceMaterialKind,
    id: string,
    content: string,
    options: Omit<ListOptions, 'material'>,
  ): Promise<ReferenceMaterialContent> {
    const entry = await findResolved(material, id, options);
    assertWritable(entry);
    if (material === 'skills') {
      readProviderSkillMarkdownDefinitionFromContent(content, entry.title);
    }
    atomicWriteFile(entry.path as string, content, { overwrite: true });
    return this.read(material, id, options);
  },

  async create(
    material: ReferenceMaterialKind,
    input: { name?: string; provider?: LLMProvider; content: string },
    options: Omit<ListOptions, 'material'>,
  ): Promise<ReferenceMaterialContent> {
    if (material === 'skills') {
      return createSkill(input, options);
    }
    const target = createTarget(material, input);
    atomicWriteFile(target.target, input.content, { overwrite: false });
    const entries = await listResolved({ ...options, material });
    const created = entries.find((entry) => entry.path === target.target);
    if (!created) {
      throw new AppError('Reference material was written but could not be re-read.', {
        code: 'REFERENCE_MATERIAL_REREAD_FAILED',
        statusCode: 500,
      });
    }
    return this.read(material, created.id, options);
  },
};
