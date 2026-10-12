import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sanitizeLeafDirectoryName } from '@/shared/utils.js';

import { AGY_BRAIN_UNDER_HOME } from '../list/antigravity/agy-brain-layout.js';

import type { HeaderScanEnd, HeaderVisit } from './transcript-header-scan.js';
import { vendorProviderRoot } from './vendor/vendor-transcript.js';

/**
 * Per-provider rules of the session transcript reader (ADR-201 A1.3–A1.4):
 * where a provider's trees are, how a recorded path maps to a candidate, and
 * how the candidate's name and header bind it to the session id.
 *
 * Header shapes were taken from observed transcripts on this host (2026-10-12,
 * 185 Claude / 189 Codex / 11 agy / 8 vendor rows, all consistent):
 *   - Claude: the first id-bearing line carries `sessionId` (an `ai-title`,
 *     `queue-operation`, `mode` or `user` record); the file is `<id>.jsonl`.
 *   - Codex: the first line is `{"type":"session_meta","payload":{"id":…}}`
 *     (≤ 23 KiB measured); the file is `rollout-<timestamp>-<id>.jsonl`.
 * Ids are read by a bounded streaming scan of the leading records, not by
 * parsing them (a first record may be megabytes long).
 *   - agy: no id in the transcript; the brain directory is the session id:
 *     `<brain>/<id>/.system_generated/logs/transcript.jsonl`.
 *   - vendor (kimi/deepseek/glm/hermes/qwen): nassaj writes the file, the
 *     header (`{"type":"meta",…}`) carries no id; the file is `<id>.jsonl`.
 *   - native Kimi agent (M4): the CLI writes `<KIMI_CODE_HOME>/sessions/<id>/
 *     agents/<agentId>/wire.jsonl`; its header (`{"type":"metadata",…}`)
 *     carries no id, so the session directory below the root is the id.
 */

/** Leading-record scan of the pinned descriptor (transcript-header-scan.ts). */
export type HeaderScan = (paths: readonly (readonly string[])[], visit: HeaderVisit) => Promise<HeaderScanEnd>;

export type HeaderVerdict = 'name_mismatch' | 'id_mismatch' | 'header_missing' | 'header_oversize' | null;

export type TranscriptSpec = {
  /** Operator/shared roots of this provider (literal spellings). */
  sharedRoots(): Promise<string[]>;
  /** Provider root below a member tree (`<users>/<n>/<underHome>`), or null when members have none. */
  underHome: string | null;
  /** Candidate file for the recorded path (Claude follows legacy spellings). */
  locate(recorded: string): Promise<string | null>;
  /** Binds the pinned file to `sessionId`; null accepts. `root` is the containing root's realpath. */
  verify(sessionId: string, realpath: string, scan: HeaderScan, root: string): Promise<HeaderVerdict>;
};

/**
 * Claude header binding alone: the first record carrying a top-level string
 * `sessionId` must carry this id. Subagent files (`<id>/subagents/…`) carry
 * their parent's id here, so cost readers bind them with it (ADR-201 A-P2c).
 */
export async function verifyClaudeHeader(sessionId: string, scan: HeaderScan): Promise<HeaderVerdict> {
  let verdict: HeaderVerdict = 'header_missing';
  const end = await scan([['sessionId']], (record) => {
    if (record.sessionId === undefined) return 'next';
    verdict = record.sessionId === sessionId ? null : 'id_mismatch';
    return 'stop';
  });
  return end === 'oversize' ? 'header_oversize' : verdict;
}

/** Claude: the file is `<id>.jsonl` and its header carries this id. */
async function verifyClaude(sessionId: string, realpath: string, scan: HeaderScan): Promise<HeaderVerdict> {
  if (path.basename(realpath) !== `${sessionId}.jsonl`) return 'name_mismatch';
  return verifyClaudeHeader(sessionId, scan);
}

/**
 * Codex rollout of ONE thread: named `rollout-…-<threadId>.jsonl`, and its
 * first record is `session_meta` whose `payload.id` is `threadId`. With
 * `rootAlias`, `payload.session_id` (when present) must be `threadId` too —
 * true for a conversation root, false for a linked child (its alias is the
 * root's id, bound by the link manifest).
 */
