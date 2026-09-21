/**
 * transcript-block-repair.js — B-421.
 *
 * A Claude Code transcript is REPLAYED VERBATIM on every resume: the whole
 * message history goes back to the API each turn. That makes one malformed
 * content block permanent poison — not a transient error. The session never
 * recovers on its own, and the user sees the same 400 forever.
 *
 * The block we have actually been bitten by:
 *
 *   {"type":"server_tool_use","id":"call_0670a475d8a3443bb3ef9d9e",
 *    "name":"analyze_image","input":{}}
 *
 * written by glm-5.2 running as a Claude ENGINE (ADR-037: the Claude Code CLI
 * pointed at a vendor's ANTHROPIC_BASE_URL). z.ai answered a request for its
 * own built-in tool using ITS id convention (`call_…`), the CLI wrote that
 * straight into `<sessionId>.jsonl`, and from then on every turn died with:
 *
 *   400 messages.19.content.2.server_tool_use.id:
 *       String should match pattern '^srvtoolu_[a-zA-Z0-9_]+$'
 *
 * We cannot fix the writer — the CLI owns the transcript file, not nassaj. So
 * we repair the file just before handing it back for a resume, converting each
 * non-conforming block into a plain `text` block that PRESERVES its content.
 * Nothing is deleted: the tool's name, input and result stay readable in the
 * conversation; only the block *type* the API validates is given up.
 *
 * Two properties this module treats as non-negotiable:
 *
 *  1. FAIL-OPEN. A repair that throws must never block a spawn. Every failure
 *     path returns a reason and leaves the file untouched — a session that
 *     would have worked keeps working.
 *  2. NEVER TOUCH A HEALTHY FILE. The overwhelming majority of transcripts
 *     (every official-Anthropic session) contain no `server_tool_use` at all.
 *     Those exit on a substring test, before any JSON parsing.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/** The pattern the Anthropic API enforces on server-tool ids. */
const SERVER_TOOL_ID_PATTERN = /^srvtoolu_[a-zA-Z0-9_]+$/;

/** The pattern the API enforces on CLIENT tool ids (`tool_use.id`). */
const CLIENT_TOOL_ID_PATTERN = /^toolu_[a-zA-Z0-9_]+$/;

/** A `tool_result` may point at either kind. */
const ANY_TOOL_ID_PATTERN = /^(?:toolu_|srvtoolu_)[a-zA-Z0-9_]+$/;

/**
 * Cheap pre-filter. Only a file that mentions one of these block types can
 * possibly carry a bad id, so a plain substring test rules out ~every
 * transcript without parsing a single line.
 *
 * ⚠️ Applies to the DEFAULT ('server-tool') mode only. The cross-engine mode
 * below must never use it — see the CROSS_ENGINE note there.
 */
const SUSPECT_MARKER = '"server_tool_use"';

/**
 * Repair modes.
 *
 *  • 'server-tool' (default) — B-421 as shipped: the single block shape that has
 *    actually poisoned a live session. Byte-for-byte unchanged, still fail-open,
 *    still exits on the substring pre-filter.
 *
 *  • 'cross-engine' — ADR-099/T-1237: a session PINNED to a vendor engine is
 *    being re-stamped to official Anthropic, so its whole history is about to be
 *    replayed to an API that never saw it. Everything the vendor wrote in its own
 *    conventions is now a permanent 400.
 *
 *    Measured on session 406fec0e (2026-08-04), the session this contract was
 *    written from — and the reason the pre-filter must NOT run in this mode:
 *
 *        server_tool_use ............................ 0   ← the only shape v1 knew
 *        tool_use with a `call_…` id ............... 39   ← rejected: needs ^toolu_
 *        thinking with no `signature` .............. 21   ← rejected on replay
 *
 *    Zero of the 60 rejectable blocks were reachable: the file does not contain
 *    the marker, so v1 returned 'clean' without opening a single line. A design
 *    that called the repair "mandatory" on this path would have turned one click
 *    into a permanently dead conversation (qa-critic حرج 1, verified).
 */
export const REPAIR_MODE = Object.freeze({
  SERVER_TOOL: 'server-tool',
  CROSS_ENGINE: 'cross-engine',
});

/** Session ids are uuids; anything else is not ours to open. */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/**
 * Claude Code's project-directory encoding: every character outside
 * [a-zA-Z0-9-] becomes '-'. Mirrored from server/index.js (the read path) —
 * keep the two in step.
 */
