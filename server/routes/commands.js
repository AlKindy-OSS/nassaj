import { constants as fsConstants, promises as fs } from "fs";
import os from "os";
import path from "path";

import express from "express";

import { providerModelsService } from "../modules/providers/services/provider-models.service.js";
import { getClaudeBuiltInCommands } from "../claude-sdk.js";
import { resolveProviderEnv } from "../services/isolation/resolve-provider-env.js";
import { parseFrontMatter } from "../shared/frontmatter.js";
import { findAppRoot, getModuleDir } from "../utils/runtime-paths.js";
import { projectsDb } from "../modules/database/index.js";
import {
  callCodexAppServer,
  startCodexCompaction,
} from "../services/codex-app-server.js";

const __dirname = getModuleDir(import.meta.url);
// This route reads the top-level package.json for the status command, so it needs the real
// app root even after compilation moves the route file under dist-server/server/routes.
const APP_ROOT = findAppRoot(__dirname);

const router = express.Router();

const MAX_COMMAND_FILE_BYTES = 1024 * 1024;
const COMMAND_FILE_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
const COMMAND_ROOT_OPEN_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;

function commandFileError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function openedFdTarget(handle) {
  return fs.realpath(`/proc/self/fd/${handle.fd}`);
}

async function openPinnedCommandRoot(rootPath) {
  let canonicalRoot;
  try {
    canonicalRoot = await fs.realpath(rootPath);
  } catch {
    return null;
  }
  let handle;
  try {
    handle = await fs.open(canonicalRoot, COMMAND_ROOT_OPEN_FLAGS);
    const [stats, openedTarget] = await Promise.all([handle.stat(), openedFdTarget(handle)]);
    if (!stats.isDirectory() || openedTarget !== canonicalRoot) {
      await handle.close();
      return null;
    }
    return { handle, target: openedTarget };
  } catch {
    await handle?.close().catch(() => {});
    return null;
  }
}

function isDescendantPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readOpenedFileAtMost(handle, size) {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const chunk = await handle.read(bytes, offset, size - offset, offset);
    if (chunk.bytesRead === 0) break;
    offset += chunk.bytesRead;
  }
  return bytes.subarray(0, offset).toString("utf8");
}

async function readContainedCommandFile(commandPath, allowedRoots) {
  const roots = (await Promise.all(allowedRoots.filter(Boolean).map(openPinnedCommandRoot)))
    .filter(Boolean);
  let commandHandle;
  try {
    if (roots.length === 0) {
      throw commandFileError("COMMAND_ACCESS_DENIED", "No available command root");
    }
    try {
      commandHandle = await fs.open(commandPath, COMMAND_FILE_OPEN_FLAGS);
    } catch (error) {
      if (["ELOOP", "EACCES", "EPERM", "ENOTDIR"].includes(error?.code)) {
        throw commandFileError("COMMAND_ACCESS_DENIED", "Command file is not safe to open");
      }
      throw error;
    }
    let stats;
    let openedTarget;
    try {
      [stats, openedTarget] = await Promise.all([commandHandle.stat(), openedFdTarget(commandHandle)]);
    } catch {
      throw commandFileError("COMMAND_ACCESS_DENIED", "Unable to prove opened command target");
    }
    if (!stats.isFile() || stats.nlink !== 1) {
      throw commandFileError("COMMAND_ACCESS_DENIED", "Command path is not a regular file");
    }
    if (stats.size > MAX_COMMAND_FILE_BYTES) {
      throw commandFileError("COMMAND_FILE_TOO_LARGE", "Command file is too large");
    }
    if (!roots.some((root) => isDescendantPath(root.target, openedTarget))) {
      throw commandFileError("COMMAND_ACCESS_DENIED", "Command file is outside an allowed root");
    }
    return await readOpenedFileAtMost(commandHandle, stats.size);
  } finally {
    await commandHandle?.close().catch(() => {});
    await Promise.all(roots.map((root) => root.handle.close().catch(() => {})));
  }
}

// Every provider wired into the composer's model-aware flow (T-874/T-875) so
// `/models`, `/cost`, and `/status` resolve the session's actual provider
// instead of silently coercing an unlisted one (e.g. antigravity) to
// "claude" — see readModelProvider() below. `sakana` is intentionally
// excluded: it has no model state in useChatComposerState/useChatProviderState
// yet, so context.provider never carries it.
const MODEL_PROVIDERS = [
  "claude", "cursor", "codex", "antigravity", "opencode", "hermes",
  "kimi", "deepseek", "glm",
];

const MODEL_PROVIDER_LABELS = {
  claude: "Claude",
  cursor: "Cursor",
  codex: "Codex",
  antigravity: "Antigravity",
  opencode: "OpenCode",
  hermes: "Hermes",
  kimi: "Kimi",
  deepseek: "DeepSeek",
  glm: "GLM",
};

const readModelProvider = (value) => {
  if (typeof value !== "string") {
    return "claude";
  }

  const normalized = value.trim().toLowerCase();
  return MODEL_PROVIDERS.includes(normalized) ? normalized : "claude";
};

const hasConcreteSessionId = (value) =>
  typeof value === "string" && value.trim().length > 0;

const resolveCommandModel = async (provider, catalog, sessionId) => {
  if (!hasConcreteSessionId(sessionId)) {
    return catalog.DEFAULT;
  }

  const currentActiveModel = await providerModelsService.getCurrentActiveModel(
    provider,
    sessionId,
  );
  return currentActiveModel?.model || catalog.DEFAULT;
};

export const executeModelsCommand = async (args, context) => {
  const currentProvider = readModelProvider(context?.provider);
  // B-342: scoped to the caller so the panel lists the models THEIR key sees.
  const result = await providerModelsService.getProviderModels(
    currentProvider,
    {},
    context?.userId ?? null,
    context?.authenticatedPrincipal,
  );
  const catalog = result.models;
  const currentModel = await resolveCommandModel(
    currentProvider,
    catalog,
    context?.sessionId,
  );
  const availableModels = catalog.OPTIONS.map((option) => option.value);
  const availableOptions = catalog.OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
  }));

  return {
    type: "builtin",
    action: "models",
    data: {
      current: {
        provider: currentProvider,
        providerLabel: MODEL_PROVIDER_LABELS[currentProvider],
        model: currentModel,
      },
      available: {
        [currentProvider]: availableModels,
      },
      availableModels,
      availableOptions,
      defaultModel: catalog.DEFAULT,
      cache: result.cache,
      message: `Current model: ${currentModel}`,
    },
  };
};