export async function verifyCodexThread(
  threadId: string, realpath: string, scan: HeaderScan, rootAlias: boolean,
): Promise<HeaderVerdict> {
  const name = path.basename(realpath);
  if (!threadId || !name.startsWith('rollout-') || !name.endsWith(`-${threadId}.jsonl`)) return 'name_mismatch';
  let verdict: HeaderVerdict = 'header_missing';
  const end = await scan([['type'], ['payload', 'id'], ['payload', 'session_id']], (record) => {
    const id = record['payload.id'];
    if (record.type === 'session_meta' && id !== undefined) {
      const alias = rootAlias ? record['payload.session_id'] ?? id : id;
      verdict = id === threadId && alias === threadId ? null : 'id_mismatch';
    }
    return 'stop';
  });
  return end === 'oversize' ? 'header_oversize' : verdict;
}

/** Binds a pinned file to the id it must carry; null accepts. */
export type FileBinder = (realpath: string, scan: HeaderScan) => Promise<HeaderVerdict>;

/** Binder of a Claude file carrying `sessionId`; `named` also requires the name `<sessionId>.jsonl`. */
export function claudeFileBinder(sessionId: string, named: boolean): FileBinder {
  return async (realpath, scan) => (named && path.basename(realpath) !== `${sessionId}.jsonl`
    ? 'name_mismatch'
    : verifyClaudeHeader(sessionId, scan));
}

/** Binder of the Codex rollout of `threadId` (see {@link verifyCodexThread}). */
export function codexThreadBinder(threadId: string, rootAlias: boolean): FileBinder {
  return (realpath, scan) => verifyCodexThread(threadId, realpath, scan, rootAlias);
}

/**
 * Codex: the conversation root rollout of this session id. A transcript the
 * turn supervisor wrote (cli-turn-supervisor, `vendorTranscriptPath('codex',…)`)
 * lies in nassaj's own Codex vendor tree, has no `session_meta` and is bound
 * by its `<id>.jsonl` name exactly like the other vendor transcripts.
 */
async function verifyCodex(sessionId: string, realpath: string, scan: HeaderScan, root: string): Promise<HeaderVerdict> {
  const vendorRoot = await fs.realpath(vendorProviderRoot('codex')).catch(() => null);
  if (vendorRoot !== null && root === vendorRoot) return verifyVendor(sessionId, realpath);
  return verifyCodexThread(sessionId, realpath, scan, true);
}

/** agy: the transcript carries no id; its brain directory (first segment under the root) is the id. */
async function verifyAgy(sessionId: string, realpath: string, _scan: HeaderScan, root: string): Promise<HeaderVerdict> {
  if (path.basename(realpath) !== 'transcript.jsonl') return 'name_mismatch';
  return path.relative(root, realpath).split(path.sep)[0] === sessionId ? null : 'id_mismatch';
}

/** Vendor: nassaj names the file after the sanitized id; its `meta` header carries none. */
async function verifyVendor(sessionId: string, realpath: string): Promise<HeaderVerdict> {
  try {
    return path.basename(realpath) === `${sanitizeLeafDirectoryName(sessionId)}.jsonl` ? null : 'name_mismatch';
  } catch {
    return 'name_mismatch';
  }
}

/** Native Kimi agent transcript name (kimi-agent-session-synchronizer). */
const KIMI_WIRE_FILE = 'wire.jsonl';
/**
 * `<home>/.kimi/sessions`, the Kimi agent CLI's per-home session root. Mirrors
 * KIMI_HOME_SUBDIR (provision-user-dirs.js); adr201-kimi-agent-spec.test.ts
 * pins the two together.
 */
const KIMI_AGENT_UNDER_HOME = path.join('.kimi', 'sessions');

/**
 * Native Kimi agent (M4): exactly `<root>/<id>/agents/<agentId>/wire.jsonl`.
 * Every agent folder of one conversation (main and subagents) is bound by the
 * same session directory.
 */
function verifyKimiAgent(sessionId: string, realpath: string, root: string): HeaderVerdict {
  if (path.basename(realpath) !== KIMI_WIRE_FILE) return 'name_mismatch';
  const [id, agents, agentId, file, ...rest] = path.relative(root, realpath).split(path.sep);
  const exact = rest.length === 0 && agents === 'agents' && Boolean(agentId) && file === KIMI_WIRE_FILE;
  return exact && id === sessionId ? null : 'id_mismatch';
}

