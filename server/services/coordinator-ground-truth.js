/**
 * coordinator-ground-truth.js — T-937 (ADR-064 baseline, path ①).
 *
 * Builds a NEUTRAL, FACTUAL disk-derived context snapshot that a PreToolUse hook
 * injects into the nassaj COORDINATOR session at the moment it delegates via the
 * Agent/Task tool. Purpose: counter the coordinator's replay-driven self-execution
 * (interruption / resume / compaction erase the "what I already did" state, so it
 * re-delegates work it just finished — incidents B-178/T-936/T-937).
 *
 * DESIGN CONSTRAINTS (all load-bearing):
 *  - FAIL-SAFE ABSOLUTE: every entry point is wrapped so it can NEVER throw and
 *    NEVER block. Any failure (git missing, JSON corrupt, timeout, anything) ⇒
 *    return null / [] ⇒ the caller injects nothing ⇒ the delegation proceeds
 *    unchanged. This code must not be able to break a session or a delegation.
 *  - NEUTRAL FACTS, NOT COMMANDS: the model rejects imperative instructions
 *    arriving over the hook channel as prompt-injection. The text states facts and
 *    an environmental note; it issues no order.
 *  - TOKEN-BOUNDED: hard caps on commits, tasks, and total lines.
 *  - NON-BLOCKING: git runs via async execFile with a short timeout, never
 *    execSync — the shared multi-user server event loop must not stall.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * Repository this layer reads ground truth from when a caller passes no explicit
 * root. Deployment-specific, so it is CONFIGURATION (NASSAJ_COORDINATOR_REPO_ROOT)
 * with the server's own working directory as the neutral fallback — never a
 * hardcoded absolute path, which only ever resolves on one machine.
 */
const DEFAULT_REPO_ROOT = process.env.NASSAJ_COORDINATOR_REPO_ROOT || process.cwd();
const MAX_COMMITS = 12;
const MAX_TASKS = 8;
const MAX_TOTAL_LINES = 40;
const GIT_TIMEOUT_MS = 3000;
const RELEVANT_STATUSES = new Set(['in_progress', 'todo']);

/**
 * Instance-level opt-in. The PreToolUse hook closures run in the single nassaj-dev
 * server process (all interactive sessions share it), so no per-spawn sdkOptions.env
 * value can reach the hook — the discriminator is necessarily process/instance-level.
 * The operator sets NASSAJ_COORDINATOR=1 ONLY on the instance dedicated to the
 * coordinator (matching the documented "run the coordinator on a separate instance"
 * model). Default OFF ⇒ unset on every other fleet node ⇒ the hook is an instant
 * no-op there (zero behaviour change).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isCoordinatorInjectionEnabled(env = process.env) {
  try {
    return env?.NASSAJ_COORDINATOR === '1';
  } catch {
    return false;
  }
}

/**
 * Extracts lowercase keywords (≥4 chars, latin or arabic) from a delegation prompt
 * for coarse relevance filtering of open tasks. Never throws.
 * @param {unknown} prompt
 * @returns {string[]}
 */
export function extractKeywords(prompt) {
  try {
    if (typeof prompt !== 'string' || prompt.length === 0) return [];
    const tokens = prompt
      .toLowerCase()
      .split(/[^0-9a-z؀-ۿ-]+/i)
      .filter((w) => w && w.length >= 4);
    // De-dupe, cap to a sane number of probe terms.
    return Array.from(new Set(tokens)).slice(0, 40);
  } catch {
    return [];
  }
}

/**
 * `git log --oneline -N` for the repo. Async, timeout-bounded, fail-safe.
 * @param {string} repoRoot
 * @returns {Promise<string[]>} commit subject lines, or [] on any failure.
 */
export function readRecentCommits(repoRoot) {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', repoRoot, 'log', '--oneline', '-n', String(MAX_COMMITS)],
        { timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err || typeof stdout !== 'string') {
            resolve([]);
            return;
          }
          resolve(
            stdout
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(0, MAX_COMMITS),
          );
        },
      );
    } catch {
      resolve([]);
    }
  });
}

/**
 * Reads open (in_progress/todo) tasks from project-state.json, preferring those
 * matching a delegation keyword when any match. Async, fail-safe.
 * @param {string} projectStatePath
 * @param {string[]} keywords
 * @returns {Promise<Array<{id:string,status:string,title:string}>>}
 */