/**
 * Resolves `<projectPath>/.claude/commands` through realpath and returns it only
 * when the REAL directory is still contained in the REAL project root.
 *
 * Authorization is decided on the project path (see /list and /execute), but the
 * scan then walks whatever that path points at: a `.claude/commands` symlink
 * aimed at another project, another user's home, or `/etc` would be read under
 * the authorization of the innocent project. Comparing the two realpaths closes
 * that gap — a symlink that escapes the project resolves outside the root and is
 * refused. Symlinked entries *inside* the tree are already skipped by the
 * scanner, which only descends real directories and reads real files
 * (`Dirent.isDirectory()` / `isFile()` are false for a symlink entry).
 *
 * Returns null when the directory is missing, unreadable, or escapes the root —
 * all three simply mean "no project commands", never an error.
 *
 * @param {string} projectPath - authorized project root
 * @returns {Promise<string|null>} contained real path, or null
 */
async function resolveContainedCommandsDir(projectPath) {
  try {
    const projectRoot = await fs.realpath(path.resolve(projectPath));
    const commandsDir = await fs.realpath(
      path.join(projectRoot, ".claude", "commands"),
    );
    const relative = path.relative(projectRoot, commandsDir);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }
    return commandsDir;
  } catch {
    return null;
  }
}

/**
 * Recursively scan directory for command files (.md)
 * @param {string} dir - Directory to scan
 * @param {string} baseDir - Base directory for relative paths
 * @param {string} namespace - Namespace for commands (e.g., 'project', 'user')
 * @returns {Promise<Array>} Array of command objects
 */
async function scanCommandsDirectory(dir, baseDir, namespace) {
  const commands = [];

  try {
    // Check if directory exists
    await fs.access(dir);

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        const subCommands = await scanCommandsDirectory(
          fullPath,
          baseDir,
          namespace,
        );
        commands.push(...subCommands);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        // Parse markdown file for metadata
        try {
          const content = await fs.readFile(fullPath, "utf8");
          const { data: frontmatter, content: commandContent } =
            parseFrontMatter(content);

          // Calculate relative path from baseDir for command name
          const relativePath = path.relative(baseDir, fullPath);
          // Remove .md extension and convert to command name
          const commandName =
            "/" + relativePath.replace(/\.md$/, "").replace(/\\/g, "/");

          // Extract description from frontmatter or first line of content
          let description = frontmatter.description || "";
          if (!description) {
            const firstLine = commandContent.trim().split("\n")[0];
            description = firstLine.replace(/^#+\s*/, "").trim();
          }

          commands.push({
            name: commandName,
            path: fullPath,
            relativePath,
            description,
            namespace,
            metadata: frontmatter,
          });
        } catch (err) {
          console.error(`Error parsing command file ${fullPath}:`, err.message);
        }
      }
    }
  } catch (err) {
    // Directory doesn't exist or can't be accessed - this is okay
    if (err.code !== "ENOENT" && err.code !== "EACCES") {
      console.error(`Error scanning directory ${dir}:`, err.message);
    }
  }

  return commands;
}

/**
 * Built-in commands that are always available
 */
const builtInCommands = [
  // Commands with a dedicated UI handler (executed via /api/commands/execute).
  // `hasHandler: true` -> the web layer renders the result locally.
  {
    name: "/help",
    description: "Show help documentation for Claude Code",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/models",
    description: "View available models for the current provider",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/cost",
    description: "Display token usage information",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/memory",
    description: "Open CLAUDE.md memory file for editing",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/config",
    description: "Open settings and configuration",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/status",
    description: "Show system status and version information",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  // Built-in Claude Code commands without a dedicated UI handler.
  // `hasHandler: false` -> the web layer must pass the raw text straight to the
  // CLI dispatch path instead of calling /api/commands/execute.
  {
    name: "/clear",
    description: "Clear conversation history",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/compact",
    description: "Compact conversation context",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/agents",
    description: "Manage agents / subagents",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/init",
    description: "Initialize CLAUDE.md for the codebase",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/review",
    description: "Review a pull request",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/resume",
    description: "Resume a previous session",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/mcp",
    description: "Manage MCP servers",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/permissions",
    description: "Manage tool permissions",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/export",
    description: "Export conversation",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/doctor",
    description: "Diagnose installation health",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/add-dir",
    description: "Add a working directory",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/hooks",
    description: "Manage hooks",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
  {
    name: "/vim",
    description: "Toggle vim mode",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: false },
  },
];

// OC-19: built-in slash commands that are Claude-Code-specific and do NOT work
// through a non-Claude CLI. Every hasHandler:false entry is a Claude CLI slash that
// the web layer forwards as raw text (meaningless to `opencode run`), plus /memory
// (opens CLAUDE.md; opencode uses AGENTS.md) and /config (Claude Code settings). The
// four provider-aware handlers — /models, /cost, /status, /help — stay universal
// (their handlers resolve the session's actual provider), so they are NOT listed here.
const CLAUDE_ONLY_BUILTINS = new Set([
  "/memory",
  "/config",
  "/clear",
  "/compact",
  "/agents",
  "/init",
  "/review",
  "/resume",
  "/mcp",
  "/permissions",
  "/export",
  "/doctor",
  "/add-dir",
  "/hooks",
  "/vim",
]);

// Codex CLI slash commands are client-side affordances, so Nassaj must not
// forward them as ordinary prompts. Only commands backed by a stable, bounded
// App Server RPC (or an existing provider-aware Nassaj handler) are advertised.
// TUI-only commands and destructive/auth/config mutations remain hidden.
const CODEX_APP_SERVER_COMMANDS = [
  {
    name: "/model",
    description: "View available Codex models",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true, aliases: ["/models"] },
  },
  {
    name: "/usage",
    description: "View Codex account token activity",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/mcp",
    description: "View connected MCP servers and tools",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/skills",
    description: "View skills available to this project",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/hooks",
    description: "View lifecycle hooks available to this project",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/apps",
    description: "View available Codex apps and connectors",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true },
  },
  {
    name: "/rename",
    description: "Rename the current Codex conversation",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true, argumentHint: "<name>" },
  },
  {
    name: "/goal",
    description: "View, edit, pause, resume, or clear the current Codex goal",
    namespace: "builtin",
    metadata: { type: "builtin", hasHandler: true, argumentHint: "[edit <objective>|pause|resume|clear]" },
  },
];

