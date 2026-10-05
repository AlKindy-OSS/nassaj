/**
 * Detection of the skill-body row Claude Code injects after a Skill tool call.
 *
 * The CLI persists ONE user-role entry (`isMeta: true`, `sourceToolUseID` = the
 * Skill tool_use id) whose text is `Base directory for this skill: <dir>`
 * followed by the whole SKILL.md. The live SDK stream carries the same text but
 * is typed `SDKUserMessage`, which has no `isMeta`. The model receives it once;
 * this module only lets the chat UI render it as a compact, expandable line.
 */

type AnyRecord = Record<string, any>;

const SKILL_BASE_DIR = /^Base directory for this skill:[ \t]*([^\r\n]+)/;

export type ClaudeSkillLoad = { name: string; body: string };

/** Joined text, or '' when the row holds anything other than text parts. */
function rowText(raw: AnyRecord): string {
  const content = raw.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  if (!content.every((part: AnyRecord) => part?.type === 'text' && typeof part.text === 'string')) return '';
  return content.map((part: AnyRecord) => part.text).join('\n');
}

/** Skill name = last segment of the base directory (`.../skills/<name>`). */
export function skillNameFromBaseDir(baseDir: string): string {
  const segments = baseDir.trim().split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] || baseDir.trim();
}

/**
 * Returns the skill name and body when `raw` is a skill-body row, else null.
 * A `Base directory for this skill:` prefix is required; it must also be
 * machine-marked (`isMeta`, `isSynthetic` or `sourceToolUseID`); verified live:
 * the SDK frame carries `isSynthetic: true` and the same uuid as the persisted
 * row. Typed text is never reclassified, whatever it says. Every content part
 * must be text, so a mixed `[tool_result, text]` row is left untouched.
 */
export function detectClaudeSkillLoad(raw: AnyRecord): ClaudeSkillLoad | null {
  if (raw.type !== 'user' && raw.message?.role !== 'user') return null;
  const text = rowText(raw);
  const match = SKILL_BASE_DIR.exec(text);
  if (!match) return null;
  const baseDir = match[1];
  const marked = raw.isMeta === true
    || raw.isSynthetic === true
    || (typeof raw.sourceToolUseID === 'string' && raw.sourceToolUseID.length > 0);
  if (!marked) return null;
  return { name: skillNameFromBaseDir(baseDir), body: text };
}
