/**
 * coordinator-marker-lock.js — T-938 (ADR-064 baseline, path ④).
 *
 * Layer ④ on top of the neutral ground-truth injection (① — coordinator-ground-
 * truth.js). ① injects FACTS; it does not by itself catch a replay whose prompt
 * was RE-PHRASED. The replay failure is reasoning, not information: the coordinator
 * may see a matching commit in ①'s snapshot yet fail to connect it to its current
 * delegation because each duplicate copy was worded differently (pending-command
 * vs system.js vs server-actions — all the SAME T-935, incident replay-duplicate-
 * self-execution). ④ catches that by a PHRASING-RESISTANT delegation key persisted
 * across delegations, and — when the same key re-appears AND commits have landed
 * since it was last dispatched — injects a NEUTRAL warning alongside ①'s facts.
 *
 * KEY DESIGN (why it survives re-wording):
 *  - STRONG KEY: an explicit task ref (T-\d+ / B-\d+) extracted from the prompt or
 *    description. Two delegations of the same task match on the ref regardless of
 *    how the surrounding sentence is phrased. Two delegations that BOTH carry a ref
 *    but DIFFERENT refs are genuinely different work ⇒ never matched.
 *  - FALLBACK FINGERPRINT: when no ref is present, a normalized bag of the ~8 most
 *    salient content words (lowercased, stop-words / generic delegation verbs
 *    stripped, order-independent). Matched by Jaccard overlap over a threshold, so
 *    swapping the implementation label but keeping the SUBJECT (restart / button /
 *    session) still matches.
 *
 * SOAK STAGE = WARN ONLY, NEVER BLOCK. We are collecting evidence (does it catch
 * real replays without false positives?). Promotion to a hard block (fail-closed +
 * an override token) is intentionally a SMALL change — see PROMOTION-TO-BLOCK note
 * at the bottom.
 *
 * FAIL-SAFE ABSOLUTE (this touches the coordinator's delegation hook — a defect
 * here must never break a delegation): every function is guarded so it can NEVER
 * throw and NEVER block. Any failure (git missing, marker file corrupt / unwritable,
 * normalization edge case) ⇒ no warning, the marker step is skipped, and the
 * delegation proceeds unchanged. The commit-advanced check is REQUIRED for a warning,
 * so if git is unavailable (currentCommit null) we stay silent by construction.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const MARKER_FILE = 'coordinator-markers.json';
const MAX_MARKERS = 200;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
// Fallback-fingerprint match threshold. Calibrated against the real incident: two
// same-subject delegations re-worded with different implementation labels (pending-
// command vs server-actions) plus a swapped verb overlap at ~0.45 on content words,
// while genuinely different work overlaps near 0 — a wide margin. 0.4 catches the
// former without the latter. WARN-ONLY soak keeps a rare false positive cheap (a
// `git show` confirms), and the strong taskRef path handles the common case exactly.
const JACCARD_THRESHOLD = 0.4;
const MAX_KEYWORDS = 8;
const SNIPPET_LEN = 120;
const GIT_TIMEOUT_MS = 3000;
const GIT_LOG_N = 30;

// Generic delegation verbs / structural words carry no subject signal; stripping
// them focuses the fingerprint on the WHAT (nouns) so re-wording the HOW still
// matches. Latin + Arabic. Kept small and conservative.
const STOP_WORDS = new Set([
  // latin structural
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'your', 'you',
  'via', 'over', 'onto', 'then', 'when', 'where', 'which', 'while', 'about',
  // latin generic delegation verbs
  'build', 'work', 'make', 'implement', 'create', 'add', 'fix', 'task', 'please',
  'using', 'use', 'update', 'change', 'handle',
  // arabic structural
  'من', 'في', 'على', 'إلى', 'عن', 'أن', 'إن', 'هذا', 'هذه', 'التي', 'الذي',
  'مع', 'أو', 'ثم', 'قبل', 'بعد', 'كل', 'لا', 'ما', 'عند', 'كما', 'حتى',
  // arabic generic delegation verbs / nouns
  'نفّذ', 'نفذ', 'ابنِ', 'ابن', 'أضف', 'اضف', 'أصلح', 'اصلح', 'مهمة', 'عبر',
  'خلال', 'اعمل', 'اعملي', 'قم', 'نريد', 'يجب',
]);

/**
 * Resolves the persistent marker-file path next to the live sqlite db — the same
 * out-of-git data dir the pending-restart marker uses (dirname(DATABASE_PATH) when
 * set, else the well-known nassaj-dev data dir). Never throws.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveMarkerPath(env = process.env) {
  try {
    const dbPath = env?.DATABASE_PATH;
    const dataDir =
      typeof dbPath === 'string' && dbPath.trim()
        ? path.dirname(dbPath.trim())
        : path.join(os.homedir(), '.local', 'share', 'nassaj-dev');
    return path.join(dataDir, MARKER_FILE);
  } catch {
    // Last-resort fallback; still a valid path so writes/reads simply target tmp.
    return path.join(os.tmpdir(), MARKER_FILE);
  }
}

/**
 * Extracts the FIRST task/bug ref (T-123 / B-45) from arbitrary text, uppercased.
 * Returns null when none. Never throws.
 * @param {unknown} text
 * @returns {string|null}
 */