// Providers whose sessions must NOT be shown the Claude-only built-ins above
// (OC-19). Scoped to opencode per the OpenCode-compat plan; other non-Claude
// providers (cursor/codex/…) keep the full static list unchanged — their
// command UX is outside this task's scope. Add a provider here to extend the filter.
const BUILTIN_FILTER_PROVIDERS = new Set(["opencode"]);

/**
 * The static built-in list a given provider should see. For providers in
 * BUILTIN_FILTER_PROVIDERS the Claude-only entries are removed; every other
 * provider gets the full list unchanged (same reference — no behavior change).
 * @param {string} provider
 * @returns {Array} built-in commands applicable to the provider
 */
function builtInsForProvider(provider) {
  if (provider === "codex") {
    const supported = new Set(["/help", "/models", "/cost", "/status", "/compact"]);
    const nassajCommands = builtInCommands
      .filter((cmd) => supported.has(cmd.name))
      .map((cmd) => cmd.name === "/compact"
        ? {
            ...cmd,
            description: "Compact the current Codex context",
            metadata: { ...cmd.metadata, hasHandler: true },
          }
        : cmd.name === "/help"
          ? { ...cmd, description: "Show commands available in this Codex session" }
          : cmd);
    return [...nassajCommands, ...CODEX_APP_SERVER_COMMANDS];
  }
  if (!BUILTIN_FILTER_PROVIDERS.has(provider)) {
    if (provider === "claude") return builtInCommands;
    const portable = new Set(["/help", "/models", "/cost", "/status"]);
    return builtInCommands.filter((cmd) => portable.has(cmd.name));
  }
  return builtInCommands.filter((cmd) => !CLAUDE_ONLY_BUILTINS.has(cmd.name));
}

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function readableName(value, fallback = "Unnamed") {
  return String(
    value?.displayName ?? value?.name ?? value?.key ?? value?.eventName ?? value?.id ?? fallback,
  );
}

function withDisplay(raw, content) {
  return {
    message: content,
    content,
    format: "markdown",
    raw,
  };
}

function formatUsageResult(raw) {
  const summary = raw?.summary || {};
  const rows = [
    ["Lifetime tokens", summary.lifetimeTokens],
    ["Peak daily tokens", summary.peakDailyTokens],
    ["Current streak", summary.currentStreakDays == null ? null : `${summary.currentStreakDays} days`],
    ["Longest running turn", summary.longestRunningTurnSec == null ? null : `${summary.longestRunningTurnSec}s`],
  ].filter(([, value]) => value != null);
  const content = rows.length > 0
    ? `## Codex usage\n\n${rows.map(([label, value]) => `- **${label}:** ${value}`).join("\n")}`
    : "## Codex usage\n\nNo token activity summary is available for this account.";
  return withDisplay(raw, content);
}

function formatMcpResult(raw) {
  const servers = asList(raw?.data ?? raw?.servers);
  const lines = servers.map((server) => {
    const tools = Array.isArray(server?.tools)
      ? server.tools.length
      : server?.tools && typeof server.tools === "object"
        ? Object.keys(server.tools).length
        : 0;
    const status = server?.status ?? server?.authStatus ?? "unknown";
    return `- **${readableName(server)}** — ${status}${tools ? `, ${tools} tools` : ""}`;
  });
  return withDisplay(raw, `## MCP servers\n\n${lines.join("\n") || "No MCP servers were reported."}`);
}

function formatScopedItems(raw, key, title) {
  const groups = asList(raw?.data);
  const items = groups.flatMap((group) => asList(group?.[key]));
  const lines = items.map((item) => {
    const suffix = item?.enabled === false ? " — disabled" : "";
    const event = key === "hooks" && item?.eventName && item.eventName !== item?.key
      ? ` (${item.eventName})`
      : "";
    return `- **${readableName(item)}**${event}${suffix}${item?.description ? ` — ${item.description}` : ""}`;
  });
  return withDisplay(raw, `## ${title}\n\n${lines.join("\n") || `No ${title.toLowerCase()} were reported.`}`);
}

function formatAppsResult(raw) {
  const apps = asList(raw?.data ?? raw?.apps);
  const lines = apps.map((app) => {
    const accessible = app?.isAccessible ?? app?.accessible ?? app?.callable;
    const enabled = app?.isEnabled ?? app?.enabled;
    const state = accessible === false ? "unavailable" : enabled === false ? "disabled" : "available";
    return `- **${readableName(app)}** — ${state}`;
  });
  return withDisplay(raw, `## Codex apps\n\n${lines.join("\n") || "No apps were reported."}`);
}

function formatGoalResult(raw, fallbackMessage) {
  const goal = raw?.goal ?? raw;
  const objective = goal?.objective;
  const content = objective
    ? `## Codex goal\n\n${objective}${goal?.status ? `\n\nStatus: **${goal.status}**` : ""}`
    : `## Codex goal\n\n${fallbackMessage}`;
  return withDisplay(raw, content);
}