export function encodeProjectDir(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Resolves `<configDir>/projects/<encoded cwd>/<sessionId>.jsonl`.
 *
 * @returns {string|null} null when any input is missing or unsafe.
 */
export function resolveTranscriptPath({ sessionId, cwd, configDir }) {
  if (!sessionId || !cwd) return null;
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const root = configDir || path.join(os.homedir(), '.claude');
  const projectDir = path.join(root, 'projects', encodeProjectDir(cwd));
  const file = path.join(projectDir, `${sessionId}.jsonl`);
  // Defence in depth: the id regex already forbids separators.
  const rel = path.relative(path.resolve(projectDir), path.resolve(file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return file;
}

/**
 * Renders a rejected block's payload as text, so repairing loses no meaning.
 */
function blockToText(block) {
  const parts = [];
  if (block.name) parts.push(`**${block.name}**`);
  // `thinking` carries its payload in its own field and has neither content nor
  // input, so without this it would render as the empty-block placeholder and
  // silently lose the reasoning it holds.
  const body = block.type === 'thinking'
    ? block.thinking
    : (block.content !== undefined ? block.content : block.input);
  if (typeof body === 'string') {
    if (body.trim()) parts.push(body);
  } else if (body !== undefined && body !== null) {
    let rendered;
    try {
      rendered = JSON.stringify(body);
    } catch {
      rendered = String(body);
    }
    if (rendered && rendered !== '{}' && rendered !== 'null') parts.push(rendered);
  }
  const rendered = parts.join('\n');
  return rendered || '[nassaj: كتلة أداة بمعرّف غير مطابق، بلا محتوى]';
}

/**
 * Repairs ONE parsed transcript record in place.
 *
 * Rewrites two block shapes whose id the API will reject:
 *   - `server_tool_use` whose `id` is not `srvtoolu_…`
 *   - `tool_result` inside an ASSISTANT message whose `tool_use_id` is not
 *     `srvtoolu_…` — the orphan half of the same vendor emission. (A
 *     `tool_result` in a USER message is the normal client-tool round-trip and
 *     is left strictly alone.)
 *
 * `stop_reason: 'tool_use'` is downgraded to `'end_turn'` on a repaired
 * message: with the tool block gone, the original stop reason would describe a
 * call that no longer exists.
 *
 * @param {Array<{type: string, name: string|null}>} [seen] collects WHAT was
 *   rewritten, so the caller can record a diagnostic audit row. Block *types*
 *   and tool *names* only — never ids, inputs or results.
 * @returns {number} how many blocks were rewritten (0 = record untouched).
 */
export function repairRecord(record, seen, mode = REPAIR_MODE.SERVER_TOOL) {
  const message = record?.message;
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  const crossEngine = mode === REPAIR_MODE.CROSS_ENGINE;

  let repaired = 0;
  const next = content.map((block) => {
    if (!block || typeof block !== 'object') return block;

    const isBadServerTool =
      block.type === 'server_tool_use' && !SERVER_TOOL_ID_PATTERN.test(block.id ?? '');
    const isOrphanResult =
      block.type === 'tool_result' &&
      message.role === 'assistant' &&
      !SERVER_TOOL_ID_PATTERN.test(block.tool_use_id ?? '');

    // ── cross-engine only ──────────────────────────────────────────────────
    // A vendor's `call_…` id on a CLIENT tool block. Both halves are matched by
    // the SAME id rule rather than by role, which is what keeps the pair
    // consistent without a second pass: rewriting `tool_use` while leaving its
    // `tool_result` behind trades one 400 ("id must match ^toolu_") for another
    // ("tool_result without tool_use"), so the id — not the position — decides.
    const isBadClientTool =
      crossEngine &&
      block.type === 'tool_use' &&
      !CLIENT_TOOL_ID_PATTERN.test(block.id ?? '');
    const isBadToolResult =
      crossEngine &&
      block.type === 'tool_result' &&
      !ANY_TOOL_ID_PATTERN.test(block.tool_use_id ?? '');
    // An unsigned `thinking` block: the signature is what proves the reasoning
    // came from the model that claims it, and a vendor engine has none to give.
    //
    // ⚠️ The EMPTY STRING is the real-world shape, not a missing key. Measured on
    // session 406fec0e: all 21 unsigned blocks carry `"signature":""`, so a
    // `typeof !== 'string'` test — the obvious spelling, and the one written here
    // first — matches ZERO of them. Rendered as text like everything else.
    const isUnsignedThinking =
      crossEngine &&
      block.type === 'thinking' &&
      (typeof block.signature !== 'string' || block.signature.trim() === '');

    if (!isBadServerTool && !isOrphanResult
      && !isBadClientTool && !isBadToolResult && !isUnsignedThinking) return block;

    repaired += 1;
    if (Array.isArray(seen)) {
      seen.push({ type: block.type, name: typeof block.name === 'string' ? block.name : null });
    }
    return { type: 'text', text: blockToText(block) };
  });

  if (!repaired) return 0;
  message.content = next;
  if (message.stop_reason === 'tool_use') message.stop_reason = 'end_turn';
  return repaired;
}

/**
 * Scans and, when needed, rewrites a transcript file.
 *
 * Atomic: writes a sibling `.tmp` then renames over the original. The shared
 * `~/.claude/projects` tree is reached through per-user SYMLINKED directories
 * (provision-user-dirs), never hardlinks, so a rename in the real directory is
 * seen by every mirror.
 *
 * @param {string} jsonlPath
 * @returns {{repaired: number, blocks: number, lines: number[], reason?: string}}
 */
export function repairTranscriptFile(jsonlPath, mode = REPAIR_MODE.SERVER_TOOL) {
  const untouched = (reason) => ({ repaired: 0, blocks: 0, lines: [], seen: [], reason });
  const crossEngine = mode === REPAIR_MODE.CROSS_ENGINE;

  let raw;
  try {
    raw = fs.readFileSync(jsonlPath, 'utf8');
  } catch (error) {
    // Missing file is the normal case for a brand-new or foreign session.
    return untouched(error?.code === 'ENOENT' ? 'absent' : `unreadable:${error?.code || 'error'}`);
  }

  // Fast path: no candidate block type anywhere ⇒ nothing to do, no parsing.
  // NOT taken when crossing engines: the marker names one block shape out of
  // three, and the session that motivated this contract had zero of it while
  // carrying 60 blocks of the other two (see REPAIR_MODE).
  if (!crossEngine && !raw.includes(SUSPECT_MARKER)) return untouched('clean');

  const lines = raw.split('\n');
  // A trailing newline yields one empty tail element; keep it out of the scan
  // and re-add it on write so the file's shape is preserved byte-for-byte.
  const hadTrailingNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (hadTrailingNewline) lines.pop();

  const repairedLines = [];
  const seen = [];
  let blocks = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // A torn tail is expected while a run is still appending; a torn line in
      // the middle is corruption we must not compound. Either way: abandon the
      // whole repair rather than rewrite a file we cannot fully read.
      return untouched('unparsable');
    }
    const n = repairRecord(record, seen, mode);
    if (!n) continue;
    blocks += n;
    repairedLines.push(i + 1);
    try {
      lines[i] = JSON.stringify(record);
    } catch {
      return untouched('unserializable');
    }
  }

  if (!repairedLines.length) return untouched('clean');

  const output = lines.join('\n') + (hadTrailingNewline ? '\n' : '');
  const tmp = `${jsonlPath}.nassaj-repair.tmp`;

  // Crossing to Anthropic rewrites tool and thinking blocks into text — the
  // conversation stays readable but the structure is gone, and switching the
  // engine back does NOT restore it. The default mode touches one block shape
  // and is effectively reversible in practice; this one is not, so it keeps a
  // copy first and REFUSES to write when the copy fails (qa-critic مهم 10).
  if (crossEngine) {
    try {
      fs.writeFileSync(`${jsonlPath}.nassaj-precross.bak`, raw, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      return untouched(`backup-failed:${error?.code || 'error'}`);
    }
  }

  try {
    fs.writeFileSync(tmp, output, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, jsonlPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    return untouched(`unwritable:${error?.code || 'error'}`);
  }

  return { repaired: repairedLines.length, blocks, lines: repairedLines, seen };
}

/**
 * Spawn-path entry point: repair the transcript a resume is about to replay.
 *
 * Fail-open by construction — every error is swallowed and reported as a
 * reason, because a broken repair must never be worse than no repair.
 *
 * ⚠️ FAIL-OPEN IS A PROPERTY OF THE CALL SITE, NOT OF THE REPAIR (qa-critic حرج 1).
 * Swallowing errors is right while the repair is a SAFETY NET on a path that
 * would otherwise have run untouched. It is wrong on the ADR-099 crossing path,
 * where the repair is the only thing standing between the user and a permanent
 * 400 — there the caller passes mode='cross-engine' and MUST treat a non-empty
 * `reason` as a failed switch. This function reports; it never decides.
 *
 * @param {'server-tool'|'cross-engine'} [mode]
 * @returns {{repaired: number, blocks: number, lines: number[], reason?: string}}
 */
export function repairResumeTranscript({ sessionId, cwd, configDir, mode = REPAIR_MODE.SERVER_TOOL }) {
  try {
    const jsonlPath = resolveTranscriptPath({ sessionId, cwd, configDir });
    if (!jsonlPath) return { repaired: 0, blocks: 0, lines: [], seen: [], reason: 'unresolved' };
    const result = repairTranscriptFile(jsonlPath, mode);
    if (result.repaired) {
      console.warn(
        `[B-421] repaired ${result.blocks} malformed block(s) in ` +
          `${sessionId} (lines ${result.lines.join(', ')}, mode=${mode}) — a vendor engine ` +
          `wrote ids/blocks the API rejects on every resume`,
      );
    }
    return result;
  } catch (error) {
    return {
      repaired: 0,
      blocks: 0,
      lines: [],
      seen: [],
      reason: `failed:${error?.message || 'error'}`,
    };
  }
}
