/**
 * Secret-free rendering of one commit for GET /api/git/commit-diff (B-1592).
 *
 * `git show <commit>` printed every file of the commit, so a `.env` that was
 * committed and later deleted stayed readable in full through the history view
 * (only SQLite content was sniffed). History is passive exposure: the viewer
 * never asked to open a secret file, so every path the shared secret guard
 * classifies as secret (isSecretRepositoryPath: dotenv and SQLite names at any
 * depth, plus anything secret on disk) is hidden, project files included.
 *
 * Two layers, both driven by the same classifier:
 *   1. The commit's paths are listed (`--name-status -M -z`); every secret one,
 *      and both sides of a rename touching a secret, is excluded from the
 *      patch (renames off) with a literal, top-anchored `:(exclude)` pathspec,
 *      so git never emits its content. SAFE_SHOW_FLAGS neutralise config that
 *      changes paths or headers (diff.relative, color.ui, prefixes, drivers).
 *   2. The emitted patch is split per file and any section whose header still
 *      names a secret path is dropped (defense in depth against parsing gaps).
 * Each hidden file is listed at the end with HIDDEN_SECRET_FILE_MARKER.
 *
 * The header (author, date, message) comes from a separate `--no-patch` call,
 * because git prints nothing at all for a commit whose only changes are
 * excluded by the pathspec.
 *
 * `runGit(args)` must resolve to `{ stdout }` and run in the repository with
 * GIT_LITERAL_PATHSPECS=1; the patch call re-enables magic for its own,
 * server-built pathspecs only via `--no-literal-pathspecs`.
 */

import path from 'node:path';

import { isSecretRepositoryPath } from '@/shared/secret-path-guard.js';

/** Line shown in place of a hidden file's content. */
export const HIDDEN_SECRET_FILE_MARKER = '# hidden: secret file (content not shown)';

/** Section boundaries of `git show` patch output (plain, combined and dense combined). */
const SECTION_START = /^diff --(?:git|cc|combined) /;

/**
 * Output-shaping flags for every call, overriding repository/user config that
 * would otherwise change paths or headers: `diff.relative` (paths relative to
 * the cwd, so the top-anchored excludes miss), `color.ui=always` (ANSI codes
 * hide section headers from the redactor), external diff drivers, textconv
 * filters and custom or mnemonic prefixes.
 */
export const SAFE_SHOW_FLAGS = Object.freeze([
  '--no-relative', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
]);

/** ANSI escape sequences (colour and cursor control). */
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Paths changed by `commitRef`, repository-relative, with rename detection on
 * so a rename pair is known: `paths` lists every path (both sides of a rename),
 * `renames` the `[from, to]` pairs.
 *
 * @param {(args: string[]) => Promise<{ stdout: string }>} runGit
 * @param {string} commitRef Already validated and peeled (`<ref>^{commit}`).
 * @returns {Promise<{ paths: string[], renames: Array<[string, string]> }>}
 */
export async function listCommitPaths(runGit, commitRef) {
  const { stdout } = await runGit(['show', ...SAFE_SHOW_FLAGS, '-M', '--format=', '--name-status', '-z',
    '--end-of-options', commitRef]);
  const tokens = stdout.split('\0').filter((entry) => entry.length > 0);
  const paths = new Set();
  const renames = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const status = tokens[index];
    if (/^[RC]\d*$/.test(status)) {
      const pair = [tokens[index + 1], tokens[index + 2]];
      if (pair.every((entry) => typeof entry === 'string')) {
        renames.push(pair);
        pair.forEach((entry) => paths.add(entry));
      }
      index += 2;
    } else if (typeof tokens[index + 1] === 'string') {
      paths.add(tokens[index + 1]);
      index += 1;
    }
  }
  return { paths: [...paths], renames };
}

/**
 * Secret paths of a commit: every path the classifier marks, plus BOTH sides
 * of a rename or copy when either side is secret (`.env` -> `notes.txt` would
 * otherwise show the old secret as the new file's content).
 *
 * @param {{ paths: string[], renames: Array<[string, string]> }} listing
 * @param {(repositoryRelativePath: string) => boolean} isSecret
 * @returns {string[]}
 */
export function collectSecretPaths({ paths, renames }, isSecret) {
  const secret = new Set(paths.filter(isSecret));
  for (const [from, to] of renames) {
    if (secret.has(from) || secret.has(to) || isSecret(from) || isSecret(to)) {
      secret.add(from);
      secret.add(to);
    }
  }
  return [...secret];
}

/**
 * Literal, repository-root-anchored exclude pathspec for each path.
 *
 * @param {string[]} repositoryRelativePaths
 * @returns {string[]}
 */
export function buildSecretExcludePathspecs(repositoryRelativePaths) {
  return repositoryRelativePaths.map((entry) => `:(top,exclude,literal)${entry}`);
}

