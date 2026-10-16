/**
 * T-2037 — composer shell risk classification (advisory; the server decides).
 * Run: NODE_ENV=test npx vitest run src/components/chat/utils/shellCommandRisk.test.ts
 */
import { describe, expect, it } from 'vitest';

import { classifyShellCommand, needsShellConfirm } from './shellCommandRisk';

describe('classifyShellCommand', () => {
  it.each([
    ['pm2 restart nassaj-dev', 'pm2_lifecycle'],
    ['sudo systemctl restart nginx', 'systemctl_lifecycle'],
    ['kill -9 1234', 'kill'],
    ['ls && kill 1', 'kill'],
    ['sudo reboot', 'host_power'],
    ['shutdown -h now', 'host_power'],
    ['HALT', 'host_power'],
    ['poweroff', 'host_power'],
    ['/usr/bin/pm2 restart all', 'pm2_lifecycle'],
    ['/sbin/reboot', 'host_power'],
    ['/bin/kill -9 7', 'kill'],
    ['sudo /usr/bin/systemctl stop x', 'systemctl_lifecycle'],
    ['echo ok;kill 3', 'kill'],
  ])('%s → danger %s', (command, rule) => {
    const risk = classifyShellCommand(command);
    expect(risk.danger).toBe(rule);
    expect(risk.blocked).toBeNull();
    expect(needsShellConfirm(risk)).toBe(true);
  });

  it.each(['pkill vite', 'killall node', 'sudo pkill -f server', 'ls; killall x', '/usr/bin/pkill vite', '/usr/bin/killall node'])(
    '%s is blocked (kill_by_name) and never offered a confirm',
    (command) => {
      const risk = classifyShellCommand(command);
      expect(risk.blocked).toBe('kill_by_name');
      expect(needsShellConfirm(risk)).toBe(false);
    },
  );

  it.each(['ls -la', 'git status', 'echo skill', 'cat ./kill.log', 'npm ci', 'ls /tmp', 'cat /var/log/pm2.log', 'ls /usr/bin/pm2x'])(
    '%s needs no confirm',
    (command) => {
      const risk = classifyShellCommand(command);
      expect(risk).toEqual({ blocked: null, danger: null, tmpfs: false });
      expect(needsShellConfirm(risk)).toBe(false);
    },
  );

  it.each([
    'cd /tmp && npm ci',
    'npm install --prefix /tmp/x',
    'TMPDIR=/tmp npm run build',
    'git clone https://x/y.git /dev/shm/y',
    'npx playwright install --path /tmp',
    'git worktree add /tmp/wt',
  ])('%s → tmpfs warning confirm', (command) => {
    const risk = classifyShellCommand(command);
    expect(risk.tmpfs).toBe(true);
    expect(needsShellConfirm(risk)).toBe(true);
  });

  it('TMPDIR=/var/tmp is not tmpfs', () => {
    expect(classifyShellCommand('TMPDIR=/var/tmp npm run build').tmpfs).toBe(false);
  });
});
