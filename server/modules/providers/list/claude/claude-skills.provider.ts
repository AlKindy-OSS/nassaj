import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import { parseFrontMatter } from '@/shared/frontmatter.js';
import type {
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillSource,
} from '@/shared/types.js';
import {
  findProviderSkillMarkdownFiles,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readProviderSkillMarkdownDefinition,
} from '@/shared/utils.js';

const getClaudeHomePath = (): string => path.join(os.homedir(), '.claude');

/**
 * Server-side TTL cache for the Claude skills scan.
 *
 * Each `listSkills` call walks `~/.claude/skills`, `{workspace}/.claude/skills`,
 * the Claude `settings.json` (`enabledPlugins`), `installed_plugins.json`, and
 * every enabled plugin folder (commands/skills markdown). That is a sizable
 * filesystem sweep repeated on every `/api/providers/claude/skills` request and
 * was the source of the slash-command/badge latency. Skills rarely change inside
 * a session, so a short TTL (mirroring `dynamicBuiltInCache` in
 * server/routes/commands.js) removes the repeated I/O without a complex
 * invalidation scheme.
 *
 * Cache-key correctness (multi-user isolation — B-26 sibling concern):
 * the scan result is fully determined by three inputs and the key folds in ALL
 * of them so entries can never cross a user/project boundary:
 *   1. provider              — this adapter only scans Claude paths; included for
 *                              clarity and to stay correct if the cache is ever
 *                              shared across provider instances.
 *   2. resolved Claude home  — `getClaudeHomePath()` (= os.homedir()/.claude).
 *                              This drives the user-scope skills dir, the plugin
 *                              settings, the installed-plugins manifest, and every
 *                              plugin folder. Today the skills route does NOT
 *                              apply a per-user CLAUDE_CONFIG_DIR override, so this
 *                              is the operator's single home for all callers; but
 *                              keying on it explicitly means that if a per-user
 *                              HOME/config override is ever wired into this path,
 *                              isolated users automatically get distinct cache
 *                              entries instead of leaking one user's skills to
 *                              another. The cost is zero today (constant per
 *                              process) and the safety is structural.
 *   3. resolved workspace    — `{workspace}/.claude/skills` is project-scoped, so
 *                              two projects must never share an entry. Resolved
 *                              the same way the scan resolves it (path.resolve of
 *                              the workspace, defaulting to process.cwd()).
 *
 * When in doubt the key carries MORE (correctness before hit-rate): a redundant
 * input only fragments the cache, while a missing one would leak data.
 */
const SKILLS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

type SkillsCacheEntry = {
  skills: ProviderSkill[];
  expiresAt: number;
};

const skillsScanCache = new Map<string, SkillsCacheEntry>();

const buildSkillsCacheKey = (
  provider: string,
  claudeHomePath: string,
  workspacePath: string,
): string =>
  [
    provider,
    path.resolve(claudeHomePath),
    path.resolve(workspacePath),
  ].join('::');

const getClaudePluginName = (pluginId: string): string | null => {
  const normalizedPluginId = pluginId.trim();
  if (!normalizedPluginId || normalizedPluginId === '@') {
    return null;
  }

  const [pluginName] = normalizedPluginId.split('@');
  return readOptionalString(pluginName) ?? null;
};

const stripMarkdownExtension = (filename: string): string =>
  filename.replace(/\.md$/i, '');

const pathExistsAsDirectory = async (directoryPath: string): Promise<boolean> => {
  try {
    const directoryStats = await stat(directoryPath);
    return directoryStats.isDirectory();
  } catch {
    return false;
  }
};

