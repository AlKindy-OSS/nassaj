/**
 * claude-rules — Claude's permission rules (allow / ask / deny) keyed by CLAUDE tool name,
 * provider-neutral (T-2089, ADR-225). Each rule keeps its source file's dir, because a
 * `/x` path rule is anchored there. A deny or ask rule this module cannot enforce is
 * returned in `unsupported` (the caller refuses the launch); an allow rule it cannot read
 * is dropped, which can only make a call ask (never allow more than Claude).
 */
import path from 'node:path';

import { collapseWhitespace, parseRuleSyntax } from './claude-rule-syntax.js';

const MANAGED = 'managed policy settings';
/** Claude tools whose specifier is a path (Read rules govern reads, Edit rules edits). */
export const READ_TOOLS = Object.freeze(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
export const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/** Claude tools a rule may name without a specifier. */
const BARE_TOOLS = new Set([...READ_TOOLS, ...EDIT_TOOLS, 'Bash', 'WebFetch', 'WebSearch', 'Task', 'Agent',
  'TodoWrite', 'AskUserQuestion', 'Skill', 'SlashCommand', 'BashOutput', 'KillShell', 'ExitPlanMode']);

/**
 * @typedef {{ tool: string, effect: 'allow'|'ask'|'deny', kind: 'tool'|'bash'|'path'|'domain'|'mcp',
 *   pattern: string|null, match?: 'exact'|'prefix'|'glob', settingsDir: string, source: string, raw: string }} ClaudeRule
 */

/** The bash form of a specifier: `x:*` prefix, `*` glob, else exact. */
function bashRule(spec) {
  const body = collapseWhitespace(spec);
  if (body.endsWith(':*')) {
    const prefix = collapseWhitespace(body.slice(0, -2));
    return prefix ? { kind: 'bash', match: 'prefix', pattern: prefix } : { kind: 'tool', pattern: null };
  }
  return { kind: 'bash', match: body.includes('*') ? 'glob' : 'exact', pattern: body };
}

/** One rule string → a ClaudeRule, or null when this engine cannot enforce it. */
export function parseClaudeRuleForParity(raw, effect, source, settingsDir) {
  const syntax = parseRuleSyntax(raw);
  if (!syntax) return null;
  const { tool, specifier } = syntax;
  const base = { tool, effect, source, raw: String(raw), settingsDir };
  if (tool.startsWith('mcp__')) return specifier === null ? { ...base, kind: 'mcp', pattern: tool } : null;
  if (!BARE_TOOLS.has(tool)) return null;
  if (specifier === null) return { ...base, kind: 'tool', pattern: null };
  if (tool === 'Bash') return { ...base, ...bashRule(specifier) };
  if (READ_TOOLS.includes(tool) || EDIT_TOOLS.includes(tool)) return { ...base, kind: 'path', pattern: specifier };
  if (tool === 'WebFetch' && /^domain:(?:\*\.)?[^\s/*]+$/.test(specifier)) {
    return { ...base, kind: 'domain', pattern: specifier.slice(7).toLowerCase().replace(/\.$/, '') };
  }
  return null;
}

/** @param {object|null} settings */
const managedOnly = (settings) => settings?.allowManagedPermissionRulesOnly === true
  || settings?.permissions?.allowManagedPermissionRulesOnly === true;

/**
 * Every rule and working directory of the loaded sources.
 * @param {Array<{ file: string, label: string, status: string, settings: object|null }>} sources
 * @param {{ cwd: string, disallowedTools?: unknown[] }} request
 * @returns {{ rules: ClaudeRule[], unsupported: string[], unreadable: string[], additionalDirectories: string[] }}
 */
export function collectParityRules(sources, { cwd, disallowedTools = [] }) {
  const unreadable = sources.filter((s) => s.status === 'unreadable').map((s) => s.label);
  const loaded = sources.filter((s) => s.status === 'ok');
  const onlyManaged = loaded.some((s) => s.label === MANAGED && managedOnly(s.settings));
  const rules = [];
  const unsupported = [];
  const additionalDirectories = [];
  const add = (raw, effect, source, dir) => {
    const rule = parseClaudeRuleForParity(raw, effect, source, dir);
    if (rule) rules.push(rule);
    else if (effect !== 'allow') unsupported.push(String(raw));
  };
  for (const { file, label, settings } of loaded) {
    const dir = path.dirname(file);
    const permissions = settings?.permissions;
    if (Array.isArray(permissions?.additionalDirectories)) {
      for (const entry of permissions.additionalDirectories) if (typeof entry === 'string') additionalDirectories.push(entry);
    }
    if (onlyManaged && label !== MANAGED) continue;
    for (const effect of /** @type {const} */ (['deny', 'ask', 'allow'])) {
      const list = permissions?.[effect];
      if (Array.isArray(list)) for (const raw of list) add(raw, effect, label, dir);
    }
  }
  for (const raw of disallowedTools) add(raw, 'deny', 'request', cwd);
  return { rules, unsupported, unreadable, additionalDirectories };
}
