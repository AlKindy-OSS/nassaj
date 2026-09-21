import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FIRST_PAGE, PAGES, RAW_BY_FILE, SECTIONS } from './wikiContent';

describe('wiki updates entry points', () => {
  it('puts Nassaj updates first and AI news immediately below it', () => {
    expect(FIRST_PAGE).toBe('00-updates.md');
    expect(PAGES.slice(0, 2).map((page) => page.file)).toEqual([
      '00-updates.md',
      '01-ai-news.md',
    ]);
    expect(SECTIONS[0]?.id).toBe('updates');
  });

  it('describes all daily-news categories without exposing an authoring template', () => {
    const news = RAW_BY_FILE['01-ai-news.md'];
    expect(news).toContain('النماذج والأدوات');
    expect(news).toContain('السياسات والتنظيم');
    expect(news).toContain('الاقتصاد والاستثمار');
    expect(news).not.toContain('https://example.com');
    expect(news).not.toContain('قالب كل إصدار يومي');
  });

  it('keeps the release-page update requirement in project instructions, not the public article', () => {
    const updates = RAW_BY_FILE['00-updates.md'];
    const contributing = readFileSync(resolve(process.cwd(), 'CONTRIBUTING.md'), 'utf8');

    expect(contributing).toContain('docs/team-wiki/00-updates.md');
    expect(contributing).toContain('Before building the release, update `CHANGELOG.md`');
    expect(contributing).toContain('exact four-part release number');
    expect(contributing).toContain('Version preparation fails closed if that wiki');
    expect(updates).not.toContain('عند إصدار أي نسخة جديدة من نسّاج');
    expect(updates).not.toContain('يجب تحديث هذه الصفحة');
  });
});

describe('wiki article titles', () => {
  it('keeps every navigation title aligned with its article heading', () => {
    const mismatches = PAGES.flatMap((page) => {
      const heading = /^#\s+(.+)$/m.exec(RAW_BY_FILE[page.file] ?? '')?.[1];
      return heading === page.title
        ? []
        : [`${page.file}: index=${page.title}; heading=${heading ?? 'missing'}`];
    });

    expect(mismatches, mismatches.join('\n')).toHaveLength(0);
  });
});
