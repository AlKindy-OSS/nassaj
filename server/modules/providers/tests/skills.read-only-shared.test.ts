/**
 * T-2003 (part A) — shared skill libraries are listed read-only and never mutated.
 *
 * Pins: nassaj-shared Codex skills (ADR-202 state file) are listed `readOnly` with
 * `origin: 'nassaj-shared'`; same-named skills collapse by precedence; delete of a
 * read-only skill is a 409 `PROVIDER_SKILL_READ_ONLY` that deletes nothing; delete
 * of an app-managed writable skill still works; a symlinked state file / unsafe
 * names / symlinked skill folders are ignored; in Claude's operator library and a
 * Qwen root linked into it, only app-installed (marked) skills are deletable.
 * Member (non-owner/admin) deletes are 403 at the route: skills.role-gate.test.ts.
 *
 * Only `resolveProviderEnv` is mocked (same seam as skills.user-isolation.test.ts):
 * isolated callers get CODEX_HOME / HOME under <tempHome>/.nassaj-users/<id>.
 *
 * Runner: TMPDIR=/var/tmp node scripts/run-isolated-node-tests.mjs server \
 *           server/modules/providers/tests/skills.read-only-shared.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const resolveProviderEnvUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../../services/isolation/resolve-provider-env.js'),
).href;

const resolveProviderEnvStandIn = (
  userId: string | number | null,
  provider: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const env = { ...baseEnv, HOME: os.homedir() };
  delete env.CODEX_HOME;
  if (userId === null || userId === undefined || userId === '') return env;
  const userRoot = path.join(os.homedir(), '.nassaj-users', String(userId));
  if (provider === 'codex') env.CODEX_HOME = path.join(userRoot, '.codex');
  if (provider === 'qwen') env.HOME = userRoot;
  return env;
};

mock.module(resolveProviderEnvUrl, {
  namedExports: {
    resolveProviderEnv: resolveProviderEnvStandIn,
    resolveCatalogEnv: resolveProviderEnvStandIn,
  },
});

const { providerSkillsService } = await import('../services/skills.service.js');

const MARKER_FILE = '.nassaj-skill.json';
const STATE_FILE = '.nassaj-sync-state.json';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

const writeSkill = async (root: string, name: string, body = 'Body.'): Promise<string> => {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`,
    'utf8',
  );
  return dir;
};

const writeState = async (skillsRoot: string, skills: unknown[]): Promise<void> => {
  await fs.mkdir(skillsRoot, { recursive: true });
  await fs.writeFile(path.join(skillsRoot, STATE_FILE), JSON.stringify({ skills }), 'utf8');
};

const exists = async (target: string): Promise<boolean> =>
  fs.lstat(target).then(() => true, () => false);

const expectReadOnly = (error: Error & { code?: string; statusCode?: number }): boolean => {
  assert.equal(error.code, 'PROVIDER_SKILL_READ_ONLY');
  assert.equal(error.statusCode, 409);
  return true;
};

/** Runs one test body inside a fresh temp HOME with a workspace folder. */
const withTempHome = async (
  label: string,
  body: (home: string, workspacePath: string) => Promise<void>,
): Promise<void> => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `skills-ro-${label}-`));
  const restore = patchHomeDir(home);
  try {
    const workspacePath = path.join(home, 'workspace');
    await fs.mkdir(workspacePath, { recursive: true });
    await body(home, workspacePath);
  } finally {
    restore();
    await fs.rm(home, { recursive: true, force: true });
  }
};

