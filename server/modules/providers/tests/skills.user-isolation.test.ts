/**
 * B-153 — per-user skill discovery for providers with an isolated config home.
 *
 * B-136 isolated the Codex SPAWN env (CODEX_HOME=~/.nassaj-users/<userId>/.codex)
 * and B-152 taught the synchronizer/watcher/auth/models providers to read from it,
 * but the SKILLS facet was left behind: `IProviderSkills`/`ProviderSkillListOptions`
 * carried no caller identity, so `CodexSkillsProvider` hard-coded the operator's
 * `~/.codex/skills/.system`. Every isolated user was therefore shown the OPERATOR's
 * system skills and never their own.
 *
 * These tests pin the plumbing end to end at the service boundary:
 *   service.listProviderSkills(provider, { userId })
 *     -> SkillsProvider.listSkills (base class)
 *       -> CodexSkillsProvider.getSkillSources(workspacePath, userId)
 *         -> resolveCodexHomeForUser(userId) -> resolveProviderEnv(...).CODEX_HOME
 *
 * WHAT IS MOCKED AND WHY: only `resolveProviderEnv` — the central isolation seam
 * (ADR-014) that already has its own dedicated tests and whose real body reaches
 * SQLite (admin sharing policy) and provisions on-disk user trees. Everything under
 * test here (the option type, the base class, the codex adapter, `codex-home.ts`)
 * runs for real, so the test fails if ANY link in that chain drops the userId.
 *
 * Runner: npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *           --test server/modules/providers/tests/skills.user-isolation.test.ts
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

// Stand-in for the real isolation seam: reproduces exactly the codex branch of
// resolveProviderEnv (CODEX_HOME under ~/.nassaj-users/<userId>/.codex when a user
// is present, base env untouched for anonymous/system callers) with no DB and no
// filesystem provisioning. os.homedir() is read at CALL time so the per-test
// temp-home patch below applies.
mock.module(resolveProviderEnvUrl, {
  namedExports: {
    resolveProviderEnv: (
      userId: string | number | null,
      provider: string,
      baseEnv: NodeJS.ProcessEnv = process.env,
    ): NodeJS.ProcessEnv => {
      const env = { ...baseEnv };
      if (userId === null || userId === undefined || userId === '' || provider !== 'codex') {
        delete env.CODEX_HOME;
        return env;
      }
      env.CODEX_HOME = path.join(os.homedir(), '.nassaj-users', String(userId), '.codex');
      return env;
    },
  },
});

const { providerSkillsService } = await import('../services/skills.service.js');

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

const writeSkill = async (skillsRoot: string, name: string): Promise<void> => {
  const skillDir = path.join(skillsRoot, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody.\n`,
    'utf8',
  );
};

test(
  'codex skill discovery follows the caller\'s isolated CODEX_HOME (B-153)',
  { concurrency: false },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-user-isolation-'));
    const restoreHomeDir = patchHomeDir(tempRoot);

    try {
      const workspacePath = path.join(tempRoot, 'workspace');
      await fs.mkdir(workspacePath, { recursive: true });

      // System-scope skills live under <CODEX_HOME>/skills/.system, which is the
      // ONLY codex skill root that moves per user (the `~/.agents/skills` root is
      // keyed off HOME, and codex isolation never overrides HOME).
      await writeSkill(path.join(tempRoot, '.codex', 'skills', '.system'), 'operator-system-skill');
      await writeSkill(
        path.join(tempRoot, '.nassaj-users', '7', '.codex', 'skills', '.system'),
        'isolated-system-skill',
      );

      const isolated = await providerSkillsService.listProviderSkills('codex', {
        workspacePath,
        userId: 7,
      });
      const isolatedNames = isolated.map((skill) => skill.name);

      assert.ok(
        isolatedNames.includes('isolated-system-skill'),
        `isolated user must see their own system skills, got: ${isolatedNames.join(', ')}`,
      );
      assert.ok(
        !isolatedNames.includes('operator-system-skill'),
        `isolated user must NOT see the operator's system skills, got: ${isolatedNames.join(', ')}`,
      );
      assert.ok(
        isolated
          .find((skill) => skill.name === 'isolated-system-skill')
          ?.sourcePath.startsWith(path.join(tempRoot, '.nassaj-users', '7', '.codex')),
        'the resolved sourcePath must sit inside the caller\'s isolated codex home',
      );

      // Anonymous/system callers (no userId) keep the exact pre-B-153 behavior:
      // the operator home. This is the regression guard for the fallback path.
      const shared = await providerSkillsService.listProviderSkills('codex', { workspacePath });
      const sharedNames = shared.map((skill) => skill.name);

      assert.ok(
        sharedNames.includes('operator-system-skill'),
        `anonymous caller must still see the operator home, got: ${sharedNames.join(', ')}`,
      );
      assert.ok(
        !sharedNames.includes('isolated-system-skill'),
        `anonymous caller must not see a user's isolated skills, got: ${sharedNames.join(', ')}`,
      );
    } finally {
      restoreHomeDir();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);

test(
  'providers with a shared skill library ignore userId (claude — ADR-023)',
  { concurrency: false },
  async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-shared-lib-'));
    const restoreHomeDir = patchHomeDir(tempRoot);

    try {
      const workspacePath = path.join(tempRoot, 'workspace');
      await fs.mkdir(workspacePath, { recursive: true });
      await writeSkill(path.join(tempRoot, '.claude', 'skills'), 'shared-claude-skill');

      // provisionUserDirs symlinks each user's .claude/skills back to the operator
      // tree on purpose, so passing a userId must NOT fork claude skill discovery.
      const withUser = await providerSkillsService.listProviderSkills('claude', {
        workspacePath,
        userId: 7,
      });
      assert.ok(
        withUser.map((skill) => skill.name).includes('shared-claude-skill'),
        'claude skills stay shared for every caller',
      );
    } finally {
      restoreHomeDir();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  },
);
