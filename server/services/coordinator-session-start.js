/**
 * coordinator-session-start.js — T-939 (ADR-064 baseline, path ②).
 *
 * Complements path ① (coordinator-ground-truth.js). Path ① injects neutral
 * disk-derived facts at DELEGATION time (PreToolUse on Agent/Task). But a
 * compaction that never routes through a delegation would still wipe the "what I
 * already did" state and let the coordinator replay finished work. This module
 * closes that door: a SessionStart hook injects the same neutral ground-truth as
 * `additionalContext` at the exact moment the session (re)hydrates its context —
 * SDK SessionStart `source` ∈ {startup, resume, clear, compact}.
 *
 * WHY NOT PreCompact: PreCompact is a no-op for injection — it cannot add text to
 * the retained summary. SessionStart is the confirmed channel that supports
 * `additionalContext` and fires on `source: 'compact'` right after compaction.
 *
 * REUSE: this composes the ground-truth module's LOAD-BEARING fail-safe readers
 * (`readRecentCommits` + `readOpenTasks`) rather than its top-level
 * `buildGroundTruthContext`, because that function's rendered block carries a
 * DELEGATION-specific closing note ("if your delegation prompt matches …") that is
 * meaningless at session start (there is no delegation here). The valuable,
 * hard-to-get-right part — the timeout-bounded git read and the corrupt-JSON-proof
 * state read — is shared verbatim; only the neutral frame differs.
 *
 * DESIGN CONSTRAINTS (identical to path ①, all load-bearing):
 *  - FAIL-SAFE ABSOLUTE: every entry point is wrapped so it can NEVER throw and
 *    NEVER block. Any failure ⇒ return null ⇒ the caller injects nothing ⇒ the
 *    session starts/resumes unchanged. This code must not be able to break a
 *    session hydration.
 *  - NEUTRAL FACTS, NOT COMMANDS: states facts + an environmental note; issues no
 *    order (the model rejects imperative hook-channel text as prompt-injection).
 *  - TOKEN-BOUNDED: inherits the readers' caps (12 commits / 8 tasks) plus a hard
 *    total-line cap here.
 */

import path from 'path';
import { readRecentCommits, readOpenTasks } from './coordinator-ground-truth.js';

/** Mirrors coordinator-ground-truth: configuration, never a hardcoded machine path. */
const DEFAULT_REPO_ROOT = process.env.NASSAJ_COORDINATOR_REPO_ROOT || process.cwd();
const MAX_TOTAL_LINES = 40;

/**
 * Sources for which a ground-truth snapshot is worth injecting. 'compact' and
 * 'resume' are the context-loss moments this layer exists for. 'startup' is
 * included with a LIGHTER frame (a clean fresh start rarely needs the anti-replay
 * note, but a live status snapshot is still harmless and mildly useful). 'clear'
 * is EXCLUDED: it is a deliberate user reset, and injecting state would fight that
 * intent.
 */
const RELEVANT_SOURCES = new Set(['compact', 'resume', 'startup']);

/**
 * @param {unknown} source
 * @returns {boolean}
 */
export function isRelevantSource(source) {
  try {
    return typeof source === 'string' && RELEVANT_SOURCES.has(source);
  } catch {
    return false;
  }
}

/**
 * Builds the neutral SessionStart injection string, or null when there is nothing
 * to inject / the source is not relevant / on ANY failure. Caller treats null as
 * "inject nothing".
 *
 * @param {object} args
 * @param {unknown} [args.source] SDK SessionStart `source`.
 * @param {string} [args.repoRoot]
 * @param {string} [args.projectStatePath]
 * @returns {Promise<string|null>}
 */
export async function buildSessionStartContext({
  source,
  repoRoot = DEFAULT_REPO_ROOT,
  projectStatePath,
} = {}) {
  try {
    if (!isRelevantSource(source)) return null;

    const root =
      typeof repoRoot === 'string' && repoRoot.trim() ? repoRoot.trim() : DEFAULT_REPO_ROOT;
    const statePath =
      typeof projectStatePath === 'string' && projectStatePath.trim()
        ? projectStatePath.trim()
        : path.join(root, 'docs', 'project-state.json');

    // No delegation prompt at session start ⇒ no keywords ⇒ readOpenTasks falls
    // back to in_progress-only (the highest-signal set), which is exactly what a
    // "what am I mid-way through" snapshot should show.
    const [commits, tasks] = await Promise.all([
      readRecentCommits(root),
      readOpenTasks(statePath, []),
    ]);

    if (commits.length === 0 && tasks.length === 0) return null;

    return renderSessionStartContext(commits, tasks, source);
  } catch {
    return null;
  }
}

/**
 * Pure renderer: commits + in_progress tasks + a source-framed neutral note,
 * hard-capped at MAX_TOTAL_LINES. No I/O. Never throws.
 *
 * @param {string[]} commits
 * @param {Array<{id:string,status:string,title:string}>} tasks
 * @param {string} [source]
 * @returns {string|null}
 */
export function renderSessionStartContext(commits = [], tasks = [], source = 'resume') {
  try {
    const lines = [];

    // Source-appropriate opening frame. compact/resume are context-loss moments →
    // the strong "not from your compacted memory" framing. startup → a lighter
    // "current state" framing (no context was lost on a clean start).
    if (source === 'startup') {
      lines.push('لقطة حيّة من القرص عند بدء هذه الجلسة (الحالة الراهنة للعمل، مصدرها الملفات الآن):');
    } else {
      lines.push(
        'عند استئناف/إعادة تهيئة هذه الجلسة — لقطة حيّة من القرص لما هو منجَز/جارٍ الآن '
          + '(مصدرها الملفات الآن، لا ذاكرتك المضغوطة):',
      );
    }

    if (Array.isArray(commits) && commits.length > 0) {
      lines.push('');
      lines.push('آخر commits على الفرع:');
      for (const c of commits) lines.push(`- ${c}`);
    }

    if (Array.isArray(tasks) && tasks.length > 0) {
      lines.push('');
      lines.push('مهام قيد التنفيذ (in_progress) الآن:');
      for (const t of tasks) {
        const title = (t.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        lines.push(`- ${t.id || '?'} [${t.status || '?'}]: ${title}`);
      }
    }

    lines.push('');
    if (source === 'startup') {
      lines.push(
        'ملاحظة بيئية (حقيقة عن هذه البيئة، لا تعليمات): القائمة أعلاه هي المرجع الحيّ '
          + 'لما هو منجَز/جارٍ على القرص في هذه اللحظة.',
      );
    } else {
      lines.push(
        'ملاحظة بيئية (حقيقة عن هذه البيئة، لا تعليمات): في هذا المشروع قد يجعلك '
          + 'الاستئناف أو ضغط السياق لا تتذكّر عملاً أنجزتَه في هذه الجلسة نفسها. '
          + 'القائمة أعلاه هي المرجع الحيّ لما هو منجَز/جارٍ على القرص، وإن بدا عملٌ '
          + 'تنوي تفويضه مطابقاً لـcommit حديث أو مهمة قيد التنفيذ أعلاه، فالأرجح أنه '
          + 'تكرار ذاتي لعمل مُنجَز لا بداية جديدة.',
      );
    }

    const capped = lines.slice(0, MAX_TOTAL_LINES);
    const text = capped.join('\n').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export const __test__ = {
  DEFAULT_REPO_ROOT,
  MAX_TOTAL_LINES,
  RELEVANT_SOURCES,
};
