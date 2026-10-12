/**
 * ADR-201 A-P2 — negative tests per migrated Codex and vendor reader, through
 * each reader's real entry point: turn metrics (captureCodexTurnBaseline),
 * receipt proof (captureCodexReceiptWindow), the live rollout tail
 * (startCodexRolloutTail) and the vendor history fallback for direct callers
 * (VendorSessionsProvider#fetchHistory with no supplied transcript).
 *
 * Every scenario plants the same content and differs by one defect:
 *   - genuine:  the file is named for the id and (Codex) its `session_meta` is the id (control);
 *   - forged:   Codex: `session_meta` names another session; vendor: the recorded
 *               path is another session's file;
 *   - crossTree: Codex: the recorded path in member tree /1 is a symlink to /10's
 *               file (prefix trap); vendor (no member trees): a member-tree path;
 *   - symlink:  the recorded path is a symlink to a file outside every provider root;
 *   - hardlink: the recorded path is a hardlink of another tree's file.
 * Fixtures: the real Codex share header and progress rollout, the real Kimi
 * share transcript (B-1520 redacted), re-keyed.
 *
 * Runner: node scripts/run-isolated-node-tests.mjs server <this file>
 */
// FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { getConnection, initializeDatabase } from '@/modules/database/index.js';
import { captureCodexReceiptWindow } from '@/modules/providers/list/codex/codex-receipt-proof.js';
import { startCodexRolloutTail } from '@/modules/providers/list/codex/codex-rollout-tail.js';
import { captureCodexTurnBaseline } from '@/modules/providers/list/codex/codex-turn-metrics.js';
import { VendorSessionsProvider } from '@/modules/providers/shared/vendor/vendor-sessions.provider.js';
// eslint-disable-next-line boundaries/no-unknown -- shared test fixture helper (same seam as sandbox-home)
import { codexSessionMetaLine } from '@/shared/__tests__/provider-root-sandbox.js';

type Scenario = 'genuine' | 'forged' | 'crossTree' | 'symlink' | 'hardlink';
const SCENARIOS: readonly Scenario[] = ['genuine', 'forged', 'crossTree', 'symlink', 'hardlink'];
const DAY = path.join('2026', '10', '09');
const OPERATOR_SESSIONS = path.join(SANDBOX_HOME, '.codex', 'sessions');
const memberSessions = (member: string) => path.join(SANDBOX_HOME, '.nassaj-users', member, '.codex', 'sessions');
const OUTSIDE = path.join(SANDBOX_HOME, 'outside-every-root');
const VENDOR_ROOT = path.join(SANDBOX_HOME, '.nassaj-vendor-sessions', 'kimi', 'f'.repeat(32));
const SHARE = path.join(import.meta.dirname, '..', '..', '..', 'services', '__fixtures__', 'session-share');
const PROGRESS = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '..', 'list', 'codex', '__tests__', '__fixtures__', 'codex-progress.real.json'), 'utf8',
)) as { rollout: unknown[] };

await initializeDatabase();

let counter = 0;
const nextId = () => `00000000-0000-7000-9000-${String(++counter).padStart(12, '0')}`;