/** Kimi: nassaj's vendor tree binds by `<id>.jsonl`; the agent CLI's tree by its session directory. */
async function verifyKimi(sessionId: string, realpath: string, _scan: HeaderScan, root: string): Promise<HeaderVerdict> {
  const vendorRoot = await fs.realpath(vendorProviderRoot('kimi')).catch(() => null);
  if (vendorRoot !== null && root === vendorRoot) return verifyVendor(sessionId, realpath);
  return verifyKimiAgent(sessionId, realpath, root);
}

async function kimiSharedRoots(): Promise<string[]> {
  const operator = path.join(os.homedir(), KIMI_AGENT_UNDER_HOME);
  const configured = process.env.KIMI_CODE_HOME?.trim();
  return [vendorProviderRoot('kimi'), operator, ...(configured ? [path.join(configured, 'sessions')] : [])];
}

const identity = async (recorded: string): Promise<string> => recorded;

/**
 * Claude's home/legacy-spelling helpers pull in the provider-env and user
 * stores; they are loaded on first use so a reader of another provider (and
 * its tests' database mocks) never evaluates them.
 */
const claudeRoots = () => import('../list/claude/claude-projects-roots.js');
const claudeHome = () => import('../list/claude/claude-home.js');

async function claudeSharedRoots(): Promise<string[]> {
  const [{ operatorClaudeHome }, { legacyOperatorProjectsSpellings }] = await Promise.all([claudeHome(), claudeRoots()]);
  const homes = [operatorClaudeHome(), process.env.CLAUDE_CONFIG_DIR?.trim() || operatorClaudeHome()];
  return [...homes.map((home) => path.join(home, 'projects')), ...legacyOperatorProjectsSpellings()];
}

async function locateClaude(recorded: string): Promise<string | null> {
  return (await claudeRoots()).resolveStoredClaudeTranscript(recorded);
}

async function codexSharedRoots(): Promise<string[]> {
  const operator = path.join(os.homedir(), '.codex');
  const homes = [operator, process.env.CODEX_HOME?.trim() || operator];
  return [...homes.map((home) => path.join(home, 'sessions')), vendorProviderRoot('codex')];
}

type VendorProvider = 'kimi' | 'deepseek' | 'glm' | 'hermes' | 'qwen';
const VENDOR_PROVIDERS: ReadonlySet<string> = new Set<VendorProvider>(['kimi', 'deepseek', 'glm', 'hermes', 'qwen']);

function vendorSpec(provider: Exclude<VendorProvider, 'kimi'>): TranscriptSpec {
  return { sharedRoots: async () => [vendorProviderRoot(provider)], underHome: null, locate: identity, verify: verifyVendor };
}

const SPECS: Readonly<Record<string, TranscriptSpec>> = Object.freeze({
  claude: {
    sharedRoots: claudeSharedRoots,
    underHome: path.join('.claude', 'projects'),
    locate: locateClaude,
    verify: verifyClaude,
  },
  codex: { sharedRoots: codexSharedRoots, underHome: path.join('.codex', 'sessions'), locate: identity, verify: verifyCodex },
  antigravity: {
    sharedRoots: async () => [path.join(os.homedir(), AGY_BRAIN_UNDER_HOME)],
    underHome: AGY_BRAIN_UNDER_HOME,
    locate: identity,
    verify: verifyAgy,
  },
  kimi: { sharedRoots: kimiSharedRoots, underHome: KIMI_AGENT_UNDER_HOME, locate: identity, verify: verifyKimi },
  deepseek: vendorSpec('deepseek'),
  glm: vendorSpec('glm'),
  hermes: vendorSpec('hermes'),
  qwen: vendorSpec('qwen'),
});

/** Transcript rules of `provider`, or null when its history is not a recorded file (cursor, opencode). */
export function transcriptSpecOf(provider: string): TranscriptSpec | null {
  return Object.hasOwn(SPECS, provider) ? SPECS[provider] : null;
}

/**
 * True for providers whose transcript nassaj itself writes in its vendor tree
 * (a row with no recorded path keeps the legacy vendor lookup). Kimi is one,
 * although its spec also covers the native agent CLI's tree (M4).
 */
export function isVendorTranscriptProvider(provider: string): boolean {
  return VENDOR_PROVIDERS.has(provider);
}
