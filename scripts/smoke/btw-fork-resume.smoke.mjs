/**
 * btw-fork-resume.smoke.mjs — T-1090 CLI-upgrade regression guard for the /btw fork.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * Forking a `/btw` exchange into a real conversation works by REWRITING a Claude
 * transcript on disk (server/modules/providers/list/claude/claude-transcript-fork.ts):
 * new uuids, new sessionId, re-linked parents, and the question + answer appended
 * as a user/assistant pair. Nothing about that file format is a public contract —
 * it is the Claude Code CLI's own on-disk shape, re-implemented from the fork the
 * CLI performs itself. A CLI upgrade could change a required field, tighten a
 * parser, or alter how `resume` locates and validates a transcript, and the fork
 * would keep "succeeding": the file lands, the sidebar shows the session, and
 * only when the user sends their first message does it fail — or worse, resume
 * with the branch's history silently dropped.
 *
 * The unit tests (claude-transcript-fork.test.ts) assert the file's STRUCTURE.
 * They cannot prove the real CLI can still RESUME it. This does: it seeds a real
 * session, forks it, resumes the FORK with the real CLI, and asserts the model
 * can see BOTH halves of the branch — the inherited conversation and the
 * appended side exchange.
 *
 * ── WHEN TO RUN ──────────────────────────────────────────────────────────────
 * On every Claude Code CLI version bump, alongside `npm run test:smoke:btw-hook`.
 * Deliberately OUTSIDE `npm test`: it spends real subscription quota (two short
 * haiku turns) and needs an authenticated CLI.
 *   npm run test:smoke:btw-fork
 *
 * Last verified against Claude Code CLI: 2.1.219 (2026-07-29).
 *
 * ── WHAT IT GUARDS / WHAT IT DOES NOT ────────────────────────────────────────
 * GUARDS: BOTH branch modes are resumable by the real CLI — the full branch keeps
 *   its inherited history through the uuid/sessionId rewrite, the fresh thread
 *   carries the exchange and provably NOT the history — the appended /btw pair is
 *   visible to the resumed model in both, and the SOURCE transcript is left
 *   byte-identical.
 * DOES NOT GUARD: the WS gates, the DB indexing/participant wiring (unit-tested
 *   in session-fork.service.test.ts), or how the branch renders in the UI.
 *
 * Isolation is STRUCTURAL: everything runs under a temp CLAUDE_CONFIG_DIR, so no
 * session can land in ~/.claude/projects and appear in the nassaj UI (B-28/B-29).
 * Only .credentials.json is borrowed from the real config dir; real settings are
 * never read or written.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { query } from '@anthropic-ai/claude-agent-sdk';

import { forkClaudeTranscript } from '../../server/modules/providers/list/claude/claude-transcript-fork.js';
import { resolveClaudeCodeExecutablePath } from '../../server/shared/claude-cli-path.js';

const SEED_TIMEOUT_MS = 90_000;
const RESUME_TIMEOUT_MS = 120_000;

function log(...args) {
  console.log('[fork-smoke]', ...args);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits until a transcript stops growing. The CLI keeps appending trailing
 * metadata rows (ai-title, last-prompt) for a moment AFTER the run's `result`
 * message, so hashing immediately would compare against a file the CLI — not the
 * fork — is still writing.
 */
async function waitForStableFile(file, quietMs = 1_500, maxWaitMs = 20_000) {
  const deadline = Date.now() + maxWaitMs;
  let last = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
    if (size === last && size >= 0) {
      if (stableSince && Date.now() - stableSince >= quietMs) {
        return true;
      }
      if (!stableSince) {
        stableSince = Date.now();
      }
    } else {
      last = size;
      stableSince = 0;
    }
    await sleep(250);
  }
  return false;
}

