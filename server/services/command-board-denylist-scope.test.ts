/**
 * B-197 denylist SCOPE (2026-07-29) — the pm2 rail must refuse self-destruction
 * and nothing else.
 *
 * The rule used to match `pm2 <verb>` with no regard for the target, so a
 * routine `pm2 restart other-site` came back with the same refusal as the one
 * command that wedges port 3004 for hours (B-95). These tests pin BOTH halves:
 * the self-destructive shapes still deny (that is the whole point of the rail),
 * and a named third-party app is allowed to reach bash.
 *
 * Pure function tests — no router, no spawn, nothing runs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { findDenylistedCommand, MAX_RAW_COMMAND_LEN, RAW_DENY_RULES } from './command-board-raw.js';

/** Shapes that can take THIS server (or the pm2 daemon) down. */
const MUST_DENY = [
  'pm2 restart nassaj-dev',
  'pm2 restart all',
  'pm2 restart',
  'pm2 stop nassaj-dev',
  'pm2 reload all',
  'pm2 delete nassaj-dev',
  'pm2 del 1',
  'pm2 restart 1',
  'pm2 kill',
  'pm2 kill other-site',
  'pm2 restart ecosystem.config.cjs',
  'pm2 restart /etc/pm2/ecosystem.config.cjs',
  'pm2 --silent restart nassaj-dev',
  'sudo pm2 restart nassaj-dev',
  '/usr/bin/pm2 restart nassaj-dev',
  'p"m2" restart nassaj-dev',
  'pm2\trestart\tnassaj-dev',
  // a safe target does not launder an unsafe one in the same command
  'pm2 restart other-site && pm2 restart nassaj-dev',
  'pm2 restart other-site nassaj-dev',
  'pm2 restart nassaj-dev-staging',
  // opaque / expanded targets stay fail-closed
  'pm2 restart $APP',
  'pm2 restart /nassaj/',
  'pm2 restart "app*"',
];

/** Ordinary operations on OTHER apps — these must reach bash. */
const MUST_ALLOW = [
  'pm2 restart other-site',
  'pm2 reload other-site',
  'pm2 stop other-site',
  'pm2 delete other-site',
  'pm2 restart --update-env other-site',
  'pm2 restart other-site third-site',
  'pm2 restart other-site > /dev/null',
  'pm2 restart other-site && pm2 logs other-site --lines 20',
  'pm2 restart pm2-logrotate',
];

test('B-197 scope — self-destructive pm2 shapes still deny', () => {
  for (const cmd of MUST_DENY) {
    assert.equal(findDenylistedCommand(cmd), 'pm2_lifecycle', `should deny: ${cmd}`);
  }
});

test('B-197 scope — a lifecycle verb on another app is not this rail’s business', () => {
  for (const cmd of MUST_ALLOW) {
    assert.equal(findDenylistedCommand(cmd), null, `should allow: ${cmd}`);
  }
});

test('B-197 scope — the other rules are untouched by the pm2 exemption', () => {
  assert.equal(findDenylistedCommand('systemctl restart nginx'), 'systemctl_lifecycle');
  assert.equal(findDenylistedCommand('service nginx stop'), 'service_lifecycle');
  assert.equal(findDenylistedCommand('npm run build'), 'npm_build');
  assert.equal(findDenylistedCommand('pkill -f nassaj-dev'), 'kill_nassaj_dev');
  assert.equal(findDenylistedCommand('killall node'), 'kill_runtime');
  assert.equal(findDenylistedCommand('ls -la'), null);
  assert.equal(findDenylistedCommand('pm2 list'), null);
});