export async function readOpenTasks(projectStatePath, keywords = []) {
  try {
    const raw = await fs.readFile(projectStatePath, 'utf8');
    const state = JSON.parse(raw);
    const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
    const open = tasks
      .filter((t) => t && typeof t === 'object' && RELEVANT_STATUSES.has(t.status))
      .map((t) => ({
        id: typeof t.id === 'string' ? t.id : '',
        status: typeof t.status === 'string' ? t.status : '',
        title: typeof t.title === 'string' ? t.title : '',
      }));

    if (Array.isArray(keywords) && keywords.length > 0) {
      const matched = open.filter((t) => {
        const hay = `${t.id} ${t.title}`.toLowerCase();
        return keywords.some((k) => hay.includes(k));
      });
      if (matched.length > 0) return matched.slice(0, MAX_TASKS);
    }
    // No keywords, or none matched: fall back to in_progress only (highest signal).
    const inProgress = open.filter((t) => t.status === 'in_progress');
    return inProgress.slice(0, MAX_TASKS);
  } catch {
    return [];
  }
}

/**
 * Builds the full neutral-fact injection string for a coordinator delegation.
 * Returns null when there is nothing useful to inject or on ANY failure — the
 * caller treats null as "inject nothing".
 *
 * @param {object} args
 * @param {unknown} [args.delegationPrompt] tool_input.prompt of the Agent/Task call.
 * @param {string} [args.repoRoot]
 * @param {string} [args.projectStatePath]
 * @returns {Promise<string|null>}
 */
export async function buildGroundTruthContext({
  delegationPrompt,
  repoRoot = DEFAULT_REPO_ROOT,
  projectStatePath,
} = {}) {
  try {
    const root = typeof repoRoot === 'string' && repoRoot.trim() ? repoRoot.trim() : DEFAULT_REPO_ROOT;
    const statePath =
      typeof projectStatePath === 'string' && projectStatePath.trim()
        ? projectStatePath.trim()
        : path.join(root, 'docs', 'project-state.json');
    const keywords = extractKeywords(delegationPrompt);

    const [commits, tasks] = await Promise.all([
      readRecentCommits(root),
      readOpenTasks(statePath, keywords),
    ]);

    // Nothing on disk to report ⇒ inject nothing (keeps token cost at zero when
    // the snapshot would be empty).
    if (commits.length === 0 && tasks.length === 0) return null;

    return renderGroundTruthContext(commits, tasks);
  } catch {
    return null;
  }
}

/**
 * Pure renderer: turns commits + tasks into the neutral-fact block, hard-capped at
 * MAX_TOTAL_LINES. No I/O. Never throws.
 * @param {string[]} commits
 * @param {Array<{id:string,status:string,title:string}>} tasks
 * @returns {string|null}
 */
export function renderGroundTruthContext(commits = [], tasks = []) {
  try {
    const lines = [];
    lines.push('سياق حيّ من القرص (مصدره الملفات الآن، لا ذاكرتك المضغوطة):');

    if (Array.isArray(commits) && commits.length > 0) {
      lines.push('');
      lines.push('آخر commits على الفرع:');
      for (const c of commits) lines.push(`- ${c}`);
    }

    if (Array.isArray(tasks) && tasks.length > 0) {
      lines.push('');
      lines.push('مهام مفتوحة (in_progress/todo) ذات صلة بنص تفويضك:');
      for (const t of tasks) {
        const title = (t.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        lines.push(`- ${t.id || '?'} [${t.status || '?'}]: ${title}`);
      }
    }

    lines.push('');
    lines.push(
      'ملاحظة بيئية (حقيقة عن هذه البيئة، لا تعليمات): في هذا المشروع قد يجعلك '
        + 'التقطّع أو الاستئناف أو ضغط السياق لا تتذكّر عملاً أنجزتَه في هذه الجلسة '
        + 'نفسها. إن طابق نصُّ تفويضك commit حديثاً أعلاه أو مهمة قيد التنفيذ، '
        + 'فالاحتمال الأرجح أنه تكرار ذاتي لعمل مُنجَز لا جلسة موازية.',
    );

    const capped = lines.slice(0, MAX_TOTAL_LINES);
    const text = capped.join('\n').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export const __test__ = {
  DEFAULT_REPO_ROOT,
  MAX_COMMITS,
  MAX_TASKS,
  MAX_TOTAL_LINES,
  RELEVANT_STATUSES,
};
