/**
 * opencode-claude-tools — the OpenCode harness adapter of the Claude-parity engine
 * (ADR-226 §1.1, B-1759). Every OpenCode 1.19.5 tool call becomes one or more Claude calls
 * `{ tool_name, tool_input, cls }`; the engine decides them with Claude's hooks, rules and
 * mode, and a call that maps to several Claude calls takes the strongest decision.
 *
 * Measured on the installed binary (fixtures/opencode-stage0/stage0-evidence.json):
 *  - relative paths resolve against the session cwd; `~/x` is NOT expanded (it becomes
 *    `<cwd>/~/x`), so `~` is a literal path segment here. Bash expands `~` itself, from the
 *    opencode process HOME (`shellPath`);
 *  - glob/grep/todowrite accept unknown extra fields, so every field outside the reviewed
 *    map (opencode-tool-map.json) is denied per call (`validateOpencodeArgs`);
 *  - MCP tools are named `<server>_<tool>` with the server name sanitized, so `probe:a_b`
 *    and `probe_a:b` both become `probe_a_b`. Every split against the servers configured
 *    for the spawn is returned (rules are matched against each, the strongest wins) and the
 *    call is marked `ambiguous` (the engine denies it after the rules);
 *  - the apply_patch grammar (`parseApplyPatch`) includes `*** End of File` inside update
 *    hunks.
 * Throws `OpencodeToolDenied` (with a `code`) for everything the engine must deny.
 */
import fs from 'node:fs';
import path from 'node:path';

// A JSON import (not a readFileSync path) so tsc emits the map into dist-server.
import shippedToolMap from './opencode-tool-map.json' with { type: 'json' };

export const OPENCODE_TOOL_CODES = Object.freeze({
  unreviewed: 'parity_tool_unreviewed',
  field: 'parity_field_unreviewed',
  patch: 'parity_patch_invalid',
  mcpUnknown: 'parity_mcp_server_unknown',
  question: 'parity_question_unsupported',
});

/** A per-call denial from the adapter; the engine turns it into a deny verdict. */
export class OpencodeToolDenied extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'OpencodeToolDenied';
    this.code = code;
  }
}

/**
 * @param {string} [file] a map file to read instead of the shipped map
 * @returns {{ opencode: string, tools: Record<string, { claude: string, cls: string, fields: Record<string, string>, ignored: string[] }> }}
 */
export function loadOpencodeToolMap(file) {
  return file === undefined ? structuredClone(shippedToolMap) : JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const OPENCODE_TOOL_MAP = Object.freeze(loadOpencodeToolMap());
const TOOLS = OPENCODE_TOOL_MAP.tools;

/** OpenCode's own path resolution for a tool argument: relative to cwd, `~` literal. */
export function opencodeAbsolutePath(value, { cwd }) {
  return path.resolve(cwd, typeof value === 'string' && value !== '' ? value : '.');
}

/** A path as bash sees it: `~` and `~/x` from the opencode process HOME, else from cwd. */
export function opencodeShellPath(value, { cwd, home }) {
  const text = typeof value === 'string' && value !== '' ? value : '.';
  if (text === '~') return home;
  if (text.startsWith('~/')) return path.join(home, text.slice(2));
  return path.resolve(cwd, text);
}

const jsonType = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

/** Denies a field outside fields + ignored, or a reviewed field of another JSON type. */
export function validateOpencodeArgs(tool, args) {
  const entry = TOOLS[tool];
  for (const [field, value] of Object.entries(args)) {
    const want = entry.fields[field];
    if (want === undefined && !entry.ignored.includes(field)) {
      throw new OpencodeToolDenied(OPENCODE_TOOL_CODES.field, `Nassaj: field "${field}" of ${tool} is not reviewed for Claude parity.`);
    }
    if (want !== undefined && jsonType(value) !== want) {
      throw new OpencodeToolDenied(OPENCODE_TOOL_CODES.field, `Nassaj: field "${field}" of ${tool} must be a ${want}.`);
    }
  }
}

const HEADER = Object.freeze({ add: '*** Add File:', update: '*** Update File:', delete: '*** Delete File:' });
const MOVE = '*** Move to:';
const patchError = (message) => new OpencodeToolDenied(OPENCODE_TOOL_CODES.patch, `Nassaj: apply_patch ${message}.`);

/** The path after a header, or a parse error when it is empty. */
function headerPath(line, prefix) {
  const value = line.slice(prefix.length).trim();
  if (!value) throw patchError(`header "${prefix}" has no path`);
  return value;
}

/**
 * The file operations of an apply_patch text (OpenCode's grammar, read strictly: the first
 * line is `*** Begin Patch`, the last `*** End Patch`, and every other `***` line is a known
 * header in its place; OpenCode itself skips unknown lines, so anything it would act on is
 * listed here or the patch is refused).
 * @param {unknown} text
 * @returns {Array<{ type: 'add'|'update'|'delete', path: string, movePath?: string }>}
 */
export function parseApplyPatch(text) {
  return readApplyPatch(text).map(({ body, ...hunk }) => hunk);
}

/** parseApplyPatch with each hunk's body lines (`+x`, `-x`, ` x`, `@@ …`) kept. */
function readApplyPatch(text) {
  if (typeof text !== 'string') throw patchError('text must be a string');
  const lines = text.trim().split('\n');
  if (lines[0].trim() !== '*** Begin Patch' || lines.length < 2 || lines.at(-1).trim() !== '*** End Patch') {
    throw patchError('must start with "*** Begin Patch" and end with "*** End Patch"');
  }
  const hunks = [];
  for (let at = 1; at < lines.length - 1; at += 1) {
    const line = lines[at];
    if (!line.startsWith('***')) {
      if (hunks.length === 0) throw patchError('has content before the first file header');
      hunks.at(-1).body.push(line.replace(/\r$/, ''));
      continue;
    }
    const last = hunks.at(-1);
    if (line.startsWith(HEADER.add)) hunks.push({ type: 'add', path: headerPath(line, HEADER.add), body: [] });
    else if (line.startsWith(HEADER.delete)) hunks.push({ type: 'delete', path: headerPath(line, HEADER.delete), body: [] });
    else if (line.startsWith(HEADER.update)) hunks.push({ type: 'update', path: headerPath(line, HEADER.update), body: [] });
    else if (line.startsWith(MOVE) && last?.type === 'update' && lines[at - 1].startsWith(HEADER.update)) {
      last.movePath = headerPath(line, MOVE);
    } else if (line === '*** End of File' && last?.type === 'update') continue;
    else throw patchError(`has an unsupported line "${line.slice(0, 60)}"`);
  }
  if (hunks.length === 0) throw patchError('changes no file');
  return hunks;
}

/** OpenCode's MCP name part: anything outside [A-Za-z0-9_-] becomes `_`. */
export const sanitizeMcpName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, '_');

