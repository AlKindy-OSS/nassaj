/**
 * dsh-claude-tools — the reviewed map from every tool dsh 0.2.2-rc.1 registers to the
 * Claude tool whose rules and mode govern it (T-2089, ADR-225). A tool absent here refuses
 * the launch.
 *
 * Classes: `read` (path read), `edit` (path write), `bash`, `fetch` (WebFetch), `tool`
 * (a tool-level permission: Claude asks outside bypass unless allowed), `free` (a tool
 * Claude runs without a permission prompt). `job_kill` is a tool-level ask. Tools with no
 * Claude counterpart (working directory, goals, workflow, subagent control) are disabled
 * by the Nassaj layer (S4) and are absent here, so a launch that registers one is refused.
 * The 16 entries are the live tool set under that layer (__tests__/fixtures/dsh-policy-tools.json).
 * Path expansion is dsh's own (measured): `~/x` is dsh's HOME, `$HOME` stays literal,
 * relative paths are taken from the session cwd.
 */
import path from 'node:path';

/** dsh's own path expansion for a tool argument. */
export function dshAbsolutePath(value, { cwd, dshHome }) {
  const text = typeof value === 'string' && value !== '' ? value : '.';
  if (text === '~') return dshHome;
  if (text.startsWith('~/')) return path.join(dshHome, text.slice(2));
  return path.resolve(cwd, text);
}

const file = (args, ctx) => dshAbsolutePath(args.file_path, ctx);
const searchRoot = (args, ctx) => dshAbsolutePath(args.path, ctx);
const command = (args) => (typeof args.command === 'string' ? args.command : '');

/** @type {Record<string, { claude: string, cls: string, input: (args: any, ctx: any) => object }>} */
export const DSH_REVIEWED_TOOLS = Object.freeze({
  bash: { claude: 'Bash', cls: 'bash', input: (args) => ({ command: typeof args.workdir === 'string' && args.workdir
    ? `cd ${args.workdir} && ${command(args)}` : command(args), description: args.description }) },
  read: { claude: 'Read', cls: 'read', input: (args, ctx) => ({ file_path: file(args, ctx) }) },
  read_image: { claude: 'Read', cls: 'read', input: (args, ctx) => ({ file_path: file(args, ctx) }) },
  glob: { claude: 'Glob', cls: 'read', input: (args, ctx) => ({ pattern: args.pattern, path: searchRoot(args, ctx) }) },
  grep: { claude: 'Grep', cls: 'read', input: (args, ctx) => ({ pattern: args.pattern, path: searchRoot(args, ctx),
    ...(args.include === undefined ? {} : { glob: args.include }) }) },
  write: { claude: 'Write', cls: 'edit', input: (args, ctx) => ({ file_path: file(args, ctx), content: args.content }) },
  edit: { claude: 'Edit', cls: 'edit', input: (args, ctx) => ({ file_path: file(args, ctx), old_string: args.old_string,
    new_string: args.new_string, ...(args.replace_all === undefined ? {} : { replace_all: args.replace_all }) }) },
  web_fetch: { claude: 'WebFetch', cls: 'fetch', input: (args) => ({ url: args.url }) },
  web_search: { claude: 'WebSearch', cls: 'tool', input: (args) => ({ query: [].concat(args.queries ?? []).join(' ') }) },
  skill: { claude: 'Skill', cls: 'tool', input: (args) => ({ skill: args.name }) },
  todo_write: { claude: 'TodoWrite', cls: 'free', input: (args) => ({ todos: args.todos }) },
  job_list: { claude: 'BashOutput', cls: 'free', input: (args) => ({ ...args }) },
  job_output: { claude: 'BashOutput', cls: 'free', input: (args) => ({ bash_id: args.job_id }) },
  job_kill: { claude: 'KillShell', cls: 'tool', input: (args) => ({ shell_id: args.job_id }) },
  subagent: { claude: 'Task', cls: 'tool', input: (args) => ({ description: args.description, prompt: args.prompt }) },
  subagent_fork: { claude: 'Task', cls: 'tool', input: (args) => ({ description: args.description, prompt: args.prompt }) },
});

/** A per-call denial of the dsh adapter (the engine turns it into a deny verdict). */
const denied = (code, message) => Object.assign(new Error(message), { code });

/**
 * The Claude call of one dsh call (dsh maps every tool to exactly one Claude call).
 * @param {{ tool: string, args: Record<string, unknown> }} call
 * @param {{ cwd: string, home: string }} ctx `home` is dsh's HOME
 */
export function dshToClaudeCalls({ tool, args }, { cwd, home }) {
  const spec = Object.hasOwn(DSH_REVIEWED_TOOLS, tool) ? DSH_REVIEWED_TOOLS[tool] : null;
  if (!spec) throw denied('parity_tool_unreviewed', `Tool "${tool}" is not reviewed for Claude parity.`);
  // qa C2 (T-2091): a dsh subagent may start in its own cwd, which the engine would not see
  // (Claude's Task has no cwd). Stricter than Claude: refused.
  if (spec.claude === 'Task' && args.cwd !== undefined && args.cwd !== null && args.cwd !== '') {
    throw denied('parity_subagent_cwd', 'Nassaj: a subagent with its own working directory is not supported.');
  }
  const ctx = { cwd, dshHome: home };
  const bashCwd = spec.cls === 'bash' && typeof args.workdir === 'string' && args.workdir ? dshAbsolutePath(args.workdir, ctx) : null;
  return [{ tool_name: spec.claude, tool_input: spec.input(args, ctx), cls: spec.cls, ...(bashCwd ? { bashCwd } : {}) }];
}

/** dsh path expansion in the engine's adapter shape (`home` is dsh's HOME). */
const dshPath = (value, { cwd, home }) => dshAbsolutePath(value, { cwd, dshHome: home });

/** The dsh adapter of createClaudeParityEngine (the default adapter). */
export const dshParityAdapter = Object.freeze({
  name: 'dsh',
  reviewed: DSH_REVIEWED_TOOLS,
  toClaudeCalls: dshToClaudeCalls,
  absolutePath: dshPath,
  shellPath: dshPath,
  harnessHome: (ctx) => ctx.home,
  configPaths: Object.freeze({ segments: Object.freeze(['.claude']), basenames: Object.freeze([]), roots: () => [], bashWrites: false }),
});