export function extractTaskRef(text) {
  try {
    if (typeof text !== 'string' || text.length === 0) return null;
    const m = text.match(/\b([TB])-(\d{1,6})\b/i);
    if (!m) return null;
    return `${m[1].toUpperCase()}-${m[2]}`;
  } catch {
    return null;
  }
}

/**
 * Builds the phrasing-resistant content fingerprint: lowercase, drop punctuation,
 * drop tokens < 4 chars, drop stop-words / generic verbs, de-dupe, then keep the
 * MAX_KEYWORDS most frequent (ties broken alphabetically) and return them SORTED so
 * the set is order-independent. Never throws; returns [].
 * @param {unknown} text
 * @returns {string[]}
 */
export function fingerprintKeywords(text) {
  try {
    if (typeof text !== 'string' || text.length === 0) return [];
    const tokens = text
      .toLowerCase()
      .split(/[^0-9a-z؀-ۿ]+/i)
      .filter((w) => w && w.length >= 4 && !STOP_WORDS.has(w));
    if (tokens.length === 0) return [];
    const freq = new Map();
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);
    return Array.from(freq.entries())
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAX_KEYWORDS)
      .map((e) => e[0])
      .sort();
  } catch {
    return [];
  }
}

/**
 * Computes the delegation key object from a prompt (+ optional description).
 *  - taskRef: strong key (or null)
 *  - keywords: fallback fingerprint (always computed, used when refs are absent)
 *  - key: a stable exact-key string for in-place marker de-dup ('task:T-9' | 'kw:a,b')
 *  - snippet: a short human-readable excerpt for the warning
 * Never throws.
 * @param {unknown} prompt
 * @param {unknown} [description]
 * @returns {{taskRef:(string|null), keywords:string[], key:string, snippet:string}}
 */
export function computeDelegationKey(prompt, description) {
  try {
    const promptStr = typeof prompt === 'string' ? prompt : '';
    const descStr = typeof description === 'string' ? description : '';
    const combined = `${descStr} ${promptStr}`.trim();
    const taskRef = extractTaskRef(combined);
    const keywords = fingerprintKeywords(combined);
    const key = taskRef ? `task:${taskRef}` : `kw:${keywords.join(',')}`;
    const snippet = combined.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN);
    return { taskRef, keywords, key, snippet };
  } catch {
    return { taskRef: null, keywords: [], key: 'kw:', snippet: '' };
  }
}

/**
 * Jaccard overlap of two keyword sets (|∩| / |∪|). 0 when either is empty. Safe.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
  try {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
    const sa = new Set(a);
    const sb = new Set(b);
    let inter = 0;
    for (const x of sa) if (sb.has(x)) inter += 1;
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
  } catch {
    return 0;
  }
}

/**
 * Decides whether a current delegation key matches a stored marker (the same work):
 *  - both carry a taskRef ⇒ match IFF the refs are equal (different refs ⇒ NEVER
 *    a match, even with heavy keyword overlap — genuinely different tasks);
 *  - otherwise (at least one lacks a ref) ⇒ match IFF Jaccard(keywords) ≥ threshold.
 * Never throws.
 * @param {{taskRef:(string|null), keywords:string[]}} current
 * @param {{taskRef:(string|null), keywords:string[]}} marker
 * @returns {boolean}
 */
export function keysMatch(current, marker) {
  try {
    if (!current || !marker) return false;
    const cRef = current.taskRef || null;
    const mRef = marker.taskRef || null;
    if (cRef && mRef) return cRef === mRef;
    return jaccard(current.keywords || [], marker.keywords || []) >= JACCARD_THRESHOLD;
  } catch {
    return false;
  }
}

/**
 * `git log --format=%h` short hashes (newest first). Async, timeout-bounded, safe.
 * currentCommit is list[0]. Returns [] on any failure.
 * @param {string} repoRoot
 * @returns {Promise<string[]>}
 */
export function readCommitLog(repoRoot) {
  return new Promise((resolve) => {
    try {
      if (typeof repoRoot !== 'string' || !repoRoot.trim()) {
        resolve([]);
        return;
      }
      execFile(
        'git',
        ['-C', repoRoot, 'log', '--format=%h', '-n', String(GIT_LOG_N)],
        { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err || typeof stdout !== 'string') {
            resolve([]);
            return;
          }
          resolve(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
        },
      );
    } catch {
      resolve([]);
    }
  });
}

