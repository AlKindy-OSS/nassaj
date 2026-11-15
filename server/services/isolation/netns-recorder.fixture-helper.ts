/**
 * Shared sealed-namespace recorder for the local-engine header-echo proofs
 * (ADR-227: Claude sh8 qa item 4, Codex T-2107). The namespace routes EVERY
 * destination to loopback, so a DNS query or a dial to any vendor host becomes a
 * packet on `lo`, where an AF_PACKET recorder (netns-connect-recorder.fixture.py)
 * logs it. A run whose recorder wrote nothing fails: an empty list must never
 * read as "nothing was contacted".
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'netns-connect-recorder.fixture.py');

export type Attempt = { proto: string; dst: string; port: number; query?: string };
export type Listen = { host: string; port: number };

/** True when an unprivileged loopback-only network namespace can be created. */
export function netnsAvailable(): boolean {
  return spawnSync('unshare', ['-rn', 'sh', '-c', 'ip link set lo up'], { timeout: 10_000 }).status === 0;
}

/** True when python3 can open an AF_PACKET socket (the recorder's requirement). */
export function packetRecorderAvailable(): boolean {
  return spawnSync('python3', ['-c', 'import socket; socket.AF_PACKET'], { timeout: 10_000 }).status === 0;
}

/**
 * Runs `inner` (argv) inside a namespace that routes everything to lo, with the
 * recorder on. `root` holds the recorder's output files.
 */
export function recordInNetns(root: string, tag: string, inner: string[]): { attempts: Attempt[]; stdout: string; status: number | null } {
  const out = path.join(root, `attempts-${tag}.json`);
  const ready = path.join(root, `ready-${tag}`);
  const script = [
    'ip link set lo up',
    'ip route add local 0.0.0.0/0 dev lo table local',
    'ip -6 route add local ::/0 dev lo table local',
    'python3 -I "$0" "$1" "$2" & rec=$!',
    'i=0; while [ ! -e "$2" ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done',
    'shift 3; "$@"; rc=$?',
    'sleep 0.3; kill -TERM $rec; wait $rec; exit $rc',
  ].join('\n');
  const result = spawnSync('unshare', ['-rn', 'sh', '-c', script, RECORDER, out, ready, 'x', ...inner], {
    encoding: 'utf8', timeout: 120_000,
  });
  assert.ok(fs.existsSync(out), `recorder wrote nothing in ${tag}: ${result.stderr?.slice(0, 300)}`);
  const attempts = JSON.parse(fs.readFileSync(out, 'utf8')).attempts;
  assert.ok(Array.isArray(attempts), `recorder output of ${tag} has no attempts list`);
  return { attempts, stdout: result.stdout ?? '', status: result.status };
}

/** Attempts other than the TCP connect to `listen`. */
export function strayAttempts(attempts: Attempt[], listen: Listen): Attempt[] {
  return attempts.filter((a) => !(a.proto === 'tcp' && a.dst === listen.host && a.port === listen.port));
}

/** Recorder control: a dial and a DNS query to the outside world must both be caught. */
export function assertRecorderCatches(root: string, host: string): void {
  const probe = "import socket\ns=socket.socket(); s.settimeout(0.5); s.connect_ex(('198.51.100.7', 443))\n"
    + `try:\n  socket.getaddrinfo('${host}', 443)\nexcept OSError:\n  pass\n`;
  const { attempts } = recordInNetns(root, 'control', ['python3', '-I', '-c', probe]);
  assert.ok(attempts.some((a) => a.proto === 'tcp' && a.dst === '198.51.100.7' && a.port === 443), 'dial seen');
  assert.ok(attempts.some((a) => a.proto === 'udp' && a.port === 53), 'DNS query seen');
}