// B-322: the 2026-07-29 fleet-node incident command carried neither
// "nassaj-dev" nor "node", so kill_nassaj_dev and kill_runtime both waved it
// through. Pattern-directed kills (-f) must deny REGARDLESS of the target
// pattern; the literal incident payload is pinned here verbatim.
test('B-322 — pattern-directed kill denies regardless of target', () => {
  // The incident payload, byte for byte as the agent ran it.
  assert.equal(findDenylistedCommand('pkill -f "server/index.js" -e'), 'kill_by_pattern');
  // Flag order / clustering / other patterns.
  assert.equal(findDenylistedCommand('pkill -f vite'), 'kill_by_pattern');
  assert.equal(findDenylistedCommand('pkill -ef some-dev-server'), 'kill_by_pattern');
  assert.equal(findDenylistedCommand('pgrep -f tsx | xargs kill'), 'kill_by_pattern');
  // Behind a wrapper and mid-pipeline.
  assert.equal(findDenylistedCommand('nohup pkill -f anything'), 'kill_by_pattern');
  assert.equal(findDenylistedCommand('echo done && pkill -f dist/index.js'), 'kill_by_pattern');
  // Mass/session kill utilities.
  assert.equal(findDenylistedCommand('killall5'), 'kill_mass');
  assert.equal(findDenylistedCommand('skill -KILL -u nassaj'), 'kill_mass');
});

// B-322 review pass: the first cut of these rules left three holes, each found
// by testing rather than by reading. They are pinned individually because each
// one is a distinct escape from the previous rule set.
test('B-322 — name-directed kill without -f is denied too (parity with the agent guard)', () => {
  assert.equal(findDenylistedCommand('killall vite'), 'kill_by_name');
  assert.equal(findDenylistedCommand('pkill vite'), 'kill_by_name');
});

test('B-322 — `kill -9 -1` (every process this uid owns) is denied; a lone signal flag is not', () => {
  assert.equal(findDenylistedCommand('kill -9 -1'), 'kill_group');
  assert.equal(findDenylistedCommand('kill -- -123'), 'kill_group');
  assert.equal(findDenylistedCommand('kill -9 -- -1'), 'kill_group');
  // Review pass: the signal may be a SEPARATE value token. Both of these
  // slipped through the first cut while the agent-side guard blocked them —
  // i.e. the sanctioned rail was the laxer of the two.
  assert.equal(findDenylistedCommand('kill -s TERM -1'), 'kill_group');
  assert.equal(findDenylistedCommand('kill -n 9 -1'), 'kill_group');
  assert.equal(findDenylistedCommand('kill -TERM -1'), 'kill_group');
  // `-0` is the liveness probe memory-guard.sh uses; `-1` here is SIGHUP, not
  // a target. Both must survive, or the rule breaks working scripts.
  assert.equal(findDenylistedCommand('kill -0 999'), null);
  assert.equal(findDenylistedCommand('kill -1 555'), null);
  assert.equal(findDenylistedCommand('kill -9 4567'), null);
});

test('B-322 — a pattern-matched pid list piped into kill is the incident without the word', () => {
  assert.equal(findDenylistedCommand('pgrep -f "server/index.js" | xargs kill -9'), 'kill_by_pattern');
  // ...but listing alone is the diagnostic an operator needs mid-incident.
  // Denying it was a false positive in the first cut.
  assert.equal(findDenylistedCommand('pgrep -f vite'), null);
});

test('B-322 — only the KILLING form of a service-port command is denied', () => {
  // Needs raw matching: normalizeForDenylist folds `3004/` away as a path
  // prefix, so a normalised-only rule silently misses the whole point.
  assert.equal(findDenylistedCommand('fuser -k 3004/tcp'), 'kill_service_port');
  assert.equal(findDenylistedCommand('lsof -ti:3004'), 'kill_service_port');
  // Read-only diagnostics on the SAME port must stay allowed — they are what
  // an operator reaches for during an incident.
  assert.equal(findDenylistedCommand('lsof -i :3004'), null);
  assert.equal(findDenylistedCommand('fuser 3004/tcp'), null);
  assert.equal(findDenylistedCommand('ss -ltnp | grep 3004'), null);
  // The endorsed way to stop a worktree dev server must stay clean.
  assert.equal(findDenylistedCommand('fuser -k 8121/tcp'), null);
  assert.equal(findDenylistedCommand('lsof -ti:8121'), null);
});

