#!/usr/bin/env node
/**
 * ADR-173 rev.3 P0 hard gate: proves LIVE, on the installed Claude CLI, whether a
 * resume works when the writer's CLAUDE_CONFIG_DIR/projects reaches the
 * creator's transcript through a link, per mode (`file_link`, `dir_link`; see
 * server/services/isolation/claude-shared-resume-proof.js). Per mode: 4 resumed
 * turns (plain, large tool result, subagent, auto-compaction) with the recorded
 * file's inode and the writer's link checked after each; then one retention
 * sweep (cleanupPeriodDays=1) in a scratch config dir over aged linked files.
 *
 * The writer runs on its own config dir and login (never copied or read); the
 * "creator" home is a scratch projects/ tree. Every CLI run uses a fresh cwd
 * under the scratch root; only the scratch cwd's encoded dir is created in the
 * writer's projects tree, and it is removed at the end. The sweep runs on a
 * dummy key against a loopback stub that never answers (nothing leaves the host).
 *
 *   node scripts/prove-claude-shared-resume.mjs [--bin <claude>] [--model haiku] [--record]
 *     [--out <results.json>] [--evidence <dir to keep a copy of each creator transcript tree>]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { SHARED_RESUME_MODES, recordSharedResumeProof } from '../server/services/isolation/claude-shared-resume-proof.js';

import {
  encodeProjectDir, expectedLinks, filesUnder, lineCount, linksIntact, modeVerdict, turnInvariants,
} from './prove-claude-shared-resume-lib.mjs';

const TURNS = Object.freeze([
  { name: 'plain', prompt: 'Reply with the single word ONE.' },
  { name: 'tool_result', prompt: 'Use the Bash tool to run exactly this command: seq 1 60000\nThen reply with the single word TWO.' },
  { name: 'subagent', prompt: 'Use the Agent tool with subagent_type "general-purpose" and the prompt '
    + '"Reply with the single word SUB." Then reply with the single word THREE.' },
  { name: 'compaction', prompt: 'Reply with the single word FOUR.', env: { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '1' } },
]);

function parseArgs(argv) {
  const args = { model: 'haiku', record: false, bin: path.join(os.homedir(), '.local/bin/claude'), out: null, evidence: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--record') args.record = true;
    else if (['--bin', '--model', '--out', '--evidence'].includes(argv[i])) args[argv[i].slice(2)] = argv[(i += 1)];
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function cliVersion(bin) {
  const out = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15_000 }).stdout ?? '';
  return /(\d+\.\d+\.\d+)/u.exec(out)?.[1] ?? null;
}

/** One headless writer turn; returns the parsed JSON result. */
function writerTurn(ctx, prompt, { resume, env = {} } = {}) {
  const args = ['-p', prompt, '--model', ctx.model, '--output-format', 'json',
    '--setting-sources', 'local', '--dangerously-skip-permissions', ...(resume ? ['--resume', resume] : [])];
  const run = spawnSync(ctx.bin, args, {
    cwd: ctx.cwd, encoding: 'utf8', timeout: 240_000,
    env: { HOME: os.homedir(), PATH: process.env.PATH, TMPDIR: '/var/tmp', CLAUDE_CONFIG_DIR: ctx.configDir,
      CLAUDE_CODE_SUBAGENT_MODEL: ctx.model, ...env },
  });
  const line = (run.stdout ?? '').trim().split('\n').reverse().find((l) => l.startsWith('{')) ?? '{}';
  const parsed = JSON.parse(line);
  return { sessionId: parsed.session_id, isError: parsed.is_error !== false || run.status !== 0, cost: parsed.total_cost_usd ?? 0 };
}

function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(from, { recursive: true });
  }
}

/** Starts a conversation as the writer, moves it into the creator home, links it back per mode. */
function setUpMode(ctx, mode) {
  const writerDir = path.join(ctx.writerProjects, encodeProjectDir(fs.realpathSync(ctx.cwd)));
  if (fs.existsSync(writerDir)) throw new Error(`refusing: ${writerDir} already exists`);
  const first = writerTurn(ctx, 'Reply with the single word READY.');
  if (first.isError || !first.sessionId) throw new Error(`${mode}: initial turn failed`);
  const sessionId = first.sessionId;
  const creatorDir = path.join(ctx.root, mode, 'creator', 'projects', path.basename(writerDir));
  fs.mkdirSync(path.dirname(creatorDir), { recursive: true });
  moveDir(writerDir, creatorDir);
  fs.mkdirSync(path.join(creatorDir, sessionId), { recursive: true });
  if (mode === 'file_link') fs.mkdirSync(writerDir);
  const links = expectedLinks(mode, { writerDir, creatorDir, sessionId });
  for (const { link, target } of links) fs.symlinkSync(target, link);
  return { writerDir, creatorDir, sessionId, links, recorded: path.join(creatorDir, `${sessionId}.jsonl`), cost: first.cost };
}

