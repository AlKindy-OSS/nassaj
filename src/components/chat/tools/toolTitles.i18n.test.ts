/**
 * B-1665: tool card titles are translated at render time. In Arabic no English
 * placeholder ("Subagent", "Running task", "Parameters", "Details") may leak,
 * and every new key exists in every locale that ships a chat bundle.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createInstance, type TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import { getToolConfig } from './configs/toolConfigs';
import { formatSubagentTitle, subagentTypeLabel } from './subagentTitle';

const LOCALES = join(dirname(fileURLToPath(import.meta.url)), '../../../i18n/locales');
const readChat = (locale: string) => JSON.parse(readFileSync(join(LOCALES, locale, 'chat.json'), 'utf8'));

async function translator(locale: string): Promise<TFunction> {
  const i18n = createInstance();
  await i18n.init({
    lng: locale, fallbackLng: 'en', ns: ['chat'], defaultNS: 'chat',
    resources: { [locale]: { chat: readChat(locale) }, en: { chat: readChat('en') } },
    interpolation: { escapeValue: false },
  });
  return i18n.t;
}

const ENGLISH_PLACEHOLDERS = /Subagent|Running task|Parameters|Details|Task details|Implementation plan|Found \d/;

const titleOf = (tool: string, part: 'input' | 'result', data: unknown, t: TFunction) => {
  const title = getToolConfig(tool)[part]?.title;
  return typeof title === 'function' ? title(data, t) : title;
};

describe('tool card titles (B-1665)', () => {
  it('Arabic titles carry no English placeholder', async () => {
    const t = await translator('ar');
    const titles = [
      titleOf('Task', 'input', {}, t),
      titleOf('Agent', 'input', { subagent_type: 'researcher', description: 'فحص' }, t),
      titleOf('Task', 'result', {}, t),
      titleOf('UnknownTool', 'input', {}, t),
      titleOf('TaskGet', 'result', {}, t),
      titleOf('ExitPlanMode', 'input', {}, t),
      titleOf('Grep', 'result', { toolUseResult: { numFiles: 3 } }, t),
      t('tools.titles.details'),
      t('tools.titles.plan'),
    ];
    for (const title of titles) expect(title).not.toMatch(ENGLISH_PLACEHOLDERS);
    expect(titles[1]).toBe('وكيل فرعي / researcher: فحص');
  });

  it('a sub-agent title never invents a type or a task', async () => {
    const t = await translator('en');
    expect(formatSubagentTitle(t, undefined, undefined)).toBe('Subagent');
    expect(formatSubagentTitle(t, '', 'Scan logs')).toBe('Subagent: Scan logs');
    expect(formatSubagentTitle(t, 'qa-critic', null)).toBe('Subagent / qa-critic');
  });

  it('T-2071: the built-in fork type gets a translated label; other types stay identifiers', async () => {
    const ar = await translator('ar');
    const en = await translator('en');
    expect(subagentTypeLabel(en, 'fork')).toBe('Fork');
    expect(subagentTypeLabel(ar, 'fork')).toBe('نسخة متفرّعة');
    expect(subagentTypeLabel(ar, 'qa-critic')).toBe('qa-critic');
    expect(subagentTypeLabel(ar, undefined)).toBe('');
    expect(titleOf('Agent', 'input', { subagent_type: 'fork', description: 'فحص' }, ar))
      .toBe('وكيل فرعي / نسخة متفرّعة: فحص');
  });

  it('Agent shares the Task card instead of the generic Default', () => {
    expect(getToolConfig('Agent')).toBe(getToolConfig('Task'));
  });

  it('every new key exists in every locale that ships chat.json', () => {
    const keys = ['subagent.title', 'subagent.titleWithType', 'subagent.titleWithTask', 'subagent.backgroundLaunched',
      'subagent.forkType',
      'tools.titles.parameters', 'tools.titles.details', 'tools.titles.plan', 'tools.titles.taskDetails',
      'tools.titles.subagentResult', 'tools.titles.updatingTodoList', 'tools.titles.taskList',
      'tools.titles.implementationPlan', 'tools.titles.foundFiles_other', 'agyMessage.to'];
    const locales = readdirSync(LOCALES).filter((locale) => existsSync(join(LOCALES, locale, 'chat.json')));
    expect(locales.length).toBeGreaterThan(2);
    for (const locale of locales) {
      const bundle = readChat(locale);
      for (const key of keys) {
        const value = key.split('.').reduce((node, part) => node?.[part], bundle);
        expect(typeof value, `${locale}:${key}`).toBe('string');
      }
    }
  });
});