test('codex lists owned nassaj-shared skills read-only for an isolated user', { concurrency: false }, async () => {
  await withTempHome('codex-list', async (home, workspacePath) => {
    const skillsRoot = path.join(home, '.nassaj-users', '7', '.codex', 'skills');
    await writeSkill(skillsRoot, 'shared-alpha');
    await writeSkill(skillsRoot, 'not-owned');
    await writeSkill(path.join(skillsRoot, '.system'), 'system-skill');
    await writeState(skillsRoot, ['shared-alpha', 'missing-one']);

    const skills = await providerSkillsService.listProviderSkills('codex', { workspacePath, userId: 7 });
    const alpha = skills.find((skill) => skill.name === 'shared-alpha');
    assert.equal(alpha?.readOnly, true);
    assert.equal(alpha?.origin, 'nassaj-shared');
    assert.equal(alpha?.scope, 'user');
    assert.equal(alpha?.command, '$shared-alpha');
    assert.equal(skills.some((skill) => skill.name === 'not-owned'), false, 'unowned folder hidden');
    assert.equal(skills.some((skill) => skill.name === 'missing-one'), false);
    const system = skills.find((skill) => skill.name === 'system-skill');
    assert.equal(system?.scope, 'system');
    assert.equal(system?.readOnly, undefined);
  });
});

test('symlinked state file, unsafe names and symlinked skill folders are ignored', { concurrency: false }, async () => {
  await withTempHome('codex-unsafe', async (home, workspacePath) => {
    const skillsRoot = path.join(home, '.nassaj-users', '8', '.codex', 'skills');
    const elsewhere = path.join(home, 'elsewhere');
    await writeSkill(elsewhere, 'linked-target');
    await writeSkill(skillsRoot, 'real-one');
    await fs.symlink(path.join(elsewhere, 'linked-target'), path.join(skillsRoot, 'linked-skill'));
    await writeSkill(skillsRoot, '.hidden');
    await writeState(skillsRoot, ['real-one', 'linked-skill', '../escape', '.hidden', 42, null]);

    let names = (await providerSkillsService.listProviderSkills('codex', { workspacePath, userId: 8 }))
      .filter((skill) => skill.origin === 'nassaj-shared').map((skill) => skill.name);
    assert.deepEqual(names, ['real-one']);

    // Replace the state file with a symlink to an otherwise valid state document.
    await writeState(elsewhere, ['real-one']);
    await fs.rm(path.join(skillsRoot, STATE_FILE));
    await fs.symlink(path.join(elsewhere, STATE_FILE), path.join(skillsRoot, STATE_FILE));
    names = (await providerSkillsService.listProviderSkills('codex', { workspacePath, userId: 8 }))
      .filter((skill) => skill.origin === 'nassaj-shared').map((skill) => skill.name);
    assert.deepEqual(names, [], 'a symlinked state file is never trusted');
  });
});

test('same-named skills collapse by precedence repo > user > nassaj-shared > system', { concurrency: false }, async () => {
  await withTempHome('codex-dedup', async (home, workspacePath) => {
    const codexSkills = path.join(home, '.nassaj-users', '9', '.codex', 'skills');
    await writeSkill(codexSkills, 'dup-a');
    await writeSkill(codexSkills, 'dup-b');
    await writeSkill(codexSkills, 'only-shared');
    await writeState(codexSkills, ['dup-a', 'dup-b', 'only-shared']);
    await writeSkill(path.join(codexSkills, '.system'), 'only-shared');
    await writeSkill(path.join(home, '.agents', 'skills'), 'dup-a');
    await writeSkill(path.join(workspacePath, '.agents', 'skills'), 'dup-b');

    const skills = await providerSkillsService.listProviderSkills('codex', { workspacePath, userId: 9 });
    const byName = (name: string) => skills.filter((skill) => skill.name === name);
    assert.equal(byName('dup-a').length, 1);
    assert.equal(byName('dup-a')[0].readOnly, undefined, 'private user skill wins over shared');
    assert.equal(byName('dup-b').length, 1);
    assert.equal(byName('dup-b')[0].scope, 'repo', 'repo skill wins over everything');
    assert.equal(byName('only-shared').length, 1);
    assert.equal(byName('only-shared')[0].origin, 'nassaj-shared', 'shared wins over system');
  });
});

