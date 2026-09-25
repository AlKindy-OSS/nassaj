import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import { providerSkillsService } from '@/modules/providers/index.js';
import type { ProviderSkill } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

import { referenceMaterialsService } from './reference-materials.service.js';

type Lister = typeof providerSkillsService.listProviderSkills;

const originalLister: Lister = providerSkillsService.listProviderSkills;
const originalWarn = console.warn;

afterEach(() => {
  providerSkillsService.listProviderSkills = originalLister;
  console.warn = originalWarn;
});

const fakeSkill = (provider: string): ProviderSkill => ({
  provider: provider as ProviderSkill['provider'],
  name: `${provider}-skill`,
  description: `skill for ${provider}`,
  command: `/${provider}-skill`,
  scope: 'user',
  sourcePath: `/nonexistent/${provider}/SKILL.md`,
});

const listSkills = () => referenceMaterialsService.list({
  material: 'skills',
  userId: 1,
  canManage: false,
});

test('B-1323: an unregistered provider is skipped instead of failing the whole list', async () => {
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  providerSkillsService.listProviderSkills = (async (provider: string) => {
    if (provider === 'cursor') {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }
    return [fakeSkill(provider)];
  }) as Lister;

  const entries = await listSkills();
  assert.ok(entries.length > 0, 'registered providers must still be listed');
  assert.equal(entries.some((entry) => entry.provider === 'cursor'), false);
  assert.ok(entries.some((entry) => entry.provider === 'claude'));

  await listSkills();
  const skipWarnings = warnings.filter((args) => (
    String(args[0]).includes('skipping unregistered skills provider')
  ));
  assert.equal(skipWarnings.length, 1, 'the skip is logged once per provider');
  assert.deepEqual(skipWarnings[0][1], { provider: 'cursor', code: 'UNSUPPORTED_PROVIDER' });
});

test('any other provider failure still fails the list with 503', async () => {
  providerSkillsService.listProviderSkills = (async (provider: string) => {
    if (provider === 'codex') throw new Error('disk exploded');
    return [fakeSkill(provider)];
  }) as Lister;

  await assert.rejects(listSkills(), (error: unknown) => (
    error instanceof AppError
      && error.code === 'REFERENCE_MATERIAL_PROVIDER_UNAVAILABLE'
      && error.statusCode === 503
  ));
});