test('B-322 — narrow, non-pattern process management stays allowed', () => {
  // Explicit-pid kill is the sanctioned narrow form.
  assert.equal(findDenylistedCommand('kill 12345'), null);
  assert.equal(findDenylistedCommand('kill -TERM 12345'), null);
  // Listing is not killing.
  assert.equal(findDenylistedCommand('pgrep vite'), null);
  // fuser -k on a dev port is the recommended replacement and must stay clean.
  assert.equal(findDenylistedCommand('fuser -k 8121/tcp'), null);
});

// ── T-1816 (B-1277/B-1278): host power, systemd manager, login sessions ───────
//
// ReDoS first: every new grammar has an option VALUE next to a repeatable
// wrapper/flag unit. Each unit is repeated up to the length cap with a tail
// that cannot match, so any ambiguous (exponential) reading would show up here.
const REDOS_UNITS = [
  'sudo -a ', 'sudo -u ', 'doas -u ', 'env a=1 ', 'env -i ', 'timeout 1 ',
  'nice -n 1 ', 'xargs -r ', 'systemctl --host ', 'systemctl -h ', 'loginctl -m ',
  'loginctl -s ', 'loginctl --kill-whom ', 'systemctl -h systemctl ',
  'exec command time ',
  // Separator-glued units: before T-1816 round 2 a value/flag token ran through
  // `;`/`(`/`&`, so every command-position start re-read the rest (quadratic).
  ';sudo -a x', '$(sudo -a x', '&sudo -- ',
  // A token readable both as an option value and as `NAME=val` was exponential.
  'sudo -u a=1 ', 'timeout -s a=1 ', 'doas -u a=1 b=2 ',
  'case x in x) ', ';;x) ', "\\'", '"\\"',
  // Round 3: the `case` branch read `;[\s;]*`, so a run of `;` (and LF and
  // backtick, which become `;`) was quadratic.
  ';', '`', '\n', ';;',
  // ANSI-C quoting: an escape-aware quote search must not repeat per `$'`.
  "$'\\'", "$'\\'\\", "$'",
  // Round 4: `in` matched at any word boundary inside a token (`!in`, `in-`,
  // `init--`, `<in`, `=in`) and then scanned to the token's end for `)`; and
  // `start|restart … .target` scanned lazily to the segment's end from every
  // systemctl. Both were quadratic on the whole call.
  '!in', 'in-', 'init--', '<in', '=in', 'systemctl start ',
  // Round 4: value-taking systemctl options added to the flag grammar.
  'systemctl --when x ', 'systemctl -s x ',
];
const REDOS_TAILS = ['-', 'x', '='];
const REDOS_SIZES = [1024, 4096] as const;

/** `unit` repeated to at most `size` chars, then `tail`. */
function redosInput(unit: string, tail: string, size: number): string {
  return unit.repeat(Math.floor((size - tail.length) / unit.length)) + tail;
}

/** Median wall time (ms) of one findDenylistedCommand call, after a warm-up. */
function medianCallMs(input: string): number {
  const calls = 10;
  for (let i = 0; i < calls; i += 1) findDenylistedCommand(input);
  const samples: number[] = [];
  for (let run = 0; run < 7; run += 1) {
    const started = performance.now();
    for (let i = 0; i < calls; i += 1) findDenylistedCommand(input);
    samples.push((performance.now() - started) / calls);
  }
  samples.sort((x, y) => x - y);
  return samples[Math.floor(samples.length / 2)];
}

