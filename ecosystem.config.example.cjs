// Public PM2 example for a self-hosted Nassaj node.
//
// Host-specific values and secrets belong in the host environment or its
// untracked .env / config/node.env file. The entry is always an explicit
// absolute path so this example cannot silently fall back to another tree.
//
// Two install layouts share this one PM2 contract (scripts/lib/pm2-install-layout.cjs):
//
//   git-checkout-v2 (default) — PM2 runs `<app root>/dist-server/server/index.js`
//     with cwd = the app root, the tree the governed updater moves. The app root
//     is the directory holding this file.
//
//   artifact-runtime-v2 (NASSAJ_INSTALL_LAYOUT=artifact-runtime-v2) — PM2 must
//     start `<NASSAJ_DEPLOY_ROOT>/launcher/pm2-entry.mjs`, never
//     `nassaj-release-launcher.mjs` directly: fork mode loads the script inside
//     PM2's own CommonJS container, so the launcher's `argv[1]` guard never
//     fires and PM2 reports a healthy process that binds no port (ADR-156, WI-9).
//     The entry boots only a sealed release store (`current` symlink,
//     `releases/<generation>`, `runtime-generation.json`); pointing a git
//     checkout at it produces a node that never starts (qa-critic C3).

const os = require('node:os');
const path = require('node:path');

const { RELEASE_LAYOUT, expectedPm2Entry, resolveInstallLayout } = require('./scripts/lib/pm2-install-layout.cjs');

const layout = resolveInstallLayout(process.env.NASSAJ_INSTALL_LAYOUT);
const deployRoot = process.env.NASSAJ_DEPLOY_ROOT;
if (layout === RELEASE_LAYOUT && (!deployRoot || !path.isAbsolute(deployRoot))) {
  throw new Error('NASSAJ_DEPLOY_ROOT must be an absolute installed-release path');
}
const entry = expectedPm2Entry({ layout, appRoot: __dirname, deployRoot });

const port = process.env.SERVER_PORT || process.env.NASSAJ_PORT || '3004';
const openCodeBin = path.join(os.homedir(), '.opencode', 'bin');
const inheritedPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
const executablePath = inheritedPath.split(':').includes(openCodeBin)
  ? inheritedPath
  : `${inheritedPath}:${openCodeBin}`;

module.exports = {
  apps: [
    {
      name: process.env.PROC_NAME || process.env.NASSAJ_PROCESS_NAME || 'nassaj-dev',
      script: entry.script,
      ...(entry.cwd ? { cwd: entry.cwd } : {}),
      args: `--port ${port}`,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      exp_backoff_restart_delay: 1000,

      // These values are the public safe-drain contract. PM2 signals only the
      // parent, while a long-running child can complete before the parent exits.
      treekill: false,
      kill_timeout: 86400000,
      stop_exit_codes: [75],

      watch: false,
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS Z',
      env: {
        NODE_ENV: 'production',
        NASSAJ_INSTALL_LAYOUT: layout,
        // Pinned from the environment that evaluates this file (the shell running
        // `pm2 start`), so the supervised process keeps that release even if the
        // PM2 daemon's own environment carries a different value or none at all.
        ...(layout === RELEASE_LAYOUT ? { NASSAJ_DEPLOY_ROOT: deployRoot } : {}),
        PATH: executablePath,
        SESSION_REGISTRY_claude: '1',
        WORKFLOW_RECONCILE: '1',
        WORKFLOW_SUPERVISOR: '1',
        NASSAJ_COORDINATOR: '1',
        DRAIN_TIMEOUT_MS: '0',
        // B-881: build tmpdir must be on disk — /tmp is tmpfs; the git updater refuses tmpfs.
        TMPDIR: '/var/tmp',
        LISTEN_BIND_WINDOW_MS: '10000',
      },
    },
  ],
};