/**
 * Every `<server>_<tool>` split of an OpenCode tool name against the configured servers.
 * @param {string} name
 * @param {readonly string[]} servers
 * @returns {Array<{ server: string, tool: string }>}
 */
export function splitMcpToolName(name, servers = []) {
  const splits = [];
  for (const server of new Set(servers.map(sanitizeMcpName))) {
    const prefix = `${server}_`;
    if (server && name.startsWith(prefix) && name.length > prefix.length) splits.push({ server, tool: name.slice(prefix.length) });
  }
  return splits;
}

/** The Bash input: `workdir` becomes a leading `cd`, as dsh does (quoted when needed). */
function bashInput(args) {
  const command = typeof args.command === 'string' ? args.command : '';
  if (typeof args.workdir !== 'string' || args.workdir === '') return { command, description: args.description };
  const dir = /^[\w@%+=:,./~-]+$/.test(args.workdir) ? args.workdir : `'${args.workdir.replaceAll("'", "'\\''")}'`;
  return { command: `cd ${dir} && ${command}`, description: args.description };
}

/** A configured MCP server named by a resource tool, or a denial. */
function assertServer(server, servers) {
  if (server === undefined) return;
  if (!servers.map(sanitizeMcpName).includes(sanitizeMcpName(server))) {
    throw new OpencodeToolDenied(OPENCODE_TOOL_CODES.mcpUnknown, `Nassaj: MCP server "${server}" is not configured for this turn.`);
  }
}

/** The lines of a hunk body with one of the prefixes, prefix stripped (`@@` lines dropped). */
const bodyLines = (body, prefixes) => body.filter((line) => prefixes.includes(line[0] ?? ' ') && !line.startsWith('@@'))
  .map((line) => line.slice(1));

/**
 * Claude inputs of one apply_patch hunk, with the content hooks and cards need (H2): Add is
 * Claude's Write with the new file's text; Update is an Edit with the old and new lines (a
 * move edits the target too); Delete is an Edit with empty strings (Claude has no delete).
 */
function patchInputs(hunk, ctx) {
  const file = opencodeAbsolutePath(hunk.path, ctx);
  if (hunk.type === 'add') return [{ toolName: 'Write', file_path: file, content: bodyLines(hunk.body, ['+']).join('\n') }];
  if (hunk.type === 'delete') return [{ file_path: file, old_string: '', new_string: '' }];
  const edit = { old_string: bodyLines(hunk.body, [' ', '-']).join('\n'), new_string: bodyLines(hunk.body, [' ', '+']).join('\n') };
  return [{ file_path: file, ...edit }, ...(hunk.movePath ? [{ file_path: opencodeAbsolutePath(hunk.movePath, ctx), ...edit }] : [])];
}