test('T-1816 — no rule backtracks catastrophically or super-linearly at the length cap', () => {
  for (const unit of REDOS_UNITS) {
    for (const tail of REDOS_TAILS) {
      const [small, large] = REDOS_SIZES.map((size) => {
        const input = redosInput(unit, tail, size);
        assert.ok(input.length <= MAX_RAW_COMMAND_LEN);
        return medianCallMs(input);
      });
      const label = `${JSON.stringify(unit)} + ${JSON.stringify(tail)}`;
      assert.ok(large < 10, `${label} took ${large.toFixed(2)}ms at ${REDOS_SIZES[1]}`);
      // Linear growth is ×4 for ×4 input, quadratic ×16. The 0.02ms floor keeps
      // timer noise on a sub-microsecond call from reading as growth.
      const ratio = large / Math.max(small, 0.02);
      assert.ok(ratio < 8, `${label} grew ×${ratio.toFixed(1)} (${small.toFixed(3)} → ${large.toFixed(3)}ms)`);
    }
  }
});

/** Must deny, with the rule code that must report it. */
const T1816_MUST_DENY: ReadonlyArray<readonly [string, string]> = [
  // Host power, in command position.
  ['reboot', 'host_power'],
  ['sudo reboot', 'host_power'],
  ['poweroff', 'host_power'],
  ['halt', 'host_power'],
  ['shutdown -r now', 'host_power'],
  ['init 6', 'host_power'],
  ['telinit 0', 'host_power'],
  ['sudo -S reboot', 'host_power'],
  ['echo pw | sudo -S reboot', 'host_power'],
  ['sudo -u root reboot', 'host_power'],
  ['sudo -u 1000 reboot', 'host_power'],
  ['sudo -g www-data reboot', 'host_power'],
  ['sudo -H reboot', 'host_power'],
  ['nohup reboot &', 'host_power'],
  ['x && reboot', 'host_power'],
  ['x || reboot', 'host_power'],
  ['(reboot)', 'host_power'],
  ['$(reboot)', 'host_power'],
  ['echo "$(reboot)"', 'host_power'],
  ['x=`reboot`', 'host_power'],
  ['echo "use `reboot`"', 'host_power'],
  ['echo start\nreboot', 'host_power'],
  ['if [ -f /var/run/reboot-required ]; then sudo reboot; fi', 'host_power'],
  ['{ reboot; }', 'host_power'],
  ['! reboot', 'host_power'],
  ['env -i reboot', 'host_power'],
  ['nice -10 reboot', 'host_power'],
  ['timeout -s 9 5 reboot', 'host_power'],
  ['xargs -r reboot', 'host_power'],
  ['shutdown -c; reboot', 'host_power'],
  ['shutdown -c && shutdown -r now', 'host_power'],
  // Two backslashes = an escaped backslash, so the LF is a real separator.
  ['echo a\\\\\nreboot', 'host_power'],
  // The systemd manager itself.
  ['systemctl reboot', 'systemd_manager'],
  ['systemctl poweroff', 'systemd_manager'],
  ['systemctl halt', 'systemd_manager'],
  ['systemctl kexec', 'systemd_manager'],
  ['systemctl soft-reboot', 'systemd_manager'],
  ['systemctl emergency', 'systemd_manager'],
  ['systemctl rescue', 'systemd_manager'],
  ['systemctl daemon-reexec', 'systemd_manager'],
  ['systemctl isolate multi-user.target', 'systemd_manager'],
  ['systemctl exit', 'systemd_manager'],
  ['systemctl --user exit', 'systemd_manager'],
  ['systemctl --user halt', 'systemd_manager'],
  ['systemctl --user isolate x.target', 'systemd_manager'],
  ['systemctl --user reboot', 'systemd_manager'],
  ['systemctl --user poweroff', 'systemd_manager'],
  ['systemctl --user kexec', 'systemd_manager'],
  ['systemctl --user soft-reboot', 'systemd_manager'],
  ['systemctl --user emergency', 'systemd_manager'],
  ['systemctl --user rescue', 'systemd_manager'],
  ['systemctl --user daemon-reexec', 'systemd_manager'],
  ['systemctl suspend', 'systemd_manager'],
  ['systemctl start --no-block poweroff.target', 'systemd_manager'],
  ['systemctl --user start exit.target', 'systemd_manager'],
  // Conditional/alias restart verbs and systemctl's own option grammar.
  ['systemctl try-restart x', 'systemctl_lifecycle'],
  ['systemctl reload-or-restart x', 'systemctl_lifecycle'],
  ['systemctl condrestart x', 'systemctl_lifecycle'],
  ['systemctl condstop x', 'systemctl_lifecycle'],
  ['systemctl reload-or-try-restart x', 'systemctl_lifecycle'],
  ['systemctl -- restart x', 'systemctl_lifecycle'],
  // No exemption by target (T-1817): a host/machine selector is read with its
  // value, so the verb after it is still caught — local or remote alike.
  ['systemctl -H otherhost restart nginx', 'systemctl_lifecycle'],
  ['systemctl --machine=foo restart x', 'systemctl_lifecycle'],
  ['systemctl -H other -H another restart nginx', 'systemctl_lifecycle'],
  ['systemctl -H other reboot', 'systemd_manager'],
  // Round 3 veto table: each ran LOCALLY in bash yet passed the remote exemption.
  ['systemctl restart nassaj\n-H other', 'systemctl_lifecycle'],
  ['systemctl restart nassaj # -H other', 'systemctl_lifecycle'],
  ['systemctl restart nassaj #x -H other', 'systemctl_lifecycle'],
  ['systemctl restart nassaj -H `hostname`', 'systemctl_lifecycle'],
  ['systemctl restart nassaj -H "`hostname`"', 'systemctl_lifecycle'],
  // Round 5: the fatal rule sees a backtick-substituted option value too
  // (norm: 'either'); its accepted price is a quoted phrase read as a verb.
  ['systemctl -H `hostname` daemon-reexec', 'systemd_manager'],
  ['systemctl --message "`date`" daemon-reexec', 'systemd_manager'],
  ['systemctl --message "planned reboot" status x', 'systemd_manager'],
  ["systemctl -M '' restart nassaj", 'systemctl_lifecycle'],
  ['systemctl -H "" restart nassaj', 'systemctl_lifecycle'],
  ['systemctl isolate rescue.target # -H x', 'systemd_manager'],
  // Login sessions.
  ['loginctl terminate-user nassaj', 'session_kill'],
  ['loginctl kill-user nassaj', 'session_kill'],
  ['loginctl terminate-session 3', 'session_kill'],
  ['loginctl kill-session 3', 'session_kill'],
  // Round 2 (qa-critic veto): a remote invocation must not swallow a local one
  // after a folded LF, inside `$(…)`, or behind a stripped backtick.
  ['systemctl -H other status x\nsystemctl restart nassaj', 'systemctl_lifecycle'],
  ['systemctl -H other status x\nsystemctl stop cloudflared', 'systemctl_lifecycle'],
  ['systemctl -H other restart x $(systemctl restart nassaj)', 'systemctl_lifecycle'],
  ['systemctl -H other status `systemctl stop nginx`', 'systemctl_lifecycle'],
  ['systemctl -H other status x\n/usr/bin/systemctl --user stop cloudflared', 'systemctl_lifecycle'],
  ['systemctl -H other status x\nsystemctl reboot', 'systemd_manager'],
  // An escaped quote is a plain character in bash, not a quote opener.
  ['echo \\"; reboot; echo \\"', 'host_power'],
  ["echo it\\'s; reboot #'", 'host_power'],
  // Inside single quotes a backslash is literal: `'\'` is a complete span.
  ["echo '\\'; reboot", 'host_power'],
  // Assignment prefixes, non-numeric timeout options, a `case` branch.
  ['DEBUG=1 reboot', 'host_power'],
  ['sudo A=1 reboot', 'host_power'],
  ['timeout -s kill 5 reboot', 'host_power'],
  ['case x in x) reboot;; esac', 'host_power'],
  ['sudo -u $USER reboot', 'host_power'],
  ['env -u X reboot', 'host_power'],
  ['case x in a) b;; c) reboot;; esac', 'host_power'],
  // loginctl's own option grammar: selector and value-taking options.
  ['loginctl -M x kill-user nassaj', 'session_kill'],
  ['loginctl -s 9 kill-user nassaj', 'session_kill'],
  ['loginctl -s KILL kill-session 3', 'session_kill'],
  ['loginctl -p Name terminate-user nassaj', 'session_kill'],
  ['loginctl --kill-whom leader kill-session 3', 'session_kill'],
  ['loginctl --signal=9 kill-user nassaj', 'session_kill'],
  // Bash quoting semantics: a continuation vanishes, an escaped letter is the
  // letter, ANSI-C `\'` does not close the span.
  ['rebo\\\not', 'host_power'],
  ['reb\\oot', 'host_power'],
  ['sudo \\reboot', 'host_power'],
  ["echo $'\\'' ; reboot ; echo 'x'", 'host_power'],
  ["$'reboot'", 'host_power'],
  // Round 4: a multi-line `case` — the LF after `in` becomes `;`.
  ['case "$1" in\n  now) sudo reboot ;;\nesac', 'host_power'],
  // Round 4: systemctl's value-taking options (systemd 257 `systemctl --help`).
  ['systemctl -s SIGKILL kill x', 'systemctl_lifecycle'],
  ['systemctl --signal SIGKILL kill x', 'systemctl_lifecycle'],
  ['systemctl --kill-whom all kill nassaj', 'systemctl_lifecycle'],
  ['systemctl --kill-value 1 kill nassaj', 'systemctl_lifecycle'],
  ['systemctl -p x stop nassaj', 'systemctl_lifecycle'],
  ['systemctl -P x stop nassaj', 'systemctl_lifecycle'],
  ['systemctl --property x stop nassaj', 'systemctl_lifecycle'],
  ['systemctl --job-mode fail restart nassaj', 'systemctl_lifecycle'],
  ['systemctl -t service stop x', 'systemctl_lifecycle'],
  ['systemctl --type service stop x', 'systemctl_lifecycle'],
  ['systemctl --state active stop x', 'systemctl_lifecycle'],
  ['systemctl -C x restart nassaj', 'systemctl_lifecycle'],
  ['systemctl --capsule x restart nassaj', 'systemctl_lifecycle'],
  ['systemctl --what cache stop x', 'systemctl_lifecycle'],
  ['systemctl --legend no stop x', 'systemctl_lifecycle'],
  ['systemctl --root /x disable nassaj', 'systemctl_lifecycle'],
  ['systemctl --image x.raw disable nassaj', 'systemctl_lifecycle'],
  ['systemctl --image-policy x disable nassaj', 'systemctl_lifecycle'],
  ['systemctl --preset-mode full disable nassaj', 'systemctl_lifecycle'],
  ['systemctl -n 5 restart nassaj', 'systemctl_lifecycle'],
  ['systemctl --lines 5 restart nassaj', 'systemctl_lifecycle'],
  ['systemctl -o json restart nassaj', 'systemctl_lifecycle'],
  ['systemctl --output json restart nassaj', 'systemctl_lifecycle'],
  ['systemctl --timestamp unix restart nassaj', 'systemctl_lifecycle'],
  ['systemctl --drop-in x.conf mask nassaj', 'systemctl_lifecycle'],
  ['systemctl --when +5m reboot', 'systemd_manager'],
  ['systemctl --message "upgrade" reboot', 'systemd_manager'],
  // The quotes are dropped by normalisation, so a multi-word value only stays
  // one token on the statement-preserving copy (norm: 'either').
  ['systemctl --message "planned upgrade" reboot', 'systemd_manager'],
  ["systemctl --message 'planned upgrade' poweroff", 'systemd_manager'],
  ['systemctl --message="planned upgrade" reboot', 'systemd_manager'],
  ['systemctl -p "A B" stop nassaj', 'systemctl_lifecycle'],
  ['systemctl --check-inhibitors no reboot', 'systemd_manager'],
  ['systemctl --boot-loader-menu 5 reboot', 'systemd_manager'],
  ['systemctl --boot-loader-entry x reboot', 'systemd_manager'],
  ['systemctl --reboot-argument x reboot', 'systemd_manager'],
  ['systemctl -s SIGKILL start --no-block poweroff.target', 'systemd_manager'],
  // Round 4: the OTHER tool's name is an ordinary value (per-tool exclusion).
  ['systemctl -H loginctl restart x', 'systemctl_lifecycle'],
  ['systemctl -H loginctl reboot', 'systemd_manager'],
  ['loginctl -H systemctl terminate-user nassaj', 'session_kill'],
];

