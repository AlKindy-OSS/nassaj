/**
 * ADR-226: CommonJS source a fake `opencode` executable embeds to play the nassaj
 * channel-client plugin's part, as the real plugin does inside opencode:
 *  - opens fd 3 (the server's socketpair), waits for the challenge, answers with a hello
 *    carrying the nonce, the sha256 of the plugin file named first in OPENCODE_CONFIG_CONTENT
 *    and the protocol, and waits for the server's acceptance;
 *  - then reads the prompt the server writes to stdin into `globalThis.FAKE_OPENCODE_PROMPT`.
 * The rest of the fake runs only after `await globalThis.FAKE_OPENCODE_READY`.
 * Set FAKE_OPENCODE_SKIP_HELLO=1 in the server env to simulate a plugin that never loaded
 * (the fake then waits on stdin forever, as opencode would without a prompt).
 */
import fs from 'node:fs';
import path from 'node:path';

export const FAKE_OPENCODE_PARITY_PRELUDE = `
globalThis.FAKE_OPENCODE_READY = (async () => {
  const parityFs = require('fs');
  const parityNet = require('net');
  const parityCrypto = require('crypto');
  const parityUrl = require('url');
  const readStdin = () => new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { text += d; });
    process.stdin.on('end', () => resolve(text));
  });
  if (process.env.FAKE_OPENCODE_SKIP_HELLO === '1') { await new Promise(() => {}); }
  let inline = {};
  try { inline = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}'); } catch {}
  const plugin = Array.isArray(inline.plugin) ? inline.plugin[0] : null;
  const digest = plugin ? parityCrypto.createHash('sha256').update(parityFs.readFileSync(parityUrl.fileURLToPath(plugin))).digest('hex') : '';
  const socket = new parityNet.Socket({ fd: 3, readable: true, writable: true });
  socket.on('error', () => {});
  await new Promise((resolve) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\\n'); at >= 0; at = buffer.indexOf('\\n')) {
        const frame = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        if (frame.type === 'challenge') {
          socket.write(JSON.stringify({ type: 'hello', id: 'h1', nonce: frame.nonce, pluginDigest: digest, protocol: 'nassaj-opencode-parity/1' }) + '\\n');
        } else if (frame.id === 'h1') resolve(frame);
      }
    });
  });
  globalThis.FAKE_OPENCODE_PROMPT = await readStdin();
  socket.destroy();
})();
`;

/**
 * ADR-226: a real spawnOpenCode builds the member's Claude-parity engine from Claude's
 * settings, including this host's managed policy (/etc/claude-code). The engine refuses
 * when a plugin that policy enables is not installed for the member (Claude would load its
 * hooks), so a spawn test installs every such plugin, hook-free, in the member's Claude tree.
 * @param sandboxHome the test's sandbox HOME
 * @param memberId the member the turn runs for
 * @param managedFile the managed settings Claude reads on this host
 */
export function installManagedClaudePlugins(sandboxHome: string, memberId: number,
  managedFile = '/etc/claude-code/managed-settings.json'): void {
  let enabled: Record<string, unknown> = {};
  try {
    enabled = JSON.parse(fs.readFileSync(managedFile, 'utf8'))?.enabledPlugins ?? {};
  } catch { /* no managed policy on this host */ }
  const configDir = path.join(sandboxHome, '.nassaj-users', String(memberId), '.claude');
  const plugins = Object.fromEntries(Object.keys(enabled).map((id) => {
    const installPath = path.join(sandboxHome, '.parity-test-plugins', id.replace(/[^A-Za-z0-9]/g, '_'));
    fs.mkdirSync(installPath, { recursive: true });
    return [id, [{ installPath }]];
  }));
  fs.mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins }));
}

type FakeChild = { stdin?: { end?: (text: string) => void } | null; kill: (signal?: string) => boolean };

/**
 * ADR-226: stand-ins for the parity seams of spawnOpenCode in suites that mock
 * child_process with an in-memory child (no fd 3, no real plugin). The launch resolves to
 * Claude's default with L1 = allow-all; the turn writes the prompt to the child's stdin at
 * once, as the real runtime does after an accepted hello.
 */
export const fakeOpenCodePermissionParity = () => ({
  claudeMode: 'default', args: [] as string[], permission: '{"*":"allow"}',
  createEngine: () => ({ decideTool: async () => ({ decision: 'deny' }), userPromptSubmit: async () => ({ blocked: false }) }),
});

export const fakeOpenCodeParityRuntime = {
  OPENCODE_RUNTIME_CODES: { notLoaded: 'opencode_parity_not_loaded', violation: 'opencode_policy_violation' },
  OPENCODE_RUNTIME_TEXT: {},
  auditProviderCageNotApplied: () => undefined,
  prepareOpenCodeParityTurn: () => ({}),
  startOpenCodeParityTurn: (_prepared: unknown, input: { child: FakeChild; prompt: string }) => {
    input.child.stdin?.end?.(input.prompt);
    return {
      released: Promise.resolve({ ok: true }),
      onStdoutEvent: () => undefined,
      finish: async () => null,
      violation: null,
      stop: () => { input.child.kill('SIGTERM'); },
    };
  },
};
