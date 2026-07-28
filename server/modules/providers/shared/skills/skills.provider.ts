import path from 'node:path';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';

import type { IProviderSkills } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveOptions,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  AppError,
  findProviderSkillMarkdownFiles,
  readOptionalString,
  readProviderSkillMarkdownDefinition,
  readProviderSkillMarkdownDefinitionFromContent,
} from '@/shared/utils.js';

const resolveWorkspacePath = (workspacePath?: string): string =>
  path.resolve(workspacePath ?? process.cwd());

const stripMarkdownExtension = (value: string): string => value.replace(/\.md$/i, '');

/**
 * Marker file written inside every skill directory this app installs (B-175/2).
 *
 * WHY it exists: `addSkills` replaces a whole skill directory (`rm -rf` then
 * rewrite) and `removeSkill` deletes one outright. Both resolve the target from
 * a caller-supplied NAME under the provider's writable skill root — which for
 * claude/codex is the OPERATOR's own `~/.claude/skills` / `~/.agents/skills`,
 * i.e. the same folders that hold hand-authored skills the owner wrote outside
 * this app. Before this marker, an owner/admin clicking "delete" on any listed
 * skill (or uploading one whose folder name collided) silently destroyed those
 * hand-authored folders with no way to distinguish them from app-installed ones.
 *
 * The marker is the distinguishing bit: only directories this app materialized
 * carry it, and only those may be overwritten or removed through the API. A
 * folder without it is treated as externally owned and is refused (the operator
 * can still remove it from a shell — this gate is about the API's blast radius,
 * not about locking the filesystem).
 *
 * MIGRATION: skills installed through the UI BEFORE this change carry no marker
 * and are therefore refused too; they must be deleted once from a shell (or
 * re-installed through the UI) to become app-managed again. Fail-closed is the
 * deliberate trade: the failure mode of guessing wrong is an irreversible
 * `rm -rf` of the owner's work.
 */
const SKILL_MANIFEST_FILE = '.nassaj-skill.json';