/**
 * Counts commits that landed AFTER a marker's dispatch commit, using the current
 * short-hash log. Everything newer than sinceHash (i.e. before it in the list) is
 * "landed". If sinceHash isn't in the window (fell off), returns count -1 as an
 * "unknown but ≥1" sentinel. Safe.
 * @param {string[]} commitLog newest-first short hashes
 * @param {string|null} sinceHash
 * @returns {{count:number, hashes:string[]}}
 */
export function countLanded(commitLog, sinceHash) {
  try {
    if (!Array.isArray(commitLog) || commitLog.length === 0 || !sinceHash) {
      return { count: 0, hashes: [] };
    }
    const idx = commitLog.indexOf(sinceHash);
    if (idx < 0) return { count: -1, hashes: [] }; // fell off the window: unknown ≥1
    return { count: idx, hashes: commitLog.slice(0, idx) };
  } catch {
    return { count: 0, hashes: [] };
  }
}

/** Human-readable "قبل X" for a past timestamp. Safe, coarse (min/hour/day). */
function humanAgo(ts, now) {
  try {
    const ms = Math.max(0, now - ts);
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'أقل من دقيقة';
    if (mins < 60) return `${mins} دقيقة`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} ساعة`;
    const days = Math.floor(hours / 24);
    return `${days} يوم`;
  } catch {
    return 'مدة وجيزة';
  }
}

/**
 * Renders the neutral duplicate-delegation warning (facts, not commands). Returns
 * null if there is nothing meaningful to say. Never throws.
 * @param {object} args
 * @param {{taskRef:(string|null), keywords:string[], snippet:string, ts:number}} args.marker
 * @param {number} args.now
 * @param {{count:number, hashes:string[]}} args.landed
 * @returns {string|null}
 */
export function renderDuplicateWarning({ marker, now, landed } = {}) {
  try {
    if (!marker) return null;
    const keyLabel = marker.taskRef
      ? marker.taskRef
      : (Array.isArray(marker.keywords) && marker.keywords.length > 0
        ? marker.keywords.join('، ')
        : 'بصمة محتوى');
    const ago = humanAgo(typeof marker.ts === 'number' ? marker.ts : now, now);
    const snippet = (marker.snippet || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN);
    const count = landed && typeof landed.count === 'number' ? landed.count : 0;
    const hashes = landed && Array.isArray(landed.hashes) ? landed.hashes : [];
    const nText = count < 0 ? 'commit واحد أو أكثر' : `${count} commit`;
    const hashText = hashes.length > 0 ? ` (${hashes.join('، ')})` : '';
    return (
      `⚠️ تفويض مشابه سُجّل قبل ${ago} (المفتاح: ${keyLabel}`
      + (snippet ? `، المقتطف: «${snippet}»` : '')
      + `)، وهبطت بعده ${nText}${hashText}. في هذا المشروع، هذا النمط غالباً `
      + 'تكرار ذاتي بالـreplay لا جلسة موازية — تحقّق بـ`git show`/`git log` قبل المضي.'
    );
  } catch {
    return null;
  }
}

/**
 * Reads the persisted markers array. Corrupt / missing / non-array ⇒ []. Safe.
 * @param {string} markerPath
 * @returns {Promise<Array<object>>}
 */
export async function readMarkers(markerPath) {
  try {
    const raw = await fs.readFile(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((m) => m && typeof m === 'object');
  } catch {
    return [];
  }
}

/**
 * Bounds the marker set: drop entries older than MAX_AGE_MS, keep the most recent
 * MAX_MARKERS. Pure, safe.
 * @param {Array<object>} markers
 * @param {number} now
 * @returns {Array<object>}
 */
export function rotateMarkers(markers, now) {
  try {
    if (!Array.isArray(markers)) return [];
    const fresh = markers.filter(
      (m) => m && typeof m.ts === 'number' && (now - m.ts) < MAX_AGE_MS,
    );
    // Keep newest by ts; if more than the cap, retain the most recent MAX_MARKERS.
    fresh.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return fresh.slice(-MAX_MARKERS);
  } catch {
    return Array.isArray(markers) ? markers.slice(-MAX_MARKERS) : [];
  }
}

/**
 * Persists markers atomically-ish (tmp write + rename). Returns true on success,
 * false on any failure — a failed write must never surface. Safe.
 * @param {string} markerPath
 * @param {Array<object>} markers
 * @returns {Promise<boolean>}
 */
export async function writeMarkers(markerPath, markers) {
  try {
    const dir = path.dirname(markerPath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${markerPath}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(markers), 'utf8');
    await fs.rename(tmp, markerPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Core ④ evaluation. Given the current delegation, detects a phrasing-resistant
 * duplicate against prior markers, records/updates the current marker, and returns
 * a neutral WARNING string (or null). WARN-ONLY: it never blocks. Absolutely
 * fail-safe: on ANY failure returns { warning: null } and leaves the delegation
 * untouched.
 *
 * A warning is emitted ONLY when a matching prior marker exists AND the current
 * HEAD commit differs from that marker's dispatch commit (i.e. commits landed
 * since) — proving intervening work, the replay signature.
 *
 * @param {object} args
 * @param {unknown} [args.delegationPrompt]
 * @param {unknown} [args.description]
 * @param {string} [args.repoRoot]
 * @param {string} [args.markerPath]     override (tests); default resolveMarkerPath()
 * @param {number} [args.now]            override (tests); default Date.now()
 * @param {string[]} [args.commitLog]    override (tests) to skip git; else read live
 * @returns {Promise<{warning: (string|null)}>}
 */
export async function evaluateMarkerLock({
  delegationPrompt,
  description,
  repoRoot,
  markerPath,
  now = Date.now(),
  commitLog,
} = {}) {
  try {
    const mPath = typeof markerPath === 'string' && markerPath.trim()
      ? markerPath.trim()
      : resolveMarkerPath();

    const current = computeDelegationKey(delegationPrompt, description);

    // Current commit state. A warning REQUIRES a known current commit, so if git is
    // unavailable this stays silent by construction (fail-safe).
    const log = Array.isArray(commitLog) ? commitLog : await readCommitLog(repoRoot);
    const currentCommit = log.length > 0 ? log[0] : null;

    const priorMarkers = await readMarkers(mPath);

    // Detect a duplicate against PRIOR markers (most recent first) whose dispatch
    // commit differs from the current HEAD.
    let warning = null;
    if (currentCommit) {
      const sorted = priorMarkers
        .slice()
        .sort((a, b) => (b.ts || 0) - (a.ts || 0));
      for (const marker of sorted) {
        if (!keysMatch(current, marker)) continue;
        const since = typeof marker.lastCommitAtDispatch === 'string'
          ? marker.lastCommitAtDispatch
          : null;
        if (!since || since === currentCommit) continue; // no commit advanced ⇒ no replay signal
        const landed = countLanded(log, since);
        warning = renderDuplicateWarning({ marker, now, landed });
        break;
      }
    }

    // Record / update the current marker (exact-key in-place update), then rotate
    // and persist. All best-effort — a write failure never affects the delegation.
    try {
      const withoutSameKey = priorMarkers.filter((m) => m && m.key !== current.key);
      withoutSameKey.push({
        key: current.key,
        taskRef: current.taskRef,
        keywords: current.keywords,
        promptSnippet: current.snippet,
        ts: now,
        lastCommitAtDispatch: currentCommit,
      });
      const rotated = rotateMarkers(withoutSameKey, now);
      await writeMarkers(mPath, rotated);
    } catch {
      // ignore — recording is best-effort.
    }

    return { warning: typeof warning === 'string' && warning.length > 0 ? warning : null };
  } catch {
    // Absolute fail-safe: never let ④ break a delegation.
    return { warning: null };
  }
}

/*
 * ── PROMOTION-TO-BLOCK (deferred; soak stage is WARN-ONLY) ───────────────────
 * To turn ④ into a hard guard later, the change is intentionally small and local:
 *   1. In the PreToolUse hook (server/claude-sdk.js), when evaluateMarkerLock
 *      returns a warning AND a new opt-in flag is set (e.g. NASSAJ_MARKER_LOCK==='block'),
 *      return a DENY:
 *        { hookSpecificOutput: { hookEventName: 'PreToolUse',
 *            permissionDecision: 'deny', permissionDecisionReason: warning } }
 *      instead of merging the warning into additionalContext.
 *   2. Add an OVERRIDE TOKEN escape hatch: if the delegation prompt contains an
 *      explicit override marker (e.g. "[replay-ok]"), computeDelegationKey/eval
 *      skips the block (records but does not deny) so a legitimate re-run is possible.
 *   3. Keep fail-closed semantics ONLY for the block path (deny) — the detection
 *      itself stays fail-safe: any internal error ⇒ no deny.
 * The detection, key design, marker store, and rotation here need NO change.
 */

export const __test__ = {
  MARKER_FILE,
  MAX_MARKERS,
  MAX_AGE_MS,
  JACCARD_THRESHOLD,
  MAX_KEYWORDS,
  STOP_WORDS,
  humanAgo,
};