/** Must reach bash: the words appear, but not in command position, or not the fatal form. */
const T1816_MUST_ALLOW: readonly string[] = [
  'echo reboot',
  'git commit -m "fix(server): graceful shutdown on SIGTERM"',
  'git commit -m "wip; reboot handler"',
  'grep -r shutdown logs/',
  'journalctl | grep halt',
  'journalctl -b | grep -E "reboot|shutdown"',
  "grep -E 'poweroff|halt' /var/log/syslog",
  'echo "done; halt"',
  'pm2 logs | grep shutdown',
  'man shutdown',
  'which reboot',
  'rg "init 0"',
  'ls /var/run/reboot-required',
  'git init',
  'npm run init',
  'docker run --init x',
  'shutdown -c',
  'sudo shutdown -c',
  'telinit q',
  // One backslash = line continuation ⇒ `echo a reboot`.
  'echo a \\\nreboot',
  'ssh other-host sudo reboot',
  'systemctl --user status cloudflared',
  'systemctl --user daemon-reload',
  'systemctl --user start sampletwo-api',
  'systemctl reset-failed',
  'systemctl --user reload sampletwo-api',
  'loginctl list-sessions',
  'loginctl show-user nassaj',
  // The escaped quotes sit INSIDE a real double-quoted span: all data.
  'echo "\\"; reboot; echo \\""',
  // `)` closing a substitution is not command position.
  'echo $(date) reboot',
  // Escaped separators and quotes are data, not statement boundaries.
  'echo a\\;reboot',
  'echo a\\ reboot',
  "echo $'a; reboot'",
  "echo $'\\''; echo reboot",
  'loginctl -p Name show-user nassaj',
  'loginctl -s 9 list-sessions',
  // Round 4: value-taking systemctl options before a harmless verb.
  'systemctl -s SIGKILL status x',
  'systemctl -p ActiveState show nassaj',
  'systemctl --when +5m list-jobs',
  // `in` inside a word is not a `case` pattern opener.
  'echo login) reboot',
];

