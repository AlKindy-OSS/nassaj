/**
 * B-823: Claude transcript-path resolution.
 *
 * The token-usage route used to re-derive the transcript location from the
 * PROJECT (`<claude home>/projects/<encoded project_path>/<sessionId>.jsonl`).
 * A session launched inside a nassaj session overlay runs with cwd
 * `<repo>/.git/nassaj-session-overlays/instances/<id>/workspace`, so Claude
 * writes under the overlay-encoded directory while the session row still names
 * the repo project — the derived path names a file that never existed, the route
 * answered 404, and the client rendered "No token usage yet".
 *
 * Contract under test:
 * 1. `jsonl_path` wins, so an overlay session resolves even though the
 *    project-derived path is absent (asserted absent, so the old derivation is
 *    provably the failing one).
 * 2. Containment is checked on the REALPATH. The fixture models `~/.claude` as
 *    a symlink and database rows may spell the same path both ways, so
 *    a textual prefix test would reject valid transcripts.
 * 3. The encoded path stays as the fallback for rows the synchronizer has not
 *    indexed yet.
 * 4. `jsonl_path` is a DB column: a path outside every Claude projects root, a
 *    planted symlink that escapes one, and a file belonging to another session
 *    are all refused, so this never becomes an arbitrary-file-read primitive.
 *
 * Scratch lives under /var/tmp — never /tmp, which is tmpfs on this host.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { resolveClaudeTranscriptPath } from '@/modules/providers/list/claude/claude-transcript-path.js';

const SCRATCH_ROOT = '/var/tmp';
const PROJECT_PATH = '/var/tmp/x/repo';
const OVERLAY_PATH = `${PROJECT_PATH}/.git/nassaj-session-overlays/instances/abc/workspace`;
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_SESSION_ID = '33333333-3333-4333-8333-333333333333';
const PLANTED_SESSION_ID = '44444444-4444-4444-8444-444444444444';

const encode = (value: string) => value.replace(/[^a-zA-Z0-9-]/g, '-');

type Fixture = {
  /** `<base>/core/projects` — where Claude really writes. */
  realProjects: string;
  /** `<scratch-home>/.claude/projects` — the same directory through a symlink. */
  linkedProjects: string;
  /** A directory under no Claude projects root at all. */
  outside: string;
  overlayTranscript: string;
  cleanup: () => Promise<void>;
};

async function buildFixture(): Promise<Fixture> {
  const base = await realpath(await mkdtemp(path.join(SCRATCH_ROOT, 'claude-transcript-path-')));
  const realProjects = path.join(base, 'core', 'projects');
  const home = path.join(base, 'home');
  const outside = path.join(base, 'outside');

  const overlayDir = path.join(realProjects, encode(OVERLAY_PATH));
  const projectDir = path.join(realProjects, encode(PROJECT_PATH));
  await mkdir(overlayDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(outside, { recursive: true });

  // Model a symlinked provider home without retaining any host-specific target.
  await symlink(path.join(base, 'core'), path.join(home, '.claude'));

  const overlayTranscript = path.join(overlayDir, `${SESSION_ID}.jsonl`);
  await writeFile(overlayTranscript, '{"type":"assistant"}\n');
  await writeFile(path.join(projectDir, `${OTHER_SESSION_ID}.jsonl`), '{"type":"assistant"}\n');
  await writeFile(path.join(outside, `${PLANTED_SESSION_ID}.jsonl`), 'secret\n');

  // A symlink INSIDE a projects root whose target escapes it.
  await symlink(
    path.join(outside, `${PLANTED_SESSION_ID}.jsonl`),
    path.join(overlayDir, `${PLANTED_SESSION_ID}.jsonl`),
  );

  const previousHome = process.env.HOME;
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  delete process.env.CLAUDE_CONFIG_DIR;

  return {
    realProjects,
    linkedProjects: path.join(home, '.claude', 'projects'),
    outside,
    overlayTranscript,
    cleanup: async () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
      await rm(base, { recursive: true, force: true });
    },
  };
}

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const fixture = await buildFixture();
  try {
    await run(fixture);
  } finally {
    await fixture.cleanup();
  }
}

test('resolves an overlay session from jsonl_path when the project-derived path is absent', async () => {
  await withFixture(async (fixture) => {
    const derived = path.join(fixture.realProjects, encode(PROJECT_PATH), `${SESSION_ID}.jsonl`);
    await assert.rejects(realpath(derived), 'the project-derived path must not exist for this session');

    const resolved = await resolveClaudeTranscriptPath(
      { session_id: SESSION_ID, project_path: PROJECT_PATH, jsonl_path: fixture.overlayTranscript },
      null,
    );

    assert.strictEqual(resolved, fixture.overlayTranscript);
  });
});

test('accepts a jsonl_path spelled through the symlinked Claude home', async () => {
  await withFixture(async (fixture) => {
    const linked = path.join(fixture.linkedProjects, encode(OVERLAY_PATH), `${SESSION_ID}.jsonl`);

    const resolved = await resolveClaudeTranscriptPath(
      { session_id: SESSION_ID, project_path: PROJECT_PATH, jsonl_path: linked },
      null,
    );

    assert.strictEqual(resolved, fixture.overlayTranscript);
  });
});

test('falls back to the project-encoded path when jsonl_path is empty', async () => {
  await withFixture(async (fixture) => {
    const resolved = await resolveClaudeTranscriptPath(
      { session_id: OTHER_SESSION_ID, project_path: PROJECT_PATH, jsonl_path: '' },
      null,
    );

    assert.strictEqual(
      resolved,
      path.join(fixture.realProjects, encode(PROJECT_PATH), `${OTHER_SESSION_ID}.jsonl`),
    );
  });
});

test('refuses a jsonl_path outside every Claude projects root', async () => {
  await withFixture(async () => {
    const resolved = await resolveClaudeTranscriptPath(
      { session_id: SESSION_ID, project_path: PROJECT_PATH, jsonl_path: '/etc/passwd' },
      null,
    );

    assert.strictEqual(resolved, null);
  });
});

test('refuses a planted symlink whose target escapes the projects root', async () => {
  await withFixture(async (fixture) => {
    const planted = path.join(
      fixture.realProjects,
      encode(OVERLAY_PATH),
      `${PLANTED_SESSION_ID}.jsonl`,
    );

    const resolved = await resolveClaudeTranscriptPath(
      { session_id: PLANTED_SESSION_ID, project_path: PROJECT_PATH, jsonl_path: planted },
      null,
    );

    assert.strictEqual(resolved, null);
  });
});

test('refuses a jsonl_path naming another session transcript', async () => {
  await withFixture(async (fixture) => {
    const foreign = path.join(
      fixture.realProjects,
      encode(PROJECT_PATH),
      `${OTHER_SESSION_ID}.jsonl`,
    );

    const resolved = await resolveClaudeTranscriptPath(
      { session_id: SESSION_ID, project_path: PROJECT_PATH, jsonl_path: foreign },
      null,
    );

    assert.strictEqual(resolved, null);
  });
});

test('refuses a session id that carries path separators', async () => {
  await withFixture(async () => {
    const resolved = await resolveClaudeTranscriptPath(
      { session_id: '../../../etc/passwd', project_path: PROJECT_PATH, jsonl_path: '' },
      null,
    );

    assert.strictEqual(resolved, null);
  });
});