test('deleting a nassaj-shared codex skill is 409 and deletes nothing', { concurrency: false }, async () => {
  await withTempHome('codex-delete-ro', async (home) => {
    const skillsRoot = path.join(home, '.nassaj-users', '7', '.codex', 'skills');
    const dir = await writeSkill(skillsRoot, 'shared-alpha');
    await writeState(skillsRoot, ['shared-alpha']);

    await assert.rejects(
      () => providerSkillsService.removeProviderSkill('codex', 'shared-alpha', { userId: 7 }),
      expectReadOnly,
    );
    assert.equal(await exists(path.join(dir, 'SKILL.md')), true);

    // A name in no source at all is still a plain 404.
    await assert.rejects(
      () => providerSkillsService.removeProviderSkill('codex', 'nowhere', { userId: 7 }),
      (error: Error & { code?: string }) => error.code === 'PROVIDER_SKILL_NOT_FOUND',
    );
  });
});

test('a symlinked skill folder: unmarked is 409; marked removes the link only', { concurrency: false }, async () => {
  await withTempHome('codex-delete-link', async (home) => {
    const writableRoot = path.join(home, '.agents', 'skills');
    await fs.mkdir(writableRoot, { recursive: true });
    const unmarked = await writeSkill(path.join(home, 'shared-lib'), 'plain');
    await fs.symlink(unmarked, path.join(writableRoot, 'plain'));
    await assert.rejects(() => providerSkillsService.removeProviderSkill('codex', 'plain'), expectReadOnly);
    assert.equal(await exists(path.join(writableRoot, 'plain')), true);
    assert.equal(await exists(path.join(unmarked, 'SKILL.md')), true);

    const marked = await writeSkill(path.join(home, 'shared-lib'), 'linked');
    await fs.writeFile(path.join(marked, MARKER_FILE), '{"managedBy":"nassaj"}', 'utf8');
    await fs.symlink(marked, path.join(writableRoot, 'linked'));
    await providerSkillsService.removeProviderSkill('codex', 'linked');
    assert.equal(await exists(path.join(writableRoot, 'linked')), false, 'link removed');
    assert.equal(await exists(path.join(marked, 'SKILL.md')), true, 'target never touched');
    assert.equal(await exists(path.join(marked, MARKER_FILE)), true);
  });
});

test('deleting an app-managed writable codex skill still works', { concurrency: false }, async () => {
  await withTempHome('codex-delete-ok', async (home) => {
    const [installed] = await providerSkillsService.addProviderSkills('codex', {
      entries: [{ directoryName: 'mine', content: '---\nname: mine\ndescription: d\n---\n\nBody.\n' }],
    });
    assert.ok(installed.sourcePath.startsWith(path.join(home, '.agents', 'skills')));
    const removed = await providerSkillsService.removeProviderSkill('codex', 'mine');
    assert.equal(removed.name, 'mine');
    assert.equal(await exists(path.dirname(installed.sourcePath)), false);
  });
});

test('claude library: per-skill readOnly follows the app marker; origin is a tag', { concurrency: false }, async () => {
  await withTempHome('claude', async (home, workspacePath) => {
    const libraryRoot = path.join(home, '.claude', 'skills');
    const handmade = await writeSkill(libraryRoot, 'core-skill');
    const appDir = await writeSkill(libraryRoot, 'app-skill');
    await fs.writeFile(path.join(appDir, MARKER_FILE), '{"managedBy":"nassaj"}', 'utf8');
    await writeSkill(path.join(workspacePath, '.claude', 'skills'), 'project-skill');

    const skills = await providerSkillsService.listProviderSkills('claude', { workspacePath });
    const core = skills.find((skill) => skill.name === 'core-skill');
    assert.equal(core?.readOnly, true, 'hand-authored library skill is read-only');
    assert.equal(core?.origin, 'operator-shared');
    const app = skills.find((skill) => skill.name === 'app-skill');
    assert.equal(app?.readOnly, undefined, 'app-installed library skill is deletable');
    assert.equal(app?.origin, 'operator-shared');
    assert.equal(skills.find((skill) => skill.name === 'project-skill')?.origin, undefined);

    await assert.rejects(() => providerSkillsService.removeProviderSkill('claude', 'core-skill'), expectReadOnly);
    assert.equal(await exists(path.join(handmade, 'SKILL.md')), true);
    await providerSkillsService.removeProviderSkill('claude', 'app-skill');
    assert.equal(await exists(appDir), false);
  });
});