test('T-1816 — host power / systemd manager / session shapes deny with their own code', () => {
  for (const [cmd, code] of T1816_MUST_DENY) {
    assert.equal(findDenylistedCommand(cmd), code, `should deny as ${code}: ${JSON.stringify(cmd)}`);
  }
});

test('T-1816 — the same words outside command position stay allowed', () => {
  for (const cmd of T1816_MUST_ALLOW) {
    assert.equal(findDenylistedCommand(cmd), null, `should allow: ${JSON.stringify(cmd)}`);
  }
});

test('T-1816 — the first match wins, so a fatal rule outranks a discretionary one', () => {
  assert.equal(findDenylistedCommand('pkill -f foo; kill -9 -1'), 'kill_group');
  assert.equal(findDenylistedCommand('systemctl restart x; reboot'), 'host_power');
});

test('T-1816 — unit-directed disruption is discretionary, not fatal', () => {
  assert.equal(findDenylistedCommand('systemctl --user freeze sampletwo-api'), 'systemctl_lifecycle');
  // Reported false positive, kept on purpose: a --user exemption is deferred to
  // T-1817 (a raw-text exemption would launder `; /usr/bin/systemctl --user stop cloudflared`).
  assert.equal(findDenylistedCommand('systemctl --user restart sampletwo-api.service'), 'systemctl_lifecycle');
  // Accepted price of deferring the remote exemption (T-1817): run it from a terminal.
  assert.equal(findDenylistedCommand('systemctl -H otherhost restart nginx'), 'systemctl_lifecycle');
});

