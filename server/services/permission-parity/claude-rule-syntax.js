/**
 * claude-rule-syntax — the one parser of Claude permission rule strings (T-2089, ADR-225),
 * shared by the dsh parity engine and the OpenCode rule adapter (claude-permission-rules.js).
 * `Tool` and `Tool(*)` / `Tool()` mean the whole tool (specifier null).
 */

const RULE_SHAPE = /^([A-Za-z][A-Za-z0-9_]*)(?:\(([\s\S]*)\))?$/;

/**
 * @param {unknown} raw a rule string, e.g. `Bash(pm2 restart *)`, `WebSearch`, `mcp__srv`
 * @returns {{ tool: string, specifier: string|null } | null} null when it is not a rule
 */
export function parseRuleSyntax(raw) {
  if (typeof raw !== 'string') return null;
  const shape = RULE_SHAPE.exec(raw.trim());
  if (!shape) return null;
  const [, tool, spec] = shape;
  const body = spec === undefined ? '' : spec.trim();
  return { tool, specifier: body === '' || body === '*' ? null : body };
}

/** @param {string} text @returns {string} whitespace-collapsed, trimmed */
export function collapseWhitespace(text) {
  return text.trim().replace(/\s+/g, ' ');
}
