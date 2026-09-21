'use strict';
/**
 * The one definition of what PM2 must start for each install layout (ADR-156).
 *
 * Three readers need the same answer and must never disagree: the tracked
 * `ecosystem.config.example.cjs`, the ecosystem that `scripts/install-node.mjs`
 * generates from it, and the update pre-flight's `pm2_entry` code. A second copy
 * of this rule is how a node was installed with a script it could not boot
 * (qa-critic C3): the git-checkout installer inherited the sealed-release entry.
 *
 *   git-checkout-v2      the default. The app root IS the working tree the
 *                        updater moves; PM2 runs the built server from it with
 *                        cwd = app root, so `.env`, the doctor's service-account
 *                        check and the pre-flight all find the same process.
 *   artifact-runtime-v2  opt-in. PM2 starts the release-borne `pm2-entry.mjs`,
 *                        which boots only a sealed release store (`current`
 *                        symlink, `releases/<generation>`, a generation seal).
 *
 * تعريف واحد لما يشغّله pm2 في كل نمط تثبيت، يقرؤه ملف ecosystem والمثبّت
 * والفحص المسبق معاً فلا يختلفون.
 */
const path = require('node:path');

const GIT_CHECKOUT_LAYOUT = 'git-checkout-v2';
const RELEASE_LAYOUT = 'artifact-runtime-v2';
const INSTALL_LAYOUTS = Object.freeze([GIT_CHECKOUT_LAYOUT, RELEASE_LAYOUT]);
/** The built server entry of a git checkout, relative to the app root. */
const GIT_SERVER_ENTRY = path.join('dist-server', 'server', 'index.js');
/** The release-borne PM2 entry, relative to the deploy root. */
const RELEASE_PM2_ENTRY = path.join('launcher', 'pm2-entry.mjs');

/** Normalize the layout flag; an unknown value is refused rather than defaulted. */
function resolveInstallLayout(value) {
  const layout = value || GIT_CHECKOUT_LAYOUT;
  if (!INSTALL_LAYOUTS.includes(layout)) {
    throw new Error(`Unknown install layout "${layout}"; expected one of ${INSTALL_LAYOUTS.join(', ')}`);
  }
  return layout;
}

function requireAbsolute(name, value) {
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

/**
 * The `{ script, cwd }` PM2 must run for a layout. `cwd` is null for the release
 * layout: the launcher takes its root from `NASSAJ_DEPLOY_ROOT`, not from cwd.
 */
function expectedPm2Entry({ layout, appRoot, deployRoot } = {}) {
  const resolved = resolveInstallLayout(layout);
  if (resolved === RELEASE_LAYOUT) {
    const root = requireAbsolute('NASSAJ_DEPLOY_ROOT', deployRoot);
    return { layout: resolved, script: path.join(root, RELEASE_PM2_ENTRY), cwd: null };
  }
  const root = requireAbsolute('The app root', appRoot);
  return { layout: resolved, script: path.join(root, GIT_SERVER_ENTRY), cwd: root };
}

module.exports = {
  GIT_CHECKOUT_LAYOUT,
  RELEASE_LAYOUT,
  INSTALL_LAYOUTS,
  GIT_SERVER_ENTRY,
  RELEASE_PM2_ENTRY,
  resolveInstallLayout,
  expectedPm2Entry,
};
