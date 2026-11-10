/**
 * claude-rule-match — whether Claude rules cover one call (T-2089, ADR-225). Every
 * function is effect-aware so that a deny or ask may only match MORE than Claude would
 * and an allow only LESS: Nassaj's decision equals Claude's or is stricter.
 */
import { collapseWhitespace } from './claude-rule-syntax.js';
import { EDIT_TOOLS, READ_TOOLS } from './claude-rules.js';
import { formsMatch, pathForms, pathMatchers } from './path-rule-match.js';

const ALIASES = { Task: ['Task', 'Agent'], Agent: ['Task', 'Agent'] };
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
const globText = (pattern) => new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** True when a whole-tool rule names the call's Claude tool. */
function toolRuleCovers(rule, call) {
  const names = ALIASES[call.claude] ?? [call.claude];
  if (names.includes(rule.tool)) return true;
  if (rule.effect === 'allow') return false;
  return (READ_TOOLS.includes(rule.tool) && call.cls === 'read') || (EDIT_TOOLS.includes(rule.tool) && call.cls === 'edit');
}

/** One bash rule against one simple-command text. */
export function bashPatternMatches(rule, text, effect) {
  const subject = collapseWhitespace(text);
  const candidates = effect === 'allow' ? [subject] : [subject, subject.replace(ENV_PREFIX, '')];
  return candidates.some((value) => {
    if (rule.kind === 'tool') return true;
    if (rule.match === 'exact') return value === rule.pattern;
    if (rule.match === 'prefix') return value === rule.pattern || value.startsWith(`${rule.pattern} `);
    if (effect !== 'allow' && rule.pattern.endsWith(' *') && value === rule.pattern.slice(0, -2)) return true;
    return globText(rule.pattern).test(value);
  });
}

/** Deny/ask match of an unparseable command: the rule's literal head anywhere at a word start. */
function rawCommandHit(rule, command) {
  if (rule.kind === 'tool') return true;
  const head = collapseWhitespace(rule.pattern.split('*')[0]);
  if (!head) return true;
  const raw = collapseWhitespace(command);
  for (let at = raw.indexOf(head); at >= 0; at = raw.indexOf(head, at + 1)) {
    if (at === 0 || /[\s;&|(`"'$]/.test(raw[at - 1])) return true;
  }
  return false;
}

/** Deny/ask match of a bash rule against a split call. */
function bashRuleHits(rule, call) {
  if (!call.split.parseable) return rawCommandHit(rule, call.input.command);
  return call.split.denyParts.some((part) => bashPatternMatches(rule, part, rule.effect));
}

/** The host of a URL (lowercase, no trailing dot), or null when it cannot be read. */
function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
}

/** WebFetch(domain:…) as Claude reads it: exact host, or `*.suffix` for subdomains. */
function domainMatches(pattern, host, effect) {
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) || (effect !== 'allow' && host === pattern.slice(2));
  }
  return host === pattern || (effect !== 'allow' && host.endsWith(`.${pattern}`));
}

/**
 * The paths a path rule is checked against. Allow: the call's own paths, same family only.
 * Deny/ask (stricter, Claude since 2.1.228): a Read rule also covers edits; for Bash,
 * Edit rules see redirection / tee / file-writer targets and Read rules see those plus
 * `<` targets and file-reader arguments.
 */
function rulePaths(rule, call) {
  const family = READ_TOOLS.includes(rule.tool) ? 'read' : 'edit';
  if (rule.effect === 'allow') return call.cls === family ? call.paths : [];
  if (call.cls === 'bash') return family === 'edit' ? call.bashWrites : [...call.bashReads, ...call.bashWrites];
  if (call.cls === family || (family === 'read' && call.cls === 'edit')) return call.paths;
  return [];
}

/** Whether `rule` (deny/ask: any path; allow: every path) covers the call. */
function pathRuleCovers(rule, call, anchors) {
  const paths = rulePaths(rule, call) ?? [];
  if (paths.length === 0) return false;
  const matchers = pathMatchers(rule.pattern, rule.effect, { ...anchors, settingsDir: rule.settingsDir });
  const hit = (file) => formsMatch(pathForms(file), matchers, rule.effect);
  return rule.effect === 'allow' ? paths.every(hit) : paths.some(hit);
}

/**
 * An MCP rule as Claude reads it (ADR-226): `mcp__server` covers every tool of the server,
 * `mcp__server__*` the same, `mcp__server__tool` that tool.
 */
function mcpRuleCovers(pattern, claudeTool) {
  if (typeof claudeTool !== 'string' || !claudeTool.startsWith('mcp__')) return false;
  if (pattern === claudeTool) return true;
  const server = pattern.endsWith('__*') ? pattern.slice(0, -3) : pattern;
  return server.split('__').length === 2 && claudeTool.startsWith(`${server}__`);
}

/**
 * Whether one rule covers one call. Bash allow is decided by bashAllowCovers (every part).
 * @param {import('./claude-rules.js').ClaudeRule} rule
 * @param {{ claude: string, cls: string, input: any, paths: string[], split?: any }} call
 * @param {{ cwd: string, claudeHome: string, dshHome: string }} anchors
 */
export function ruleCovers(rule, call, anchors) {
  switch (rule.kind) {
    case 'tool': return toolRuleCovers(rule, call);
    case 'bash': return call.cls === 'bash' && rule.effect !== 'allow' && bashRuleHits(rule, call);
    case 'path': return pathRuleCovers(rule, call, anchors);
    case 'domain': {
      if (call.cls !== 'fetch') return false;
      const host = hostOf(call.input.url);
      if (host === null) return rule.effect !== 'allow';
      return domainMatches(rule.pattern, host, rule.effect);
    }
    case 'mcp': return mcpRuleCovers(rule.pattern, call.claude);
    default: return false;
  }
}

/** Bash allow: parseable, no file redirection, and EVERY part allowed by some rule. */
export function bashAllowCovers(allowRules, call) {
  if (!call.split.parseable || call.split.writes.length > 0) return false;
  const bashRules = allowRules.filter((rule) => rule.tool === 'Bash');
  return call.split.parts.length > 0
    && call.split.parts.every((part) => bashRules.some((rule) => bashPatternMatches(rule, part, 'allow')));
}