/** Decodes a C-quoted git path (`"a\tb"`, octal escapes) to its raw bytes as UTF-8. */
function unquoteGitPath(quoted) {
  const bytes = [];
  const body = quoted.slice(1, -1);
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = body[index + 1];
    if (/[0-7]/.test(next ?? '')) {
      bytes.push(Number.parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(simple[next] ?? next?.charCodeAt(0) ?? 92);
      index += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Every path a section header can name: the `diff --git`/`--cc` line (quoted
 * or not) and the `---`/`+++` lines, with their `a/` `b/` prefixes removed.
 *
 * @param {string[]} headerLines Lines of one section up to its first hunk.
 * @returns {string[]}
 */
function sectionPaths(headerLines) {
  const out = [];
  const strip = (value) => value.replace(/^[ab]\//, '');
  const first = headerLines[0].replace(SECTION_START, '');
  for (const quoted of first.match(/"(?:[^"\\]|\\.)*"/g) ?? []) out.push(strip(unquoteGitPath(quoted)));
  if (!first.includes('"')) {
    const plain = first.match(/^a\/(.+) b\/(.+)$/);
    if (plain) out.push(plain[1], plain[2]);
    else out.push(first.trim());
  }
  for (const line of headerLines.slice(1)) {
    const match = line.match(/^(?:---|\+\+\+) (.+)$/);
    if (!match || match[1] === '/dev/null') continue;
    const value = match[1].replace(/\t$/, '');
    out.push(strip(value.startsWith('"') ? unquoteGitPath(value) : value));
  }
  return out;
}

/** Matcher for a header line naming `entry` as a whole path (optionally `a/`/`b/` prefixed). */
function pathMatcher(entry) {
  const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|[ "])(?:[ab]/)?${escaped}(?:$|[ "\\t])`);
  return { entry, test: (line) => pattern.test(line) };
}

/**
 * Drops every per-file section of `patch` that names a path for which
 * `isSecret` is true, or that names any of `knownSecretPaths` anywhere in its
 * header. Returns the kept text and the hidden paths it recognised.
 *
 * @param {string} patch `git show` output (header and/or patch).
 * @param {(repositoryRelativePath: string) => boolean} isSecret
 * @param {string[]} [knownSecretPaths]
 * @returns {{ text: string, hidden: string[] }}
 */
export function redactSecretDiffSections(patch, isSecret, knownSecretPaths = []) {
  const known = new Set(knownSecretPaths);
  const matchers = knownSecretPaths.map(pathMatcher);
  const lines = patch.replace(ANSI_ESCAPE, '').split('\n');
  const kept = [];
  const hidden = [];
  let index = 0;
  while (index < lines.length) {
    if (!SECTION_START.test(lines[index])) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !SECTION_START.test(lines[end])) end += 1;
    const section = lines.slice(index, end);
    const hunk = section.findIndex((line) => line.startsWith('@@'));
    const header = section.slice(0, hunk === -1 ? section.length : hunk);
    const named = sectionPaths(header);
    const secret = named.find((entry) => known.has(entry) || isSecret(entry))
      ?? matchers.find((matcher) => header.some((line) => matcher.test(line)))?.entry;
    if (secret === undefined) kept.push(...section);
    else hidden.push(secret);
    index = end;
  }
  return { text: kept.join('\n'), hidden };
}

/** Marker block listing one hidden file in the same shape as a diff section. */
function hiddenFileBlock(repositoryRelativePath) {
  return `diff --git a/${repositoryRelativePath} b/${repositoryRelativePath}\n${HIDDEN_SECRET_FILE_MARKER}\n`;
}

/**
 * Renders `commitRef` (header plus patch) with every secret file hidden.
 *
 * @param {{
 *   runGit: (args: string[]) => Promise<{ stdout: string }>,
 *   repositoryRootPath: string,
 *   commitRef: string,
 * }} params `commitRef` must already be validated and peeled (`<ref>^{commit}`).
 * @returns {Promise<string>}
 */
export async function readCommitDiffWithoutSecrets({ runGit, repositoryRootPath, commitRef }) {
  const root = path.resolve(repositoryRootPath);
  const isSecret = (entry) => isSecretRepositoryPath(root, entry);
  const secretPaths = collectSecretPaths(await listCommitPaths(runGit, commitRef), isSecret);

  const { stdout: header } = await runGit(['show', '--no-patch', '--no-color', '--end-of-options', commitRef]);
  const { stdout: patch } = await runGit(['--no-literal-pathspecs', 'show', ...SAFE_SHOW_FLAGS,
    '--no-renames', '--format=', '--end-of-options', commitRef, '--',
    ...buildSecretExcludePathspecs(secretPaths)]);

  const redacted = redactSecretDiffSections(patch, isSecret, secretPaths);
  const hidden = [...new Set([...secretPaths, ...redacted.hidden])];
  const body = redacted.text.replace(/^\n+/, '');
  const markers = hidden.map(hiddenFileBlock).join('');
  return `${header.replace(ANSI_ESCAPE, '').replace(/\n*$/, '\n\n')}${body}${body && !body.endsWith('\n') ? '\n' : ''}${markers}`;
}
