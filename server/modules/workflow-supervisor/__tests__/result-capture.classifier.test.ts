/**
 * T-821 — the §أ-3 terminal-state CLASSIFIER on server code (audit condition C2).
 * Proves the deterministic verdict the monitor delivers against, INCLUDING the
 * DONE-absent reconciliation rule (grace → decisive PARTIAL-untrusted/CRASHED,
 * never a hang, never a false SUCCEEDED) — the T-819 acceptance bar (criterion 3).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyTerminal, type UnitState } from '@/modules/workflow-supervisor/result-capture.js';

const constProbe = (state: UnitState) => async () => state;
const noSleep = async () => {};

async function mkTask(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rc-classify-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), body);
  }
  return dir;
}

test('DONE exit 0 + result.json ⇒ SUCCEEDED', async () => {
  const dir = await mkTask({
    'result.json': '{"ok":true}',
    DONE: JSON.stringify({ exit_code: 0, signal: null }),
  });
  try {
    const v = await classifyTerminal(dir, 'wf-x.service', constProbe('inactive'), { sleep: noSleep });
    assert.equal(v.classification, 'SUCCEEDED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DONE with a kill signal ⇒ CRASHED', async () => {
  const dir = await mkTask({ DONE: JSON.stringify({ exit_code: null, signal: 'SIGKILL' }) });
  try {
    const v = await classifyTerminal(dir, 'wf-x.service', constProbe('failed'), { sleep: noSleep });
    assert.equal(v.classification, 'CRASHED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DONE exit non-zero ⇒ PARTIAL', async () => {
  const dir = await mkTask({
    'result.json.partial': 'half',
    DONE: JSON.stringify({ exit_code: 2, signal: null }),
  });
  try {
    const v = await classifyTerminal(dir, 'wf-x.service', constProbe('inactive'), { sleep: noSleep });
    assert.equal(v.classification, 'PARTIAL');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DONE exit 0 but result.json ABSENT ⇒ PARTIAL-untrusted (anomaly)', async () => {
  const dir = await mkTask({ DONE: JSON.stringify({ exit_code: 0, signal: null }) });
  try {
    const v = await classifyTerminal(dir, 'wf-x.service', constProbe('inactive'), { sleep: noSleep });
    assert.equal(v.classification, 'PARTIAL-untrusted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('no DONE + unit still active ⇒ RUNNING (bounded, no hang)', async () => {
  const dir = await mkTask({ 'result.json.partial': 'streaming' });
  try {
    const v = await classifyTerminal(dir, 'wf-x.service', constProbe('active'), {
      pollTimeoutMs: 30,
      pollIntervalMs: 10,
      sleep: noSleep,
    });
    assert.equal(v.classification, 'RUNNING');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DONE-absent reconciliation: terminal FAILED + no result ⇒ CRASHED after grace', async () => {
  const dir = await mkTask({ 'result.json.partial': 'half' });
  try {
    const v = await classifyTerminal(dir, 'wf-x.service', constProbe('failed'), {
      graceMs: 5,
      sleep: noSleep,
    });
    assert.equal(v.classification, 'CRASHED');
    assert.equal(v.graceApplied, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DONE-absent reconciliation: terminal INACTIVE + result.json present ⇒ PARTIAL-untrusted', async () => {
  // The "success then kill -9 before DONE" hole (§أ-3): result.json is complete
  // but unsealed. Decisive, never SUCCEEDED.
  const dir = await mkTask({ 'result.json': '{"complete":true}' });
  try {
    const v = await classifyTerminal(dir, 'wf-x.service', constProbe('inactive'), {
      graceMs: 5,
      sleep: noSleep,
    });
    assert.equal(v.classification, 'PARTIAL-untrusted');
    assert.equal(v.graceApplied, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('DONE-absent loss race: DONE appears DURING the grace ⇒ resolves to the DONE verdict', async () => {
  const dir = await mkTask({ 'result.json': '{"ok":true}' });
  try {
    // The injected grace-sleep writes DONE mid-grace, modelling the wrapper
    // sealing a few ms after is-active flipped terminal — the verdict must then
    // upgrade to SUCCEEDED (the loss race resolved), not stay PARTIAL-untrusted.
    const sleep = async () => {
      await writeFile(path.join(dir, 'DONE'), JSON.stringify({ exit_code: 0, signal: null }));
    };
    const v = await classifyTerminal(dir, 'wf-x.service', constProbe('inactive'), {
      graceMs: 5,
      sleep,
    });
    assert.equal(v.classification, 'SUCCEEDED');
    assert.equal(v.graceApplied, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('probe rejection is treated as gone (terminal), never a hang', async () => {
  const dir = await mkTask({ 'result.json.partial': 'x' });
  try {
    const throwingProbe = async () => {
      throw new Error('systemctl blip');
    };
    const v = await classifyTerminal(dir, 'wf-x.service', throwingProbe, { graceMs: 5, sleep: noSleep });
    // gone + no result.json ⇒ CRASHED (decisive).
    assert.equal(v.classification, 'CRASHED');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
