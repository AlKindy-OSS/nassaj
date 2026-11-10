/**
 * ADR-221 (B-1711): Claude's effective deny / ask rules as a neutral rule list, so
 * another harness can enforce what Claude would refuse or ask about.
 *
 * IR entry: `{ tool, kind, match, pattern, effect, source, raw }`
 *  - `tool`    the OpenCode tool id (`bash`, `edit`, `webfetch`, …);
 *  - `kind`    `tool` (the whole tool) or `bash` (a command pattern);
 *  - `match`   for bash: `prefix` (`Bash(x:*)`), `exact`, or `glob` (contains `*`);
 *  - `effect`  `deny` or `ask` (no prompt channel exists, so callers treat ask as deny);
 *  - `source`  the settings label, or `request` for disallowedTools.
 *
 * Slice scope (P2): Bash rules, bare tool names and disallowedTools. Any other rule
 * (a path or domain specifier, `mcp__…`, a tool with no OpenCode equivalent) is
 * returned in `unsupported`; the caller refuses the turn rather than dropping it.
 * `allowManagedPermissionRulesOnly` in managed policy keeps only managed rules.
 */

import { collapseWhitespace, parseRuleSyntax } from '../permission-parity/claude-rule-syntax.js';

/** Claude tool name → OpenCode tool id (an adapter over the shared Claude rule syntax, T-2089). */
const TOOL_MAP = Object.freeze({
  Bash: 'bash',
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list',
  Task: 'task',
  Agent: 'task',
  TodoWrite: 'todowrite',
  Skill: 'skill',
});

const MANAGED = 'managed policy settings';
const collapse = collapseWhitespace;

/**
 * One Claude rule string → an IR entry, or null when this slice cannot enforce it.
 * @param {unknown} raw e.g. `Bash(pm2 restart *)`, `WebFetch`
 * @param {'deny'|'ask'} effect
 * @param {string} source
 */
export function parseClaudeRule(raw, effect, source) {
  const syntax = parseRuleSyntax(raw);
  if (!syntax) return null;
  const tool = TOOL_MAP[syntax.tool];
  if (!tool) return null;
  const base = { tool, effect, source, raw };
  const body = syntax.specifier === null ? '' : collapse(syntax.specifier);
  if (body === '' || body === '*') return { ...base, kind: 'tool', match: null, pattern: null };
  if (tool !== 'bash') return null;
  if (body.endsWith(':*')) {
    const prefix = collapse(body.slice(0, -2));
    return prefix ? { ...base, kind: 'bash', match: 'prefix', pattern: prefix } : { ...base, kind: 'tool', match: null, pattern: null };
  }
  return { ...base, kind: 'bash', match: body.includes('*') ? 'glob' : 'exact', pattern: body };
}

/** @param {object|null} settings @returns {boolean} */
function managedOnly(settings) {
  return settings?.allowManagedPermissionRulesOnly === true
    || settings?.permissions?.allowManagedPermissionRulesOnly === true;
}

/**
 * The effective deny / ask rules for one turn.
 * @param {Array<{ label: string, status: string, settings: object|null }>} sources readClaudeSpawnSettings()
 * @param {{ disallowedTools?: unknown[] }} [request]
 * @returns {{ rules: Array<{ tool: string, kind: string, match: string|null, pattern: string|null,
 *   effect: 'deny'|'ask', source: string, raw: string }>, unsupported: string[], unreadable: string[] }}
 */
export function collectClaudePermissionRules(sources, request = {}) {
  const unreadable = sources.filter((s) => s.status === 'unreadable').map((s) => s.label);
  const loaded = sources.filter((s) => s.status === 'ok');
  const onlyManaged = loaded.some((s) => s.label === MANAGED && managedOnly(s.settings));
  const rules = [];
  const unsupported = [];
  const add = (raw, effect, source) => {
    const rule = parseClaudeRule(raw, effect, source);
    if (rule) rules.push(rule);
    else unsupported.push(String(raw));
  };
  for (const { label, settings } of loaded) {
    if (onlyManaged && label !== MANAGED) continue;
    for (const effect of /** @type {const} */ (['deny', 'ask'])) {
      const list = settings?.permissions?.[effect];
      if (Array.isArray(list)) for (const raw of list) add(raw, effect, label);
    }
  }
  for (const raw of request.disallowedTools ?? []) add(raw, 'deny', 'request');
  return { rules, unsupported, unreadable };
}