/**
 * Dynamic built-in command discovery (Claude only).
 *
 * We source Claude's real built-in slash commands from the SDK at runtime
 * (`getClaudeBuiltInCommands`) and merge them on top of the static list above,
 * which always remains the fallback. Results are cached with a
 * stale-while-revalidate policy tuned so the UI's SINGLE fetch per project
 * selection sees the full set whenever possible:
 *  - A valid (non-expired) cache entry is merged and returned immediately.
 *  - An EXPIRED entry is still served (stale) while a background refresh runs —
 *    never regress to the static-only list once a probe has succeeded.
 *  - A COLD cache (no entry at all, e.g. right after server start) awaits the
 *    first probe briefly (COLD_PROBE_WAIT_MS); on overrun it falls back to the
 *    static list while the probe keeps running for the next request.
 *
 * Keyed by the PROBE CONTEXT, not the provider alone (B-26). Under multi-user
 * isolation the probe runs with a per-user CLAUDE_CONFIG_DIR (resolveProviderEnv
 * → ADR-014), so two users with different configs/subscriptions must NOT share a
 * cache entry — otherwise one user's command set (or a stale set) leaks to
 * another. The key folds in the effective config dir: users that genuinely share
 * a config (provider marked 'shared', or no isolation) collapse to one key and
 * keep the cache's effectiveness; isolated users each get their own entry.
 */
const DYNAMIC_BUILTIN_TTL_MS = 10 * 60 * 1000; // 10 minutes
// How long a cold-cache /list request blocks waiting for the first probe before
// falling back to the static list. Tuned just above the probe's typical warm
// latency (~700ms on this host) so the happy path still returns the full merged
// set in one fetch, while a slow/cold probe no longer stalls the first menu open
// for 2.5s. On overrun we return the static (FS-backed) list immediately; the
// SAME probe keeps running single-flighted and, on completion, stores its
// COMPLETE result in the cache (refreshDynamicBuiltIns only writes a non-null
// array), so the next request within seconds gets the dynamic built-ins. The
// read-side timeout NEVER writes a partial result — the cache write-site is the
// sole place a result is stored, and only when the probe fully resolved. The
// probe's own hard timeout (4s in getClaudeBuiltInCommands) bounds the
// background run. Env override exists for tests and operational tuning.
const COLD_PROBE_WAIT_MS =
  Number(process.env.COMMANDS_COLD_PROBE_WAIT_MS || "") || 1000;
const dynamicBuiltInCache = new Map(); // cacheKey -> { commands, expiresAt }
const dynamicBuiltInInFlight = new Map(); // cacheKey -> Promise<commands|null>

/** Sentinel for the shared/base config (no per-user CLAUDE_CONFIG_DIR override). */
const SHARED_CONFIG_SENTINEL = "__shared__";

/**
 * Builds the cache key for a dynamic built-in probe (B-26).
 *
 * The probe's RESULT depends on the Claude config dir it runs under — that is
 * what distinguishes one user's subscription/commands from another's. The route
 * resolves that effective dir once (via resolveProviderEnv) and passes it as
 * `context.configDir`; here we fold it into the key so cache entries never cross
 * isolation boundaries. When the provider is shared (or there is no isolated
 * user) configDir is absent and every caller collapses onto the shared sentinel,
 * preserving cache reuse for callers that truly share a config.
 *
 * @param {string} provider
 * @param {{ configDir?: string|null }} [context]
 * @returns {string} `<provider>::<configDir|__shared__>`
 */
function dynamicCacheKey(provider, context = {}) {
  const configDir =
    context && typeof context.configDir === "string" && context.configDir
      ? context.configDir
      : SHARED_CONFIG_SENTINEL;
  return `${provider}::${configDir}`;
}

/**
 * Builds the set of identifiers (name + aliases, normalized) already covered by
 * the static built-in list. Used to dedupe dynamic commands so a dynamic
 * `usage` aliased to `cost` does not duplicate the static `/cost`.
 * @returns {Set<string>} lowercase identifiers, each WITHOUT a leading slash
 */