/** True when `skillDirectoryPath` carries this app's install marker. */
const isAppManagedSkillDirectory = async (skillDirectoryPath: string): Promise<boolean> => {
  try {
    const raw = await readFile(path.join(skillDirectoryPath, SKILL_MANIFEST_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Boolean(parsed) && typeof parsed === 'object';
  } catch {
    // Missing, unreadable, or malformed marker → not app-managed (fail-closed).
    return false;
  }
};

/** True when a path already exists as a directory. */
const directoryExists = async (targetPath: string): Promise<boolean> => {
  const stats = await stat(targetPath).catch(() => null);
  return Boolean(stats?.isDirectory());
};

/**
 * Normalizes a caller-supplied skill folder name into a safe single path
 * segment: separators, control characters, and reserved filename characters are
 * collapsed to dashes and leading/trailing dots or dashes are stripped. Both
 * write paths (addSkills and removeSkill) additionally re-check the resolved
 * directory against the resolved skill root before touching the filesystem, so
 * this is a defense-in-depth cleanup rather than the only traversal guard.
 */
const normalizeSkillDirectoryName = (value: string): string => (
  value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '')
);

type PendingSkillInstall = {
  skillDirectoryPath: string;
  skillPath: string;
  content: string;
  supportingFiles: Array<{
    targetPath: string;
    content: string | Buffer;
  }>;
  skill: ProviderSkill;
};

/**
 * Resolves and validates a supporting file path so it can only ever land inside
 * the target skill directory. Absolute paths, traversal segments, empty
 * segments, and a stray `SKILL.md` supporting file are all rejected before any
 * write happens.
 */
const resolveSkillSupportingFilePath = (
  skillDirectoryPath: string,
  relativePath: string,
  entryIndex: number,
): string => {
  const normalizedRelativePath = relativePath.trim().replace(/\\/g, '/');
  const pathSegments = normalizedRelativePath.split('/');
  if (
    !normalizedRelativePath
    || path.isAbsolute(normalizedRelativePath)
    || pathSegments.some((segment) => !segment || segment === '.' || segment === '..')
    || normalizedRelativePath.toLowerCase() === 'skill.md'
    // The install marker is written by this class alone; an uploaded file may
    // never masquerade as it (B-175/2) so its meaning stays unforgeable.
    || normalizedRelativePath.toLowerCase() === SKILL_MANIFEST_FILE
  ) {
    throw new AppError(
      `Skill entry ${entryIndex + 1} includes an invalid supporting file path "${relativePath}".`,
      {
        code: 'PROVIDER_SKILL_FILE_PATH_INVALID',
        statusCode: 400,
      },
    );
  }

  const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
  const resolvedFilePath = path.resolve(resolvedSkillDirectoryPath, ...pathSegments);
  if (!resolvedFilePath.startsWith(`${resolvedSkillDirectoryPath}${path.sep}`)) {
    throw new AppError(
      `Skill entry ${entryIndex + 1} supporting files must stay inside the skill directory.`,
      {
        code: 'PROVIDER_SKILL_FILE_PATH_INVALID',
        statusCode: 400,
      },
    );
  }

  return resolvedFilePath;
};

/**
 * Shared skills provider for provider-specific skill source discovery.
 *
 * Discovery (`listSkills`) is available to every provider. The managed write
 * surface (`addSkills` / `removeSkill`) is only usable by providers that expose
 * a writable global skill directory through `getGlobalSkillSource`; the default
 * implementation returns `null`, so read-only or remote providers reject writes
 * with a stable `PROVIDER_SKILLS_WRITE_UNSUPPORTED` error.
 */
export abstract class SkillsProvider implements IProviderSkills {
  protected readonly provider: LLMProvider;

  protected constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const workspacePath = resolveWorkspacePath(options?.workspacePath);
    const sources = await this.getSkillSources(workspacePath, options?.userId ?? null);
    const skills: ProviderSkill[] = [];

    for (const source of sources) {
      const skillFiles = await findProviderSkillMarkdownFiles(source.rootDir, {
        recursive: source.recursive,
      });
      for (const skillPath of skillFiles) {
        try {
          const definition = await readProviderSkillMarkdownDefinition(skillPath);
          const command = source.commandForSkill
            ? source.commandForSkill(definition.name)
            : `${source.commandPrefix ?? '/'}${definition.name}`;

          skills.push({
            provider: this.provider,
            name: definition.name,
            description: definition.description,
            command,
            scope: source.scope,
            sourcePath: skillPath,
            pluginName: source.pluginName,
            pluginId: source.pluginId,
          });
        } catch {
          // A malformed or unreadable skill markdown file should not hide other valid skills.
        }
      }
    }

    return skills;
  }

  async addSkills(input: ProviderSkillCreateInput): Promise<ProviderSkill[]> {
    const globalSkillSource = await this.requireGlobalSkillSource(input.userId ?? null);

    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw new AppError('At least one skill entry is required.', {
        code: 'PROVIDER_SKILLS_REQUIRED',
        statusCode: 400,
      });
    }

    const seenSkillPaths = new Set<string>();
    const pendingInstalls: PendingSkillInstall[] = [];
    const resolvedRootDir = path.resolve(globalSkillSource.rootDir);

    for (const [index, entry] of input.entries.entries()) {
      const content = typeof entry.content === 'string' ? entry.content.trim() : '';
      if (!content) {
        throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
          code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
          statusCode: 400,
        });
      }

      const fileNameFallback = readOptionalString(entry.fileName);
      const requestedDirectoryName = readOptionalString(entry.directoryName);
      const fallbackSkillName = normalizeSkillDirectoryName(
        requestedDirectoryName
          ?? (fileNameFallback ? stripMarkdownExtension(fileNameFallback) : `skill-${index + 1}`),
      );
      const definition = readProviderSkillMarkdownDefinitionFromContent(content, fallbackSkillName);
      const resolvedDirectoryName = normalizeSkillDirectoryName(
        requestedDirectoryName ?? definition.name,
      );

      if (!resolvedDirectoryName) {
        throw new AppError(`Skill entry ${index + 1} must include a valid skill name.`, {
          code: 'PROVIDER_SKILL_NAME_REQUIRED',
          statusCode: 400,
        });
      }

      const skillDirectoryPath = path.join(globalSkillSource.rootDir, resolvedDirectoryName);
      const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
      if (!resolvedSkillDirectoryPath.startsWith(`${resolvedRootDir}${path.sep}`)) {
        // Defense in depth (mirrors removeSkill): a normalized name must never
        // escape the skill root before any rm/mkdir/writeFile runs below.
        throw new AppError('Skill name resolves outside the managed skill directory.', {
          code: 'PROVIDER_SKILL_NAME_REQUIRED',
          statusCode: 400,
        });
      }
      const skillPath = path.join(skillDirectoryPath, 'SKILL.md');
      const normalizedSkillPath = path.resolve(skillPath);
      if (seenSkillPaths.has(normalizedSkillPath)) {
        throw new AppError(`Duplicate skill target "${resolvedDirectoryName}" in one request.`, {
          code: 'PROVIDER_SKILL_DUPLICATE_TARGET',
          statusCode: 400,
        });
      }

      seenSkillPaths.add(normalizedSkillPath);

      // B-175/2: an install REPLACES the whole directory. Refuse to blow away a
      // folder this app did not create (hand-authored skill, or one predating the
      // marker) — checked in this validation pass so a colliding entry aborts the
      // request before ANY entry is written.
      if (
        await directoryExists(skillDirectoryPath)
        && !(await isAppManagedSkillDirectory(skillDirectoryPath))
      ) {
        throw new AppError(
          `Skill "${resolvedDirectoryName}" already exists at ${skillDirectoryPath} and was not `
          + 'installed through this app, so it will not be overwritten. Remove it manually first.',
          {
            code: 'PROVIDER_SKILL_NOT_APP_MANAGED',
            statusCode: 409,
          },
        );
      }

      const supportingFiles = (entry.files ?? []).map((file) => ({
        targetPath: resolveSkillSupportingFilePath(skillDirectoryPath, file.relativePath, index),
        content: file.encoding === 'base64'
          ? Buffer.from(file.content, 'base64')
          : file.content,
      }));
      const seenSupportingPaths = new Set<string>();
      for (const file of supportingFiles) {
        if (seenSupportingPaths.has(file.targetPath)) {
          throw new AppError(`Skill entry ${index + 1} includes a duplicate supporting file path.`, {
            code: 'PROVIDER_SKILL_DUPLICATE_FILE',
            statusCode: 400,
          });
        }
        seenSupportingPaths.add(file.targetPath);
      }

      const command = globalSkillSource.commandForSkill
        ? globalSkillSource.commandForSkill(definition.name)
        : `${globalSkillSource.commandPrefix ?? '/'}${definition.name}`;

      pendingInstalls.push({
        skillDirectoryPath,
        skillPath,
        content,
        supportingFiles,
        skill: {
          provider: this.provider,
          name: definition.name,
          description: definition.description,
          command,
          scope: globalSkillSource.scope,
          sourcePath: skillPath,
          pluginName: globalSkillSource.pluginName,
          pluginId: globalSkillSource.pluginId,
        },
      });
    }

    const installedAt = new Date().toISOString();
    for (const install of pendingInstalls) {
      // Replace the complete skill directory so removed scripts or assets do not remain stale.
      await rm(install.skillDirectoryPath, { recursive: true, force: true });
      await mkdir(install.skillDirectoryPath, { recursive: true });
      await writeFile(install.skillPath, `${install.content}\n`, 'utf8');
      for (const file of install.supportingFiles) {
        await mkdir(path.dirname(file.targetPath), { recursive: true });
        await writeFile(file.targetPath, file.content);
      }
      // Marker LAST: a crash mid-write leaves the directory unmarked, so the next
      // call refuses to touch it rather than silently destroying a half-install.
      await writeFile(
        path.join(install.skillDirectoryPath, SKILL_MANIFEST_FILE),
        `${JSON.stringify({
          managedBy: 'nassaj',
          provider: this.provider,
          name: install.skill.name,
          installedAt,
        }, null, 2)}\n`,
        'utf8',
      );
    }

    return pendingInstalls.map((install) => install.skill);
  }

  async removeSkill(
    directoryName: string,
    options?: ProviderSkillRemoveOptions,
  ): Promise<ProviderSkill> {
    const globalSkillSource = await this.requireGlobalSkillSource(options?.userId ?? null);

    const resolvedDirectoryName = normalizeSkillDirectoryName(
      typeof directoryName === 'string' ? directoryName : '',
    );
    if (!resolvedDirectoryName) {
      throw new AppError('A valid skill name is required.', {
        code: 'PROVIDER_SKILL_NAME_REQUIRED',
        statusCode: 400,
      });
    }

    const skillDirectoryPath = path.join(globalSkillSource.rootDir, resolvedDirectoryName);
    const resolvedRootDir = path.resolve(globalSkillSource.rootDir);
    const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
    if (!resolvedSkillDirectoryPath.startsWith(`${resolvedRootDir}${path.sep}`)) {
      // Defense in depth: a normalized name must never escape the skill root.
      throw new AppError('Skill name resolves outside the managed skill directory.', {
        code: 'PROVIDER_SKILL_NAME_REQUIRED',
        statusCode: 400,
      });
    }

    const directoryStats = await stat(skillDirectoryPath).catch(() => null);
    if (!directoryStats || !directoryStats.isDirectory()) {
      throw new AppError(`Skill "${resolvedDirectoryName}" is not installed for ${this.provider}.`, {
        code: 'PROVIDER_SKILL_NOT_FOUND',
        statusCode: 404,
      });
    }

    // B-175/2: only directories this app installed may be deleted through the API.
    // Checked AFTER the 404 so an absent skill still reports "not installed".
    if (!(await isAppManagedSkillDirectory(skillDirectoryPath))) {
      throw new AppError(
        `Skill "${resolvedDirectoryName}" was not installed through this app, so it will not be `
        + `deleted. Remove ${skillDirectoryPath} manually if that is intended.`,
        {
          code: 'PROVIDER_SKILL_NOT_APP_MANAGED',
          statusCode: 409,
        },
      );
    }

    const skillPath = path.join(skillDirectoryPath, 'SKILL.md');
    // Best-effort metadata read so the response mirrors the removed record; a
    // malformed SKILL.md still yields a stable directory-name fallback.
    const definition = await readProviderSkillMarkdownDefinition(skillPath).catch(() => ({
      name: resolvedDirectoryName,
      description: '',
    }));
    const command = globalSkillSource.commandForSkill
      ? globalSkillSource.commandForSkill(definition.name)
      : `${globalSkillSource.commandPrefix ?? '/'}${definition.name}`;

    await rm(skillDirectoryPath, { recursive: true, force: true });

    return {
      provider: this.provider,
      name: definition.name,
      description: definition.description,
      command,
      scope: globalSkillSource.scope,
      sourcePath: skillPath,
      pluginName: globalSkillSource.pluginName,
      pluginId: globalSkillSource.pluginId,
    };
  }

  /**
   * Provider-native skill lookup roots for one workspace.
   *
   * `userId` is the server-injected caller context (B-153). It is OPTIONAL and
   * additive: overrides that predate it keep the one-argument signature and are
   * still valid TypeScript. Providers whose roots sit under an isolated config
   * home (codex → CODEX_HOME) must honor it; providers whose skill library is
   * shared by design (claude) ignore it.
   */
  protected abstract getSkillSources(
    workspacePath: string,
    userId?: string | number | null,
  ): Promise<ProviderSkillSource[]>;

  /**
   * Writable global (user-scoped) skill directory for this provider. Providers
   * that own a managed skill folder override this; the default `null` marks the
   * provider as read-only for skill writes. `userId` follows the same optional,
   * backward-compatible contract as `getSkillSources`.
   */
  protected async getGlobalSkillSource(
    _userId?: string | number | null,
  ): Promise<ProviderSkillSource | null> {
    return null;
  }

  private async requireGlobalSkillSource(
    userId: string | number | null,
  ): Promise<ProviderSkillSource> {
    const globalSkillSource = await this.getGlobalSkillSource(userId);
    if (!globalSkillSource) {
      throw new AppError(`${this.provider} does not support managed global skills.`, {
        code: 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
        statusCode: 400,
      });
    }
    return globalSkillSource;
  }
}
