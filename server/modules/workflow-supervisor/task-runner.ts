/**
 * task-runner — the command that runs INSIDE `wf-<taskId>.service` (§أ-4).
 *
 * Ports the proven producer wrapper (`spikes/b103-t819/bin/task-inner.sh`) to a
 * self-contained Node entrypoint so it ships in dist-server and is invoked by an
 * ABSOLUTE `node` path (no PATH dependence). It:
 *   1. runs `claude -p '<prompt>' --output-format json [--model M]`, streaming
 *      stdout into `<task-dir>/result.json.partial` (stderr → stderr.log),
 *   2. bounds the run with an internal SIGTERM timer (keeping THIS wrapper alive
 *      so it still seals a DONE for an interrupted run — the PARTIAL mechanism),
 *   3. seals via the ONE atomic path (result-capture-writer.seal): clean exit ⇒
 *      rename(.partial → result.json) then DONE; else DONE only (partial stays).
 *
 * It ALWAYS exits 0 on a normal seal, so the unit goes `inactive` (sealed) and
 * the `failed` state is reserved to mean "the wrapper itself was killed before
 * sealing" (CRASHED) — the liveness contract the monitor classifies against.
 *
 * The isolated credential (CLAUDE_CONFIG_DIR) and everything else reach this
 * process via `systemd-run --setenv` (never inheritance) — this wrapper reads
 * `process.env` unchanged and passes it to the child.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';

import { seal } from './result-capture-writer.js';

type Args = {
  taskDir: string;
  claudeBin: string;
  prompt: string;
  model: string | null;
  outputFormat: string;
  claudeTimeoutSec: number | null;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    taskDir: '',
    claudeBin: 'claude',
    prompt: '',
    model: null,
    outputFormat: 'json',
    claudeTimeoutSec: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--task-dir') a.taskDir = argv[++i] ?? '';
    else if (t === '--claude-bin') a.claudeBin = argv[++i] ?? 'claude';
    else if (t === '--prompt') a.prompt = argv[++i] ?? '';
    else if (t === '--model') a.model = argv[++i] ?? null;
    else if (t === '--output-format') a.outputFormat = argv[++i] ?? 'json';
    else if (t === '--claude-timeout-sec') a.claudeTimeoutSec = Number.parseInt(argv[++i] ?? '', 10);
    else throw new Error(`unknown arg: ${t}`);
  }
  if (!a.taskDir) throw new Error('--task-dir required');
  if (!a.prompt) throw new Error('--prompt required');
  if (a.claudeTimeoutSec != null && !Number.isInteger(a.claudeTimeoutSec)) {
    a.claudeTimeoutSec = null;
  }
  return a;
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  fs.mkdirSync(a.taskDir, { recursive: true, mode: 0o700 });

  const partialPath = `${a.taskDir}/result.json.partial`;
  const stderrPath = `${a.taskDir}/stderr.log`;
  // Ensure `.partial` exists even if the child writes nothing.
  fs.writeFileSync(partialPath, '', { mode: 0o600 });

  const out = fs.createWriteStream(partialPath, { flags: 'w', mode: 0o600 });
  const errOut = fs.createWriteStream(stderrPath, { flags: 'w', mode: 0o600 });

  const childArgs = ['-p', a.prompt, '--output-format', a.outputFormat];
  if (a.model) childArgs.push('--model', a.model);

  const child = spawn(a.claudeBin, childArgs, {
    cwd: process.cwd(), // the project cwd (systemd --working-directory)
    env: process.env, // includes the --setenv-injected CLAUDE_CONFIG_DIR
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.pipe(out);
  child.stderr.pipe(errOut);

  // Internal bound: SIGTERM the child after the timeout but keep THIS wrapper
  // alive so it still seals a DONE carrying the non-zero exit (PARTIAL run).
  let timer: NodeJS.Timeout | null = null;
  if (a.claudeTimeoutSec != null && a.claudeTimeoutSec > 0) {
    timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }, a.claudeTimeoutSec * 1000);
  }

  let childDone: { code: number | null; signal: string | null } | null = null;
  let partialClosed = false;
  let finalized = false;

  const finalize = (): void => {
    if (finalized) return;
    if (childDone === null || !partialClosed) return;
    finalized = true;
    if (timer) clearTimeout(timer);
    // Effective exit code: null (signal-killed) => non-zero so it is PARTIAL.
    const ec = childDone.code != null ? childDone.code : 1;
    try {
      seal(a.taskDir, ec, { signal: childDone.signal });
    } catch (err) {
      // A seal failure must still let the unit exit; surface on stderr.log.
      try {
        fs.appendFileSync(stderrPath, `\n[task-runner] seal failed: ${String(err)}\n`);
      } catch {
        /* best-effort */
      }
    }
    // Exit 0 so the unit is `inactive` (sealed), not `failed` (CRASHED).
    process.exit(0);
  };

  child.on('error', (err) => {
    try {
      fs.appendFileSync(stderrPath, `\n[task-runner] spawn error: ${String(err)}\n`);
    } catch {
      /* best-effort */
    }
    childDone = { code: 127, signal: null };
    out.end();
  });
  child.on('exit', (code, signal) => {
    childDone = { code, signal: signal ?? null };
    out.end(); // flush the partial; seal waits for its 'close'
  });
  out.on('close', () => {
    partialClosed = true;
    finalize();
  });
  // finalize is gated on BOTH child exit and partial 'close'.
  const gate = setInterval(() => {
    if (childDone !== null && partialClosed) {
      clearInterval(gate);
      finalize();
    }
  }, 50);
}

main();