const listChildDirectories = async (directoryPath: string): Promise<string[]> => {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(directoryPath, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};

const readClaudePluginName = async (
  installPath: string,
  pluginId: string,
): Promise<string | null> => {
  try {
    const pluginConfig = await readJsonConfig(
      path.join(installPath, '.claude-plugin', 'plugin.json'),
    );

    // Older or partial plugin installs may not have plugin.json yet. Falling
    // back keeps discovery useful without inventing a separate namespace.
    return readOptionalString(pluginConfig.name) ?? getClaudePluginName(pluginId);
  } catch {
    return getClaudePluginName(pluginId);
  }
};

export class ClaudeSkillsProvider extends SkillsProvider {
  constructor() {
    super('claude');
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const claudeHomePath = getClaudeHomePath();
    // Resolve the workspace exactly as the base scan does (path.resolve, default
    // cwd) so the cache key matches the directory actually walked.
    const resolvedWorkspacePath = path.resolve(options?.workspacePath ?? process.cwd());
    const cacheKey = buildSkillsCacheKey(
      this.provider,
      claudeHomePath,
      resolvedWorkspacePath,
    );

    const now = Date.now();
    const cached = skillsScanCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.skills;
    }

    const skills = [
      ...(await super.listSkills({ ...options, workspacePath: resolvedWorkspacePath })),
      ...(await this.listPluginSkills(claudeHomePath)),
    ];

    skillsScanCache.set(cacheKey, {
      skills,
      expiresAt: now + SKILLS_CACHE_TTL_MS,
    });

    return skills;
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const claudeHomePath = getClaudeHomePath();

    return [
      {
        scope: 'user',
        rootDir: path.join(claudeHomePath, 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.claude', 'skills'),
        commandPrefix: '/',
      },
    ];
  }

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return {
      scope: 'user',
      rootDir: path.join(getClaudeHomePath(), 'skills'),
      commandPrefix: '/',
    };
  }

  private async listPluginSkills(claudeHomePath: string): Promise<ProviderSkill[]> {
    const settings = await readJsonConfig(path.join(claudeHomePath, 'settings.json'));
    const enabledPlugins = readObjectRecord(settings.enabledPlugins);
    if (!enabledPlugins) {
      return [];
    }

    const installedConfig = await readJsonConfig(
      path.join(claudeHomePath, 'plugins', 'installed_plugins.json'),
    );
    const installedPlugins = readObjectRecord(installedConfig.plugins);
    if (!installedPlugins) {
      return [];
    }

    const skills: ProviderSkill[] = [];
    const visitedPluginFolders = new Set<string>();
    const pluginEntries = Object.entries(enabledPlugins)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [pluginId, enabled] of pluginEntries) {
      if (enabled !== true) {
        continue;
      }

      const installs = installedPlugins[pluginId];
      if (!Array.isArray(installs)) {
        continue;
      }

      for (const install of installs) {
        const installRecord = readObjectRecord(install);
        const installPath = readOptionalString(installRecord?.installPath);
        if (!installPath) {
          continue;
        }

        // Claude's installed path points at one version folder; the usable
        // plugin payloads live in the direct child folders beside it.
        const pluginFolders = await listChildDirectories(path.dirname(installPath));
        for (const pluginFolder of pluginFolders) {
          const pluginFolderKey = `${pluginId}:${path.resolve(pluginFolder)}`;
          if (visitedPluginFolders.has(pluginFolderKey)) {
            continue;
          }
          visitedPluginFolders.add(pluginFolderKey);

          const pluginName = await readClaudePluginName(pluginFolder, pluginId);
          if (!pluginName) {
            continue;
          }

          const commandsPath = path.join(pluginFolder, 'commands');
          if (await pathExistsAsDirectory(commandsPath)) {
            skills.push(
              ...(await this.listPluginCommandSkills(commandsPath, pluginId, pluginName)),
            );
            continue;
          }

          const skillsPath = path.join(pluginFolder, 'skills');
          if (!(await pathExistsAsDirectory(skillsPath))) {
            continue;
          }

          skills.push(
            ...(await this.listPluginSkillMarkdowns(pluginFolder, pluginId, pluginName)),
          );
        }
      }
    }

    return skills;
  }

  private async listPluginCommandSkills(
    commandsPath: string,
    pluginId: string,
    pluginName: string,
  ): Promise<ProviderSkill[]> {
    const skills: ProviderSkill[] = [];

    try {
      const entries = await readdir(commandsPath, { withFileTypes: true });
      const commandFiles = entries
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
        .sort((left, right) => left.name.localeCompare(right.name));

      for (const commandFile of commandFiles) {
        const sourcePath = path.join(commandsPath, commandFile.name);
        try {
          const definition = await this.readPluginCommandDefinition(sourcePath);
          skills.push({
            provider: this.provider,
            name: definition.name,
            description: definition.description,
            command: `/${pluginName}:${definition.name}`,
            scope: 'plugin',
            sourcePath,
            pluginName,
            pluginId,
          });
        } catch {
          // Malformed command markdown should not block sibling plugin commands.
        }
      }
    } catch {
      // Missing or unreadable command folders are treated as empty plugin command sets.
    }

    return skills;
  }

  private async readPluginCommandDefinition(
    commandPath: string,
  ): Promise<{ name: string; description: string }> {
    const content = await readFile(commandPath, 'utf8');
    const parsed = parseFrontMatter(content);
    const data = readObjectRecord(parsed.data) ?? {};

    return {
      name: stripMarkdownExtension(path.basename(commandPath)),
      description: readOptionalString(data.description) ?? '',
    };
  }

  private async listPluginSkillMarkdowns(
    installPath: string,
    pluginId: string,
    pluginName: string,
  ): Promise<ProviderSkill[]> {
    const skillFiles = await findProviderSkillMarkdownFiles(path.join(installPath, 'skills'), {
      recursive: true,
    });
    const skills: ProviderSkill[] = [];

    for (const skillPath of skillFiles) {
      try {
        const definition = await readProviderSkillMarkdownDefinition(skillPath);
        skills.push({
          provider: this.provider,
          name: definition.name,
          description: definition.description,
          command: `/${pluginName}:${definition.name}`,
          scope: 'plugin',
          sourcePath: skillPath,
          pluginName,
          pluginId,
        });
      } catch {
        // A bad plugin skill file should not block other installed plugin skills.
      }
    }

    return skills;
  }
}