/** Per-turn content check of a turn that must leave a sidecar or a marker. */
function turnContent(name, layout) {
  const sidecar = path.join(layout.creatorDir, layout.sessionId);
  if (name === 'tool_result') {
    // The CLI names the saved file in the transcript; it must resolve into the recorded sidecar.
    const saved = /Full output saved to: (\S+?\.txt)/u.exec(fs.readFileSync(layout.recorded, 'utf8'))?.[1];
    const inSidecar = filesUnder(path.join(sidecar, 'tool-results'), /./u);
    const resolved = saved && fs.existsSync(saved) ? fs.realpathSync(saved) : null;
    return resolved && inSidecar.includes(resolved) ? inSidecar : [];
  }
  if (name === 'subagent') return filesUnder(path.join(sidecar, 'subagents'), /\.jsonl$/u);
  if (name === 'compaction') {
    const boundaries = fs.readFileSync(layout.recorded, 'utf8').split('\n')
      .filter((line) => line.includes('"compact_boundary"') && line.includes('"trigger":"auto"'));
    return boundaries.length > 0 ? [layout.recorded] : [];
  }
  return [];
}

/** Tool names used so far in the recorded transcript (diagnostic evidence). */
function toolsUsed(recorded) {
  return [...new Set([...fs.readFileSync(recorded, 'utf8').matchAll(/"type":"tool_use","id":"[^"]+","name":"([^"]+)"/gu)]
    .map((m) => m[1]))];
}

/** Jsonl files the CLI wrote outside the recorded file (a fork or a rename-write). */
function strays(layout) {
  const inCreator = fs.readdirSync(layout.creatorDir).filter((n) => n.endsWith('.jsonl') && n !== `${layout.sessionId}.jsonl`);
  const writerReal = fs.lstatSync(layout.writerDir).isSymbolicLink() ? []
    : fs.readdirSync(layout.writerDir).filter((n) => n.endsWith('.jsonl') && !fs.lstatSync(path.join(layout.writerDir, n)).isSymbolicLink());
  return [...inCreator.map((n) => `creator:${n}`), ...writerReal.map((n) => `writer:${n}`)];
}

function runTurns(ctx, layout) {
  const inode = fs.statSync(layout.recorded).ino;
  let linesBefore = lineCount(layout.recorded);
  const turns = [];
  for (const turn of TURNS) {
    const result = writerTurn(ctx, turn.prompt, { resume: layout.sessionId, env: turn.env });
    const invariants = turnInvariants({ result, sessionId: layout.sessionId, recorded: layout.recorded, inode, linesBefore, links: layout.links });
    turns.push({ name: turn.name, ...invariants, content: turnContent(turn.name, layout), strays: strays(layout),
      tools: toolsUsed(layout.recorded), cost: result.cost });
    linesBefore = invariants.lines;
  }
  const ls = (...args) => spawnSync('ls', args, { encoding: 'utf8' }).stdout;
  const listing = ls('-lid', layout.writerDir) + ls('-li', `${layout.writerDir}/`, layout.creatorDir);
  return { inode, turns, listing };
}

function verdictOf(record) {
  const ok = (value) => (value ? 'pass' : 'fail');
  const byName = Object.fromEntries(record.turns.map((t) => [t.name, t]));
  const contentVerdict = (name) => (byName[name].sameSession ? ok(byName[name].content.length > 0) : 'fail');
  return {
    three_turns: ok(record.turns.slice(0, 3).every((t) => t.sameSession && t.appended) && record.turns.every((t) => t.strays.length === 0)),
    tool_result: contentVerdict('tool_result'),
    subagent: contentVerdict('subagent'),
    compaction: byName.compaction.content.length > 0 ? 'pass' : 'unproven',
    inode_stable: ok(record.turns.every((t) => t.inodeStable)),
    link_preserved: ok(record.turns.every((t) => t.linksIntact)),
  };
}

const DAY_MS = 86_400_000;

function ageTree(entries) {
  const old = new Date(Date.now() - 40 * DAY_MS);
  for (const entry of entries) fs.lutimesSync(entry, old, old);
}

/** A creator-side session (jsonl + subagent + tool result) to be reached through a link; returns its files. */
function seedTarget(dir, sessionId) {
  fs.mkdirSync(path.join(dir, sessionId, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(dir, sessionId, 'tool-results'), { recursive: true });
  const files = [`${sessionId}.jsonl`, `${sessionId}/subagents/agent-a.jsonl`, `${sessionId}/tool-results/t.txt`]
    .map((rel) => path.join(dir, rel));
  for (const file of files) fs.writeFileSync(file, '{"type":"user"}\n');
  return files;
}

/** Lays out the sweep home: an aged real control dir plus each mode's aged links into a creator store. */
function seedSweepHome(root) {
  const home = path.join(root, 'sweep-home');
  const store = path.join(root, 'sweep-creator', 'projects');
  const sid = '00000000-0000-4000-8000-00000000abcd';
  const control = path.join(home, 'projects', '-control', 'old.jsonl');
  fs.mkdirSync(path.dirname(control), { recursive: true });
  fs.writeFileSync(control, '{"type":"user"}\n');
  fs.writeFileSync(path.join(home, 'settings.json'), '{"cleanupPeriodDays":1}\n');
  const modes = {};
  for (const mode of SHARED_RESUME_MODES) {
    const creatorDir = path.join(store, `-${mode}-target`);
    const writerDir = path.join(home, 'projects', `-${mode}`);
    const files = seedTarget(creatorDir, sid);
    if (mode === 'file_link') fs.mkdirSync(writerDir);
    const links = expectedLinks(mode, { writerDir, creatorDir, sessionId: sid });
    for (const { link, target } of links) fs.symlinkSync(target, link);
    ageTree([...files, ...links.map((l) => l.link), writerDir, creatorDir]);
    modes[mode] = { files, inodes: files.map((f) => fs.statSync(f).ino), links };
  }
  ageTree([control, path.dirname(control)]);
  return { home, control, modes };
}

/** A loopback endpoint that never answers in time, so the CLI stays up past its 5 s housekeeping delay. */
function stallingStub() {
  const server = http.createServer(() => undefined);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return predicate();
}

async function sweepCheck(ctx) {
  const sweep = seedSweepHome(ctx.root);
  const cwd = path.join(ctx.root, 'sweep-cwd');
  fs.mkdirSync(cwd);
  const stub = await stallingStub();
  const child = spawn(ctx.bin, ['-p', 'hi', '--model', ctx.model], {
    cwd, stdio: 'ignore',
    env: { HOME: os.homedir(), PATH: process.env.PATH, TMPDIR: '/var/tmp', CLAUDE_CONFIG_DIR: sweep.home,
      ANTHROPIC_API_KEY: 'sk-ant-dummy-not-a-key', ANTHROPIC_BASE_URL: `http://127.0.0.1:${stub.address().port}` },
  });
  const swept = await waitFor(() => !fs.existsSync(sweep.control), 30_000);
  child.kill('SIGKILL');
  stub.closeAllConnections();
  stub.close();
  const verdicts = {};
  for (const [mode, seeded] of Object.entries(sweep.modes)) {
    const intact = seeded.files.every((f, i) => fs.existsSync(f) && fs.statSync(f).ino === seeded.inodes[i]) && linksIntact(seeded.links);
    verdicts[mode] = { verdict: !swept ? 'unproven' : intact ? 'pass' : 'fail', controlSwept: swept, targetsIntact: intact };
  }
  return verdicts;
}

/** Removes the writer-tree entry of a mode (links only, never through them) and its session-env dir. */
function tearDownMode(ctx, layout) {
  if (!layout) return;
  const stat = fs.lstatSync(layout.writerDir, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) fs.unlinkSync(layout.writerDir);
  else if (stat) fs.rmSync(layout.writerDir, { recursive: true });
  fs.rmSync(path.join(ctx.configDir, 'session-env', layout.sessionId), { recursive: true, force: true });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const version = cliVersion(args.bin);
  if (!version) throw new Error('cannot read the Claude CLI version');
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'claude-shared-resume-proof-')));
  const base = { ...args, root, configDir, writerProjects: fs.realpathSync(path.join(configDir, 'projects')) };
  const results = { version, bin: fs.realpathSync(args.bin), at: new Date().toISOString(), modes: {} };
  try {
    for (const mode of SHARED_RESUME_MODES) {
      const cwd = path.join(root, mode, 'cwd');
      fs.mkdirSync(cwd, { recursive: true });
      const ctx = { ...base, cwd };
      let layout = null;
      try {
        layout = setUpMode(ctx, mode);
        const record = runTurns(ctx, layout);
        results.modes[mode] = { sessionId: layout.sessionId, ...record, checks: verdictOf(record) };
        if (args.evidence) fs.cpSync(layout.creatorDir, path.join(args.evidence, mode), { recursive: true });
      } finally {
        tearDownMode(ctx, layout);
      }
    }
    const sweep = await sweepCheck(base);
    for (const mode of SHARED_RESUME_MODES) {
      results.modes[mode].sweep = sweep[mode];
      results.modes[mode].checks = modeVerdict({ ...results.modes[mode].checks, cleanup_safe: sweep[mode].verdict });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  if (args.out) fs.writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
  if (args.record) {
    const modes = Object.fromEntries(SHARED_RESUME_MODES.map((m) => [m, results.modes[m].checks]));
    recordSharedResumeProof(version, modes, { probe: 'prove-claude-shared-resume.mjs', model: args.model });
  }
  console.log(JSON.stringify(Object.fromEntries(SHARED_RESUME_MODES.map((m) => [m, results.modes[m].checks])), null, 2));
}

main().catch((error) => {
  console.error(`prove-claude-shared-resume: ${error.message}`);
  process.exit(1);
});