function buildStaticBuiltInIdentifiers() {
  const ids = new Set();
  const add = (value) => {
    if (typeof value !== "string" || !value) return;
    ids.add(value.replace(/^\//, "").toLowerCase());
  };
  for (const cmd of builtInCommands) {
    add(cmd.name);
    if (Array.isArray(cmd.metadata?.aliases)) {
      cmd.metadata.aliases.forEach(add);
    }
  }
  return ids;
}

/**
 * Merges dynamic SDK commands on top of the static built-in list.
 *
 * Rules:
 *  - The static list is the base and always stays (fallback layer).
 *  - A dynamic command is added only if neither its name nor any of its aliases
 *    collide with a static name/alias (case-insensitive, slash-insensitive).
 *  - Added dynamic commands are flagged `hasHandler: false` (passthrough) so the
 *    existing execution path forwards them raw to the CLI.
 *  - The six handler-backed static commands keep their precedence — a dynamic
 *    duplicate is never added, so it can never shadow them.
 *
 * @param {Array<{name:string,description?:string,aliases?:string[],argumentHint?:string}>} dynamicCommands
 * @returns {Array} merged built-in command list
 */
function mergeBuiltInCommands(dynamicCommands) {
  if (!Array.isArray(dynamicCommands) || dynamicCommands.length === 0) {
    return [...builtInCommands];
  }

  const covered = buildStaticBuiltInIdentifiers();
  const merged = [...builtInCommands];

  for (const dyn of dynamicCommands) {
    if (!dyn || typeof dyn.name !== "string" || !dyn.name) continue;

    const normalizedName = dyn.name.replace(/^\//, "").toLowerCase();
    const aliasIds = Array.isArray(dyn.aliases)
      ? dyn.aliases.map((a) => String(a).replace(/^\//, "").toLowerCase())
      : [];

    // Skip if the name or ANY alias already exists in the static set.
    if (covered.has(normalizedName) || aliasIds.some((id) => covered.has(id))) {
      continue;
    }

    // Reserve this command's identifiers so a later dynamic entry sharing an
    // alias does not double-add.
    covered.add(normalizedName);
    aliasIds.forEach((id) => covered.add(id));

    merged.push({
      name: dyn.name.startsWith("/") ? dyn.name : `/${dyn.name}`,
      description: dyn.description || "",
      namespace: "builtin",
      metadata: {
        type: "builtin",
        hasHandler: false,
        ...(aliasIds.length > 0 ? { aliases: dyn.aliases } : {}),
        ...(dyn.argumentHint ? { argumentHint: dyn.argumentHint } : {}),
      },
    });
  }

  return merged;
}

/**
 * Kicks off a probe for a provider's dynamic commands and stores the result in
 * the cache. Single-flight: concurrent calls for the same provider share one
 * probe. The returned promise resolves with the normalized command array on
 * success or `null` on failure/timeout — it never rejects.
 * @param {string} provider
 * @param {Object} context - probe context ({ userId, cwd, configDir })
 * @returns {Promise<Array|null>} the (possibly already in-flight) probe
 */
function refreshDynamicBuiltIns(provider, context) {
  const cacheKey = dynamicCacheKey(provider, context);
  const inFlight = dynamicBuiltInInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const probe = Promise.resolve()
    .then(() => getClaudeBuiltInCommands(context))
    .then((commands) => {
      if (Array.isArray(commands)) {
        dynamicBuiltInCache.set(cacheKey, {
          commands,
          expiresAt: Date.now() + DYNAMIC_BUILTIN_TTL_MS,
        });
        return commands;
      }
      return null;
    })
    .catch(() => null) // Swallow — the static fallback covers this request.
    .finally(() => {
      dynamicBuiltInInFlight.delete(cacheKey);
    });

  dynamicBuiltInInFlight.set(cacheKey, probe);
  return probe;
}

/**
 * Resolves the built-in command list for a `/list` request.
 *
 * Bounded-latency by design (the UI fetches this list ONCE per project
 * selection, so "static now / full next time" would leave the menu incomplete
 * until a refetch — see T-75):
 *  - Non-Claude providers get the static list via builtInsForProvider(): opencode
 *    is filtered of Claude-only built-ins (OC-19); others get it unchanged.
 *  - Fresh cache entry → merged and returned immediately.
 *  - Expired entry → served STALE immediately while a background refresh runs
 *    (true stale-while-revalidate; never regress to static after a success).
 *  - Cold cache → awaits the first probe up to COLD_PROBE_WAIT_MS; on overrun
 *    falls back to static while the probe continues for the next request.
 *
 * @param {string} provider
 * @param {Object} context - probe context ({ userId, cwd, configDir })
 * @returns {Promise<Array>} built-in command list to return now
 */
async function resolveDynamicBuiltIns(provider, context) {
  if (provider !== "claude") {
    return builtInsForProvider(provider);
  }

  const cacheKey = dynamicCacheKey(provider, context);
  const cached = dynamicBuiltInCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return mergeBuiltInCommands(cached.commands);
  }

  const probe = refreshDynamicBuiltIns(provider, context);

  if (cached) {
    // Expired: serve the stale set now; the refresh updates the cache for the
    // next request. Stale built-ins beat a sudden regression to 19 commands.
    return mergeBuiltInCommands(cached.commands);
  }

  // Cold start: give the first probe a short, bounded window so the UI's only
  // fetch usually gets the full list (probe is ~700ms warm on this host).
  let waitHandle = null;
  const winner = await Promise.race([
    probe,
    new Promise((resolve) => {
      waitHandle = setTimeout(() => resolve("__cold_wait__"), COLD_PROBE_WAIT_MS);
    }),
  ]);
  if (waitHandle) {
    clearTimeout(waitHandle);
  }

  return Array.isArray(winner) ? mergeBuiltInCommands(winner) : builtInCommands;
}

/**
 * TEST-ONLY: clears the dynamic cache/in-flight state so each test starts cold.
 */
function _resetDynamicBuiltInsForTests() {
  dynamicBuiltInCache.clear();
  dynamicBuiltInInFlight.clear();
}

/**
 * TEST-ONLY: seeds a cache entry (e.g. an already-expired one) to exercise the
 * stale-while-revalidate path without real timers.
 * @param {string} provider
 * @param {Array} commands
 * @param {number} expiresAt - epoch ms
 * @param {{ configDir?: string|null }} [context] - probe context to key by
 */
function _seedDynamicBuiltInsForTests(provider, commands, expiresAt, context = {}) {
  dynamicBuiltInCache.set(dynamicCacheKey(provider, context), {
    commands,
    expiresAt,
  });
}

/**
 * Built-in command handlers
 * Each handler returns { type: 'builtin', action: string, data: any }
 */
const builtInHandlers = {
  "/help": async (args, context) => {
    // OC-19: list only the built-ins applicable to the session's provider so an
    // opencode session's /help does not advertise Claude-only commands.
    const helpProvider = readModelProvider(context?.provider);
    const applicableBuiltIns = builtInsForProvider(helpProvider);
    const providerLabel = MODEL_PROVIDER_LABELS[helpProvider] || helpProvider;
    const customCommandsHelp = helpProvider === "claude" ? `
## Custom Commands

Custom commands can be created in:
- Project: \`.claude/commands/\` (project-specific)
- User: \`~/.claude/commands/\` (available in all projects)

### Command Syntax

- **Arguments**: Use \`$ARGUMENTS\` for all args or \`$1\`, \`$2\`, etc. for positional
- **File Includes**: Use \`@filename\` to include file contents
- **Bash Commands**: Use \`!command\` to execute bash commands

### Examples

\`\`\`markdown
/mycommand arg1 arg2
\`\`\`
` : "";
    const helpText = `# ${providerLabel} Commands in Nassaj

## Built-in Commands

${applicableBuiltIns
  .map(
    (cmd) => `### ${cmd.name}
${cmd.description}
`,
  )
  .join("\n")}
${customCommandsHelp}
`;

    return {
      type: "builtin",
      action: "help",
      data: {
        content: helpText,
        format: "markdown",
        commands: applicableBuiltIns.map((command) => ({
          name: command.name,
          description: command.description,
          namespace: command.namespace,
        })),
      },
    };
  },

  "/models": executeModelsCommand,

  "/model": executeModelsCommand,

  "/cost": async (args, context) => {
    const tokenUsage = context?.tokenUsage || {};
    const provider = readModelProvider(context?.provider);
    const catalog = (
      await providerModelsService.getProviderModels(
        provider, {}, context?.userId ?? null, context?.authenticatedPrincipal,
      )
    ).models;
    const model = await resolveCommandModel(provider, catalog, context?.sessionId);

    const reportedUsed =
      Number(
        tokenUsage.used ?? tokenUsage.totalUsed ?? tokenUsage.total_tokens ?? 0,
      ) || 0;
    const total =
      Number(
        tokenUsage.total ??
          tokenUsage.contextWindow ??
          0,
      ) || 0;
    const normalizedInputValue =
      tokenUsage.inputTokens ??
      tokenUsage.input ??
      tokenUsage.cumulativeInputTokens ??
      tokenUsage.breakdown?.input ??
      tokenUsage.promptTokens;
    const directInputTokens =
      Number(
        normalizedInputValue ??
          tokenUsage.input_tokens ??
          0
      ) || 0;
    const cacheReadTokens =
      Number(
        tokenUsage.cacheReadTokens ??
          tokenUsage.cache_read_input_tokens ??
          tokenUsage.cacheReadInputTokens ??
          0,
      ) || 0;
    const cacheCreationTokens =
      Number(
        tokenUsage.cacheCreationTokens ??
          tokenUsage.cache_creation_input_tokens ??
          tokenUsage.cacheCreationInputTokens ??
          0,
      ) || 0;
    const inputTokens = normalizedInputValue == null
      ? directInputTokens + cacheReadTokens + cacheCreationTokens
      : directInputTokens;
    const outputTokens =
      Number(
        tokenUsage.outputTokens ??
          tokenUsage.output ??
          tokenUsage.output_tokens ??
          tokenUsage.cumulativeOutputTokens ??
          tokenUsage.breakdown?.output ??
          tokenUsage.completionTokens ??
          0,
      ) || 0;
    const computedUsed = inputTokens + outputTokens;
    const hasTokenBreakdown = computedUsed > 0;
    const used = Math.max(reportedUsed, computedUsed);

    return {
      type: "builtin",
      action: "cost",
      data: {
        tokenUsage: {
          used,
          total,
        },
        ...(hasTokenBreakdown
          ? {
              tokenBreakdown: {
                input: inputTokens,
                output: outputTokens,
              },
            }
          : {}),
        provider,
        model,
      },
    };
  },

  "/status": async (args, context) => {
    // Read version from package.json
    const packageJsonPath = path.join(APP_ROOT, "package.json");
    let version = "unknown";
    let packageName = "claude-code-ui";

    try {
      const packageJson = JSON.parse(
        await fs.readFile(packageJsonPath, "utf8"),
      );
      version = packageJson.version;
      packageName = packageJson.name;
    } catch (err) {
      console.error("Error reading package.json:", err);
    }

    const uptime = process.uptime();
    const uptimeMinutes = Math.floor(uptime / 60);
    const uptimeHours = Math.floor(uptimeMinutes / 60);
    const uptimeFormatted =
      uptimeHours > 0
        ? `${uptimeHours}h ${uptimeMinutes % 60}m`
        : `${uptimeMinutes}m`;

    const statusProvider = readModelProvider(context?.provider);
    const statusCatalog = (
      await providerModelsService.getProviderModels(
        statusProvider, {}, context?.userId ?? null, context?.authenticatedPrincipal,
      )
    ).models;
    const model = await resolveCommandModel(statusProvider, statusCatalog, context?.sessionId);
    const memoryUsage = process.memoryUsage();

    return {
      type: "builtin",
      action: "status",
      data: {
        version,
        packageName,
        uptime: uptimeFormatted,
        uptimeSeconds: Math.floor(uptime),
        model,
        provider: statusProvider,
        nodeVersion: process.version,
        platform: process.platform,
        pid: process.pid,
        memoryUsage: {
          rssMb: Math.round(memoryUsage.rss / 1024 / 1024),
          heapUsedMb: Math.round(memoryUsage.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        },
      },
    };
  },

  "/memory": async (args, context) => {
    const projectPath = context?.projectPath;

    if (!projectPath) {
      return {
        type: "builtin",
        action: "memory",
        data: {
          error: "No project selected",
          message: "Please select a project to access its CLAUDE.md file",
        },
      };
    }

    const claudeMdPath = path.join(projectPath, "CLAUDE.md");

    // Check if CLAUDE.md exists
    let exists = false;
    try {
      await fs.access(claudeMdPath);
      exists = true;
    } catch (err) {
      // File doesn't exist
    }

    return {
      type: "builtin",
      action: "memory",
      data: {
        path: claudeMdPath,
        exists,
        message: exists
          ? `Opening CLAUDE.md at ${claudeMdPath}`
          : `CLAUDE.md not found at ${claudeMdPath}. Create it to store project-specific instructions.`,
      },
    };
  },

  "/config": async (args, context) => {
    return {
      type: "builtin",
      action: "config",
      data: {
        message: "Opening settings...",
      },
    };
  },

  "/compact": async (args, context) => {
    const provider = readModelProvider(context?.provider);
    if (provider !== "codex") {
      throw new Error("Native /compact execution is available only for Codex sessions.");
    }
    const result = await startCodexCompaction(context?.sessionId, context?.userId, {
      authenticatedPrincipal: context?.authenticatedPrincipal,
    });
    return {
      type: "builtin",
      action: "compact",
      data: {
        provider,
        status: result.status,
        message: result.alreadyRunning
          ? "Codex context compaction completed from the already-running request."
          : "Codex context compaction completed.",
      },
    };
  },

  "/usage": async (args, context) => ({
    type: "builtin",
    action: "usage",
    data: formatUsageResult(await callCodexAppServer(
        context?.sessionId,
      context?.userId,
      "account/usage/read",
      {},
      { authenticatedPrincipal: context?.authenticatedPrincipal },
      )),
  }),

  "/mcp": async (args, context) => ({
    type: "builtin",
    action: "mcp",
    data: formatMcpResult(await callCodexAppServer(
      context?.sessionId,
      context?.userId,
      "mcpServerStatus/list",
      { threadId: context?.sessionId, limit: 100, detail: "toolsAndAuthOnly" },
      { resumeThread: true, authenticatedPrincipal: context?.authenticatedPrincipal },
    )),
  }),

  "/skills": async (args, context) => ({
    type: "builtin",
    action: "skills",
    data: formatScopedItems(await callCodexAppServer(
      context?.sessionId,
      context?.userId,
      "skills/list",
      { cwds: [context?.projectPath].filter(Boolean), forceReload: false },
      { authenticatedPrincipal: context?.authenticatedPrincipal },
    ), "skills", "Codex skills"),
  }),

  "/hooks": async (args, context) => ({
    type: "builtin",
    action: "hooks",
    data: formatScopedItems(await callCodexAppServer(
      context?.sessionId,
      context?.userId,
      "hooks/list",
      { cwds: [context?.projectPath].filter(Boolean) },
      { authenticatedPrincipal: context?.authenticatedPrincipal },
    ), "hooks", "Codex hooks"),
  }),

  "/apps": async (args, context) => ({
    type: "builtin",
    action: "apps",
    data: formatAppsResult(await callCodexAppServer(
      context?.sessionId,
      context?.userId,
      "app/list",
      { threadId: context?.sessionId, limit: 100 },
      { resumeThread: true, authenticatedPrincipal: context?.authenticatedPrincipal },
    )),
  }),

  "/rename": async (args, context) => {
    const name = (Array.isArray(args) ? args : []).map(String).join(" ").trim();
    if (!name) throw new Error("Usage: /rename <name>");
    const data = await callCodexAppServer(
      context?.sessionId,
      context?.userId,
      "thread/name/set",
      { threadId: context?.sessionId, name },
      { accessMode: "write", authenticatedPrincipal: context?.authenticatedPrincipal },
    );
    return {
      type: "builtin",
      action: "rename",
      data: withDisplay(data, `Codex conversation renamed to **${name}**.`),
    };
  },

  "/goal": async (args, context) => {
    const values = (Array.isArray(args) ? args : []).map(String);
    const operation = (values[0] || "").toLowerCase();
    if (operation === "edit" && values.slice(1).join(" ").trim().length === 0) {
      throw Object.assign(new Error("Usage: /goal edit <objective>"), { statusCode: 400 });
    }
    const objective = operation === "edit"
      ? values.slice(1).join(" ").trim()
      : values.join(" ").trim();
    const exactOperation = values.length === 1;
    const shouldClear = exactOperation && operation === "clear";
    const shouldPause = exactOperation && operation === "pause";
    const shouldResume = exactOperation && operation === "resume";
    const method = shouldClear
      ? "thread/goal/clear"
      : objective || shouldPause || shouldResume
        ? "thread/goal/set"
        : "thread/goal/get";
    const params = {
      threadId: context?.sessionId,
      ...(method === "thread/goal/set" && shouldPause ? { status: "paused" } : {}),
      ...(method === "thread/goal/set" && shouldResume ? { status: "active" } : {}),
      ...(method === "thread/goal/set" && !shouldPause && !shouldResume
        ? { objective, status: "active" }
        : {}),
    };
    const data = await callCodexAppServer(
      context?.sessionId,
      context?.userId,
      method,
      params,
      {
        accessMode: method === "thread/goal/get" ? "read" : "write",
        authenticatedPrincipal: context?.authenticatedPrincipal,
      },
    );
    const fallbackMessage = method === "thread/goal/clear"
      ? "The goal was cleared."
      : method === "thread/goal/set"
        ? shouldPause
          ? "The goal was paused."
          : shouldResume
            ? "The goal was resumed."
            : `Goal set to: ${objective}`
        : "No active goal.";
    return { type: "builtin", action: "goal", data: formatGoalResult(data, fallbackMessage) };
  },
};

/**
 * POST /api/commands/list
 * List all available commands from project and user directories
 */
router.post("/list", async (req, res) => {
  try {
    const { projectPath } = req.body;

    // Per-provider dynamic built-ins (Claude only). Provider comes from the
    // request body, mirroring how /execute reads context.provider; defaults to
    // claude. The probe runs under the requesting user's Claude config dir.
    const provider = readModelProvider(req.body?.provider);
    const userId = req.user?.id ?? null;
    // B-145 (extended to /list): /execute was gated on project visibility but
    // this sibling was not, so a raw caller-supplied projectPath still drove a
    // RECURSIVE scan of <path>/.claude/commands — reading every .md file's
    // frontmatter, description and first content line out of any project the
    // caller cannot see (or any directory at all). Gate the project command
    // source on the same predicate; an unknown, archived or private project the
    // caller cannot see contributes nothing rather than failing the request, so
    // the response stays indistinguishable from "that project has no commands".
    const projectCommandsAllowed =
      Boolean(projectPath) &&
      projectsDb.isProjectPathVisibleToUser(projectPath, userId);
    // B-26: derive the effective CLAUDE_CONFIG_DIR the probe will run under so
    // the dynamic-command cache is keyed by the actual probe context, not by the
    // provider alone — otherwise isolated users would share each other's (or a
    // stale) command set. resolveProviderEnv is the single source of truth for
    // isolation (ADR-014); it returns the base env (no override) when the
    // provider is shared or there is no user, collapsing to one shared key.
    const probeConfigDir =
      provider === "claude"
        ? resolveProviderEnv(userId, "claude").CLAUDE_CONFIG_DIR ?? null
        : null;
    const builtInList = await resolveDynamicBuiltIns(provider, {
      userId,
      authenticatedPrincipal: req.user,
      // The probe runs a CLI with this cwd, which makes the directory's own
      // agent configuration effective; only use a path the caller may see.
      cwd: projectCommandsAllowed ? projectPath : null,
      configDir: probeConfigDir,
    });

    const allCommands = [...builtInList];

    // Scan project-level commands (.claude/commands/)
    if (projectCommandsAllowed && provider === "claude") {
      const projectCommandsDir = await resolveContainedCommandsDir(projectPath);
      if (projectCommandsDir) {
        const projectCommands = await scanCommandsDirectory(
          projectCommandsDir,
          projectCommandsDir,
          "project",
        );
        allCommands.push(...projectCommands);
      }
    }

    // Scan user-level commands (~/.claude/commands/)
    const homeDir = os.homedir();
    if (provider === "claude") {
      const userCommandsDir = path.join(homeDir, ".claude", "commands");
      const userCommands = await scanCommandsDirectory(
        userCommandsDir,
        userCommandsDir,
        "user",
      );
      allCommands.push(...userCommands);
    }

    // OC-19: opencode's own commands (~/.config/opencode/command/) so an opencode
    // session's menu reflects the provider's native commands instead of Claude-only
    // built-ins. Read-only and ENOENT-safe (empty until the crew is deployed there).
    // Namespaced 'opencode' so the client can route them to opencode natively — the
    // client-side execution wiring is tracked separately (see OC-19 client remainder).
    // NOTE: shared home path today; per-user XDG isolation is OC-07.
    if (provider === "opencode") {
      const opencodeCommandsDir = path.join(
        homeDir,
        ".config",
        "opencode",
        "command",
      );
      const opencodeCommands = await scanCommandsDirectory(
        opencodeCommandsDir,
        opencodeCommandsDir,
        "opencode",
      );
      allCommands.push(...opencodeCommands);
    }

    // Separate built-in and custom commands
    const customCommands = allCommands.filter(
      (cmd) => cmd.namespace !== "builtin",
    );

    // Sort commands alphabetically by name
    customCommands.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      builtIn: builtInList,
      custom: customCommands,
      count: allCommands.length,
    });
  } catch (error) {
    console.error("Error listing commands:", error);
    res.status(500).json({
      error: "Failed to list commands",
      message: error.message,
    });
  }
});

/**
 * POST /api/commands/execute
 * Execute a command with argument replacement
 * This endpoint prepares the command content but doesn't execute bash commands yet
 * (that will be handled in the command parser utility)
 */
router.post("/execute", async (req, res) => {
  try {
    const { commandName, commandPath, args = [], context = {} } = req.body;

    if (!commandName) {
      return res.status(400).json({
        error: "Command name is required",
      });
    }

    // Handle built-in commands
    const provider = readModelProvider(context?.provider);
    const allowedBuiltIn = builtInsForProvider(provider).some((command) => command.name === commandName);
    const handler = allowedBuiltIn ? builtInHandlers[commandName] : null;
    if (handler) {
      try {
        // B-342: the model catalog these handlers read is per-user, so the
        // identity comes from the TOKEN — never from the client-supplied
        // context, which any caller can set. Overwriting last is deliberate.
        const result = await handler(args, {
          ...context,
          userId: req.user?.id ?? null,
          authenticatedPrincipal: req.user,
        });
        return res.json({
          ...result,
          command: commandName,
        });
      } catch (error) {
        console.error(
          `Error executing built-in command ${commandName}:`,
          error,
        );
        const suppliedStatus = Number(error?.statusCode);
        const statusCode = Number.isInteger(suppliedStatus) && suppliedStatus >= 400 && suppliedStatus <= 599
          ? suppliedStatus
          : 500;
        return res.status(statusCode).json({
          error: "Command execution failed",
          message: error.message,
          command: commandName,
        });
      }
    }


    if (provider === "codex" && String(commandName).startsWith("/")) {
      return res.status(400).json({
        error: "Unsupported Codex command",
        message: `${commandName} is not available in Nassaj's Codex integration.`,
        command: commandName,
      });
    }

    // Handle custom commands
    if (!commandPath) {
      return res.status(400).json({
        error: "Command path is required for custom commands",
      });
    }

    if (typeof commandPath !== "string") {
      return res.status(400).json({ error: "Command path must be a string" });
    }
    const userId = req.user?.id ?? null;
    const userBase = path.resolve(path.join(os.homedir(), ".claude", "commands"));
    const projectBase =
      context?.projectPath && projectsDb.isProjectPathVisibleToUser(context.projectPath, userId)
        ? path.resolve(path.join(context.projectPath, ".claude", "commands"))
        : null;
    const content = await readContainedCommandFile(commandPath, [userBase, projectBase]);
    const { data: metadata, content: commandContent } =
      parseFrontMatter(content);
    // Basic argument replacement (will be enhanced in command parser utility)
    let processedContent = commandContent;

    // Replace $ARGUMENTS with all arguments joined
    const argsString = args.join(" ");
    processedContent = processedContent.replace(/\$ARGUMENTS/g, argsString);

    // Replace $1, $2, etc. with positional arguments
    args.forEach((arg, index) => {
      const placeholder = `$${index + 1}`;
      processedContent = processedContent.replace(
        new RegExp(`\\${placeholder}\\b`, "g"),
        arg,
      );
    });

    res.json({
      type: "custom",
      command: commandName,
      content: processedContent,
      metadata,
      hasFileIncludes: processedContent.includes("@"),
      hasBashCommands: processedContent.includes("!"),
    });
  } catch (error) {
    if (error.code === "COMMAND_ACCESS_DENIED") {
      return res.status(403).json({
        error: "Access denied",
        message: "Command must be a regular file in a .claude/commands directory",
      });
    }
    if (error.code === "COMMAND_FILE_TOO_LARGE") {
      return res.status(413).json({ error: "Command file too large" });
    }
    if (error.code === "ENOENT") {
      return res.status(404).json({
        error: "Command not found",
        message: `Command file not found: ${req.body.commandPath}`,
      });
    }

    console.error("Error executing command:", error);
    res.status(500).json({
      error: "Failed to execute command",
      message: error.message,
    });
  }
});

// Exported for unit testing the dynamic built-in merge/dedupe/resolve logic.
export {
  mergeBuiltInCommands,
  builtInCommands,
  builtInsForProvider,
  CLAUDE_ONLY_BUILTINS,
  resolveDynamicBuiltIns,
  _resetDynamicBuiltInsForTests,
  _seedDynamicBuiltInsForTests,
  readContainedCommandFile,
};

export default router;
