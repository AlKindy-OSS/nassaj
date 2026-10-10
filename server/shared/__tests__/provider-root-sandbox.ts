import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * B-1564: history readers refuse transcripts outside their provider root, so
 * fixtures must live under the (sandbox) HOME's provider trees. These helpers
 * create a fresh directory there, and refuse to run when HOME is the real
 * account home (the passwd entry), so a direct `node --test` outside the
 * isolated runner can never write into live provider state.
 */
function sandboxHome(): string {
  const home = fs.realpathSync(os.homedir());
  if (home === fs.realpathSync(os.userInfo().homedir)) {
    throw new Error('provider-root-sandbox: HOME is the real account home; run under the isolated test runner');
  }
  return home;
}

function freshDirUnder(root: string, prefix: string): string {
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

/** A fresh directory under `~/.codex/sessions` (the operator Codex history root). */
export function codexSessionsSandbox(prefix: string): string {
  return freshDirUnder(path.join(sandboxHome(), '.codex', 'sessions'), prefix);
}

/** A fresh directory under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects` (the Claude history root). */
export function claudeProjectsSandbox(prefix: string): string {
  const home = sandboxHome();
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  if (!fs.realpathSync(path.dirname(configDir)).startsWith(home)) {
    throw new Error('provider-root-sandbox: CLAUDE_CONFIG_DIR is outside the sandbox HOME');
  }
  return freshDirUnder(path.join(configDir, 'projects'), prefix);
}