/** Claude inputs of one reviewed built-in call (paths absolute, OpenCode's resolution). */
function builtinInputs(tool, args, ctx) {
  const file = () => opencodeAbsolutePath(args.filePath, ctx);
  switch (tool) {
    case 'bash': return [{ ...bashInput(args), ...(args.workdir ? { bashCwd: opencodeAbsolutePath(args.workdir, ctx) } : {}) }];
    case 'read': return [{ file_path: file() }];
    case 'glob': return [{ pattern: args.pattern, path: opencodeAbsolutePath(args.path, ctx) }];
    case 'grep': return [{ pattern: args.pattern, path: opencodeAbsolutePath(args.path, ctx), ...(args.include === undefined ? {} : { glob: args.include }) }];
    case 'edit': return [{ file_path: file(), old_string: args.oldString, new_string: args.newString,
      ...(args.replaceAll === undefined ? {} : { replace_all: args.replaceAll }) }];
    case 'write': return [{ file_path: file(), content: args.content }];
    case 'apply_patch': return readApplyPatch(args.patchText).flatMap((hunk) => patchInputs(hunk, ctx));
    case 'task': return [{ description: args.description, prompt: args.prompt, subagent_type: args.subagent_type }];
    case 'webfetch': return [{ url: args.url }];
    case 'websearch': return [{ query: args.query }];
    case 'todowrite': return [{ todos: args.todos }];
    case 'skill': return [{ skill: args.name }];
    case 'invalid': return [{ tool: args.tool, error: args.error }];
    case 'read_mcp_resource': assertServer(args.server, ctx.mcpServers ?? []); return [{ server: args.server, uri: args.uri }];
    default: assertServer(args.server, ctx.mcpServers ?? []); return [args.server === undefined ? {} : { server: args.server }];
  }
}

/**
 * The Claude calls of one OpenCode call.
 * @param {{ tool: string, args: Record<string, unknown> }} call
 * @param {{ cwd: string, home: string, mcpServers?: readonly string[] }} ctx
 * @returns {Array<{ tool_name: string, tool_input: object, cls: string, bashCwd?: string, ambiguous?: boolean }>}
 */
export function toClaudeCalls({ tool, args }, ctx) {
  const servers = ctx.mcpServers ?? [];
  const splits = typeof tool === 'string' ? splitMcpToolName(tool, servers) : [];
  if (typeof tool === 'string' && Object.hasOwn(TOOLS, tool)) {
    const entry = TOOLS[tool];
    if (entry.cls === 'denied') {
      throw new OpencodeToolDenied(OPENCODE_TOOL_CODES.question,
        'Nassaj: the question tool is not available in this session; ask the user in plain text instead.');
    }
    if (splits.length > 0) {
      throw new OpencodeToolDenied(OPENCODE_TOOL_CODES.unreviewed, `Nassaj: tool "${tool}" is ambiguous with an MCP tool.`);
    }
    validateOpencodeArgs(tool, args);
    return builtinInputs(tool, args, ctx).map(({ bashCwd, toolName, ...input }) => ({ tool_name: toolName ?? entry.claude,
      tool_input: input, cls: entry.cls, ...(bashCwd ? { bashCwd } : {}) }));
  }
  if (splits.length === 0) {
    throw new OpencodeToolDenied(OPENCODE_TOOL_CODES.unreviewed, `Tool "${tool}" is not reviewed for Claude parity.`);
  }
  return splits.map(({ server, tool: name }) => ({ tool_name: `mcp__${server}__${name}`, tool_input: structuredClone(args), cls: 'tool',
    ...(splits.length > 1 ? { ambiguous: true } : {}) }));
}

/**
 * What the member's approval card shows for an asking OpenCode call (H2): the deciding
 * Claude call, and for apply_patch also the whole patch text and every file it touches, so
 * approving one card never approves a change the card did not show.
 * @param {{ tool?: string, args?: { patchText?: unknown }, claude?: { tool_name?: string, tool_input?: object } | null,
 *   claudeCalls?: Array<{ tool_name: string, tool_input: { file_path?: string } }> }} card
 * @returns {{ toolName: string, input: object }}
 */
export function opencodePermissionCard({ tool, args, claude, claudeCalls }) {
  const toolName = claude?.tool_name ?? tool ?? 'tool';
  const input = claude?.tool_input ?? {};
  if (tool !== 'apply_patch' || typeof args?.patchText !== 'string') return { toolName, input };
  const calls = claudeCalls?.length ? claudeCalls : claude ? [claude] : [];
  const files = calls.map((call) => ({ tool: call.tool_name, file_path: call.tool_input?.file_path }));
  return { toolName, input: { ...input, patchText: args.patchText, files } };
}

/** What `.claude` is to Claude, on OpenCode (ADR-226 §4 B-1759b). */
export const OPENCODE_CONFIG_PATHS = Object.freeze({
  segments: Object.freeze(['.claude', '.opencode']),
  basenames: Object.freeze(['opencode.json', 'opencode.jsonc']),
  /** The member's OpenCode config home (agent/, command/, skills/ included). */
  roots: (ctx) => [path.join(ctx.env?.XDG_CONFIG_HOME || path.join(ctx.home, '.config'), 'opencode')],
  bashWrites: true,
});

/** The OpenCode adapter of createClaudeParityEngine. */
export const opencodeParityAdapter = Object.freeze({
  name: 'opencode',
  reviewed: TOOLS,
  toClaudeCalls,
  absolutePath: opencodeAbsolutePath,
  shellPath: opencodeShellPath,
  harnessHome: (ctx) => ctx.home,
  configPaths: OPENCODE_CONFIG_PATHS,
});