test('dedup keys on frontmatter name, case-sensitively', { concurrency: false }, async () => {
  await withTempHome('dedup-case', async (home, workspacePath) => {
    const userRoot = path.join(home, '.agents', 'skills');
    await writeSkill(userRoot, 'Mixed');
    await writeSkill(path.join(workspacePath, '.agents', 'skills'), 'mixed');
    // Folder name differs, frontmatter name collides with the repo skill.
    const renamed = path.join(userRoot, 'folder-x');
    await fs.mkdir(renamed, { recursive: true });
    await fs.writeFile(path.join(renamed, 'SKILL.md'), '---\nname: mixed\ndescription: d\n---\n\nB.\n');

    const skills = await providerSkillsService.listProviderSkills('codex', { workspacePath });
    assert.equal(skills.filter((skill) => skill.name === 'Mixed').length, 1, 'case differs: kept');
    const lower = skills.filter((skill) => skill.name === 'mixed');
    assert.equal(lower.length, 1);
    assert.equal(lower[0].scope, 'repo');
  });
});

test('qwen root linked into the shared library: tagged, per-skill readOnly by marker', { concurrency: false }, async () => {
  await withTempHome('qwen', async (home, workspacePath) => {
    const sharedRoot = path.join(home, '.qwen', 'skills');
    const handmade = await writeSkill(sharedRoot, 'shared-q');
    const appDir = await writeSkill(sharedRoot, 'app-q');
    await fs.writeFile(path.join(appDir, MARKER_FILE), '{"managedBy":"nassaj"}', 'utf8');
    const member = path.join(home, '.nassaj-users', '4');
    await fs.mkdir(member, { recursive: true });
    await fs.symlink(path.join(home, '.qwen'), path.join(member, '.qwen'));

    const listed = await providerSkillsService.listProviderSkills('qwen', { workspacePath, userId: 4 });
    const shared = listed.find((skill) => skill.name === 'shared-q');
    assert.equal(shared?.readOnly, true);
    assert.equal(shared?.origin, 'operator-shared');
    assert.equal(listed.find((skill) => skill.name === 'app-q')?.readOnly, undefined);
    await assert.rejects(
      () => providerSkillsService.removeProviderSkill('qwen', 'shared-q', { userId: 4 }),
      expectReadOnly,
    );
    assert.equal(await exists(path.join(handmade, 'SKILL.md')), true);
    await providerSkillsService.removeProviderSkill('qwen', 'app-q', { userId: 4 });
    assert.equal(await exists(appDir), false);

    // A legacy REAL per-user folder is untagged; the B-175 marker guard applies.
    const realMember = path.join(home, '.nassaj-users', '6', '.qwen', 'skills');
    const ownDir = await writeSkill(realMember, 'own-q');
    await fs.writeFile(path.join(ownDir, MARKER_FILE), '{"managedBy":"nassaj"}', 'utf8');
    const own = await providerSkillsService.listProviderSkills('qwen', { workspacePath, userId: 6 });
    assert.equal(own.find((skill) => skill.name === 'own-q')?.origin, undefined);
    await providerSkillsService.removeProviderSkill('qwen', 'own-q', { userId: 6 });
    assert.equal(await exists(ownDir), false);
  });
});