/** Collects the assistant text of one query run. */
async function runQuery(options, timeoutMs) {
  const run = query(options);
  const timer = setTimeout(() => {
    run.interrupt?.().catch(() => {});
  }, timeoutMs);
  let text = '';
  let sessionId = null;
  try {
    for await (const message of run) {
      if (message && typeof message.session_id === 'string' && message.session_id) {
        sessionId = message.session_id;
      }
      if (message?.type === 'assistant') {
        for (const block of message.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            text += block.text;
          }
        }
      }
      if (message?.type === 'result') {
        if (typeof message.result === 'string' && message.result) {
          text = message.result;
        }
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    await run.interrupt?.().catch(() => {});
  }
  return { text, sessionId };
}

async function main() {
  const sourceConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const sourceCreds = path.join(sourceConfigDir, '.credentials.json');
  if (!fs.existsSync(sourceCreds)) {
    log('FATAL: no .credentials.json under', sourceConfigDir, '— cannot authenticate the real CLI.');
    log('This test needs an authenticated Claude Code CLI. Skipping is NOT a pass.');
    process.exit(2);
  }

  const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'btw-fork-cfg-'));
  const tmpProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'btw-fork-proj-')));
  fs.writeFileSync(path.join(tmpProject, 'README.md'), '# btw fork smoke project\n');
  fs.copyFileSync(sourceCreds, path.join(tmpConfigDir, '.credentials.json'));
  fs.chmodSync(path.join(tmpConfigDir, '.credentials.json'), 0o600);

  // Two unguessable markers: one planted in the INHERITED history, one only in
  // the APPENDED side answer. The resumed fork must be able to see both.
  const seedMarker = `SEEDMARK-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const sideMarker = `SIDEMARK-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

  const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const savedBaseUrl = process.env.ANTHROPIC_BASE_URL;
  const savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = tmpConfigDir;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  const executable = resolveClaudeCodeExecutablePath(process.env.CLAUDE_CLI_PATH);
  let exitCode = 1;

  try {
    // ── Step 1: seed a real session carrying the seed marker in its history. ──
    log('seeding a real session (tmp config dir:', tmpConfigDir + ')');
    const seed = await runQuery(
      {
        prompt:
          `Remember this project code: ${seedMarker}. Reply with the single word: ok`,
        options: {
          cwd: tmpProject,
          env: { ...process.env },
          model: 'haiku',
          maxTurns: 1,
          pathToClaudeCodeExecutable: executable,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      },
      SEED_TIMEOUT_MS,
    );
    if (!seed.sessionId) {
      log('FATAL: seed produced no session id. Auth or CLI problem.');
      process.exit(2);
    }
    log('seeded live session:', seed.sessionId);

    const sourceTranscript = path.join(
      tmpConfigDir,
      'projects',
      tmpProject.replace(/[^a-zA-Z0-9-]/g, '-'),
      `${seed.sessionId}.jsonl`,
    );
    if (!fs.existsSync(sourceTranscript)) {
      log('FATAL: the seeded transcript is not where the fork expects it:', sourceTranscript);
      process.exit(2);
    }
    await waitForStableFile(sourceTranscript);
    const sourceHashBefore = sha256(sourceTranscript);
    const sourceSizeBefore = fs.statSync(sourceTranscript).size;

    // ── Step 2: fork it, appending a /btw exchange (the real code path). ──────
    const forked = await forkClaudeTranscript({
      sourceFilePath: sourceTranscript,
      sourceSessionId: seed.sessionId,
      extraMessages: [
        { role: 'user', content: 'What is the side code for this task?' },
        { role: 'assistant', content: `The side code for this task is ${sideMarker}.` },
      ],
      title: 'btw: What is the side code for this task?',
    });
    log('forked session:', forked.forkedSessionId, `(${forked.entryCount} entries)`);

    // The source must be untouched — a fork that mutates the live transcript
    // would corrupt a running conversation.
    const sourceHashAfter = sha256(sourceTranscript);
    if (sourceHashBefore !== sourceHashAfter) {
      log(
        'FAIL: the SOURCE transcript changed during the fork.',
        `before=${sourceSizeBefore}B after=${fs.statSync(sourceTranscript).size}B`,
      );
      process.exit(1);
    }
    log('source transcript unchanged ✔');

    // ── Step 3: resume the FORK with the real CLI and ask for both markers. ───
    const resumed = await runQuery(
      {
        prompt:
          'Reply with exactly two tokens separated by one space and nothing else: '
          + 'first the project code you were told to remember, then the side code for this task.',
        options: {
          cwd: tmpProject,
          env: { ...process.env },
          model: 'haiku',
          maxTurns: 1,
          resume: forked.forkedSessionId,
          pathToClaudeCodeExecutable: executable,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      },
      RESUME_TIMEOUT_MS,
    );

    const answer = resumed.text || '';
    const sawSeed = answer.includes(seedMarker);
    const sawSide = answer.includes(sideMarker);
    log('resumed answer:', JSON.stringify(answer.slice(0, 200)));
    log('inherited history visible:', sawSeed ? 'YES ✔' : 'NO ✘');
    log('appended /btw exchange visible:', sawSide ? 'YES ✔' : 'NO ✘');

    if (!resumed.sessionId) {
      log('FAIL: the CLI would not resume the forked transcript at all.');
      process.exit(1);
    }
    if (!sawSeed || !sawSide) {
      log('FAIL: the fork resumed but its content did not survive.');
      process.exit(1);
    }
    log('PASS (full): the branch resumed with BOTH the inherited history and the side exchange.');

    // ── Step 4: the FRESH mode — a branch with NO inherited history. ──────────
    // Structurally a different transcript (three lines, a user entry as the root
    // and no ancestry at all), so "the full branch resumes" proves nothing about
    // it. Assert both directions: the side exchange IS there, and the seed marker
    // is NOT — a fresh thread that silently inherited context would be a leak of
    // exactly the context the user chose not to carry.
    const fresh = await forkClaudeTranscript({
      sourceFilePath: sourceTranscript,
      sourceSessionId: seed.sessionId,
      includeHistory: false,
      extraMessages: [
        { role: 'user', content: 'What is the side code for this task?' },
        { role: 'assistant', content: `The side code for this task is ${sideMarker}.` },
      ],
      title: 'btw: What is the side code for this task?',
    });
    log('fresh thread:', fresh.forkedSessionId, `(${fresh.entryCount} entries)`);
    if (fresh.entryCount !== 2) {
      log('FAIL: a fresh thread must hold exactly the exchange, got', fresh.entryCount);
      process.exit(1);
    }

    const resumedFresh = await runQuery(
      {
        prompt:
          'Reply with exactly one line and nothing else: the side code for this task, '
          + 'then the project code you were told to remember if you know it, or the word NONE if you do not.',
        options: {
          cwd: tmpProject,
          env: { ...process.env },
          model: 'haiku',
          maxTurns: 1,
          resume: fresh.forkedSessionId,
          pathToClaudeCodeExecutable: executable,
          systemPrompt: { type: 'preset', preset: 'claude_code' },
        },
      },
      RESUME_TIMEOUT_MS,
    );

    const freshAnswer = resumedFresh.text || '';
    const freshSawSide = freshAnswer.includes(sideMarker);
    const freshSawSeed = freshAnswer.includes(seedMarker);
    log('fresh resumed answer:', JSON.stringify(freshAnswer.slice(0, 200)));
    log('side exchange visible:', freshSawSide ? 'YES ✔' : 'NO ✘');
    log('history correctly ABSENT:', freshSawSeed ? 'NO ✘ (leaked!)' : 'YES ✔');

    if (!resumedFresh.sessionId) {
      log('FAIL: the CLI would not resume the fresh thread.');
      exitCode = 1;
    } else if (freshSawSide && !freshSawSeed) {
      log('PASS: both branch modes resume correctly, each carrying exactly what it should.');
      exitCode = 0;
    } else {
      log('FAIL: the fresh thread resumed with the wrong content.');
      exitCode = 1;
    }
  } catch (error) {
    log('FAIL: unexpected error —', error?.message || error);
    exitCode = 1;
  } finally {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    if (savedBaseUrl !== undefined) process.env.ANTHROPIC_BASE_URL = savedBaseUrl;
    if (savedAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
    // Only our own temp tree is removed — never the shared real config dir, which
    // a concurrent session may be writing to right now.
    fs.rmSync(tmpConfigDir, { recursive: true, force: true });
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

main();