test('T-1816 — known over-block, pinned: a here-doc body is read as statements', () => {
  assert.equal(findDenylistedCommand('cat <<EOF > x.sh\nreboot\nEOF'), 'host_power');
});

test('T-1816 — dropping the redundant PREFIX wrapper chain changed no wrapper form', () => {
  assert.equal(findDenylistedCommand('env A=1 B=2 pm2 restart nassaj-dev'), 'pm2_lifecycle');
  assert.equal(findDenylistedCommand('nohup time command pkill -f x'), 'kill_by_pattern');
  assert.equal(findDenylistedCommand('builtin exec killall node'), 'kill_runtime');
  assert.equal(findDenylistedCommand('sudo env X=1 systemctl stop nginx'), 'systemctl_lifecycle');
});

// ── Rule-code extraction from SOURCE (item 9) ────────────────────────────────
// A client-side guard reads the rule codes out of the source text. Pin the
// convention it relies on: every rule's `code: '<name>'`, in any field order,
// lies between `export const RAW_DENY_RULES` and the closing `]);`, and the
// fatal block precedes the discretionary one.
const FATAL_CODES = [
  'pm2_lifecycle', 'kill_nassaj_dev', 'kill_runtime', 'kill_group', 'kill_mass',
  'kill_service_port', 'host_power', 'systemd_manager',
];
const DISCRETIONARY_CODES = [
  'systemctl_lifecycle', 'service_lifecycle', 'npm_build', 'kill_by_pattern',
  'kill_by_name', 'session_kill',
];