function write(file: string, text: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function link(target: string, recorded: string, hard: boolean): string {
  fs.mkdirSync(path.dirname(recorded), { recursive: true });
  if (hard) fs.linkSync(target, recorded);
  else fs.symlinkSync(target, recorded);
  return recorded;
}

/** A real-shaped rollout bound to `headerId`, carrying a live spawn. */
const rolloutText = (headerId: string) =>
  [codexSessionMetaLine(headerId), ...PROGRESS.rollout.map((row) => JSON.stringify(row))].join('\n') + '\n';

/** Where `scenario`'s rollout lives and the path the row records (plus the run's sessions root). */
function codexLayout(id: string, scenario: Scenario): { target: string; recorded: string; root: string } {
  const name = path.join(DAY, `rollout-2026-10-09T10-17-05-${id}.jsonl`);
  const own = path.join(OPERATOR_SESSIONS, name);
  switch (scenario) {
    case 'crossTree': return { target: path.join(memberSessions('10'), name), recorded: path.join(memberSessions('1'), name), root: memberSessions('1') };
    case 'symlink': return { target: path.join(OUTSIDE, name), recorded: own, root: OPERATOR_SESSIONS };
    case 'hardlink': return { target: path.join(memberSessions('10'), name), recorded: own, root: OPERATOR_SESSIONS };
    default: return { target: own, recorded: own, root: OPERATOR_SESSIONS };
  }
}

/** Plants a Codex `scenario` for a fresh session row; returns the session id, recorded path and run root. */
function plantCodex(scenario: Scenario): { sessionId: string; recorded: string; root: string } {
  const sessionId = nextId();
  const { target, recorded, root } = codexLayout(sessionId, scenario);
  write(target, rolloutText(scenario === 'forged' ? nextId() : sessionId));
  if (recorded !== target) link(target, recorded, scenario === 'hardlink');
  getConnection().prepare('INSERT INTO sessions (session_id, provider, jsonl_path) VALUES (?, ?, ?)')
    .run(sessionId, 'codex', recorded);
  return { sessionId, recorded, root };
}

async function expectOnlyGenuine(
  name: string, plantOne: (scenario: Scenario) => { sessionId: string; recorded: string; root: string },
  probe: (row: { sessionId: string; recorded: string; root: string }) => Promise<boolean>,
): Promise<void> {
  for (const scenario of SCENARIOS) {
    assert.equal(await probe(plantOne(scenario)), scenario === 'genuine', `${name}: ${scenario}`);
  }
}

test('turn metrics: a baseline is captured only on a genuine rollout', async () => {
  await expectOnlyGenuine('turn-metrics', plantCodex, async ({ sessionId }) =>
    (await captureCodexTurnBaseline(sessionId)) !== null);
});

test('receipt proof: a pre-run window is captured only on a genuine rollout', async () => {
  await expectOnlyGenuine('receipt-proof', plantCodex, async ({ sessionId }) =>
    (await captureCodexReceiptWindow(sessionId, 'resume')) !== null);
});

test('rollout tail: a live spawn is surfaced only from a genuine rollout', async () => {
  await expectOnlyGenuine('rollout-tail', plantCodex, async ({ sessionId, recorded, root }) => {
    const signals: unknown[] = [];
    const tail = startCodexRolloutTail({
      threadId: sessionId, sessionsRoot: root, resumed: false, storedPath: recorded,
      now: () => new Date(2026, 9, 9, 10, 17, 5), limits: { pollMs: 5, waitStepMs: 5, waitMaxMs: 60 },
      onSignal: (signal) => signals.push(signal),
    });
    const deadline = Date.now() + 400;
    while (signals.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await tail.stop();
    return signals.length > 0;
  });
});

/** The real Kimi share transcript, whose header carries no id (vendor files are named for it). */
const KIMI_TEXT = fs.readFileSync(path.join(SHARE, 'kimi.jsonl'), 'utf8');

/** Plants a vendor `scenario` for a fresh Kimi session row; returns its id and recorded path. */
function plantVendor(scenario: Scenario): { sessionId: string; recorded: string; root: string } {
  const sessionId = nextId();
  const own = path.join(VENDOR_ROOT, `${sessionId}.jsonl`);
  const layouts: Record<Scenario, { target: string; recorded: string }> = {
    genuine: { target: own, recorded: own },
    forged: { target: path.join(VENDOR_ROOT, `${nextId()}.jsonl`), recorded: '' },
    crossTree: { target: path.join(SANDBOX_HOME, '.nassaj-users', '1', '.nassaj-vendor-sessions', 'kimi', `${sessionId}.jsonl`), recorded: '' },
    symlink: { target: path.join(OUTSIDE, 'kimi', `${sessionId}.jsonl`), recorded: own },
    hardlink: { target: path.join(OUTSIDE, 'kimi-hard', `${sessionId}.jsonl`), recorded: own },
  };
  const { target } = layouts[scenario];
  const recorded = layouts[scenario].recorded || target;
  write(target, KIMI_TEXT);
  if (recorded !== target) link(target, recorded, scenario === 'hardlink');
  getConnection().prepare('INSERT INTO sessions (session_id, provider, jsonl_path) VALUES (?, ?, ?)')
    .run(sessionId, 'kimi', recorded);
  return { sessionId, recorded, root: VENDOR_ROOT };
}

test('vendor history (direct caller): a recorded transcript is read only when genuine', async () => {
  const provider = new VendorSessionsProvider({ provider: 'kimi' });
  await expectOnlyGenuine('vendor', plantVendor, async ({ sessionId }) =>
    (await provider.fetchHistory(sessionId, { projectPath: '/repo' })).total > 0);
});