/** Every rule code in the RAW_DENY_RULES block, independent of field order. */
function denyRuleCodes(): Set<string> {
  const source = readFileSync(fileURLToPath(new URL('./command-board-raw.js', import.meta.url)), 'utf8');
  const start = source.indexOf('export const RAW_DENY_RULES');
  const end = source.indexOf(']);', start);
  assert.ok(start >= 0 && end > start, 'RAW_DENY_RULES block not found');
  const block = source.slice(start, end);
  return new Set([...block.matchAll(/code: '([a-z0-9_]+)'/g)].map((m) => m[1]));
}

test('T-1816 — source extraction sees every rule, including multi-field ones', () => {
  assert.deepEqual(denyRuleCodes(), new Set(RAW_DENY_RULES.map((rule) => rule.code)));
  assert.ok(denyRuleCodes().has('kill_service_port'));
  assert.ok(denyRuleCodes().has('host_power'));
});

test('T-1816 — every fatal rule precedes every discretionary rule', () => {
  const order = RAW_DENY_RULES.map((rule) => rule.code);
  assert.deepEqual(new Set(order), new Set([...FATAL_CODES, ...DISCRETIONARY_CODES]));
  const lastFatal = Math.max(...FATAL_CODES.map((code) => order.lastIndexOf(code)));
  const firstDiscretionary = Math.min(...DISCRETIONARY_CODES.map((code) => order.indexOf(code)));
  assert.ok(lastFatal < firstDiscretionary, `order: ${order.join(', ')}`);
});
