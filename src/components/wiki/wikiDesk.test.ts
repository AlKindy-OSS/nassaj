/**
 * wikiDesk.test.ts — the landing page's anchors must point at real headings.
 *
 * The landing page stopped listing page titles and started listing symptoms and
 * questions, which are headings INSIDE pages. That is the whole point of it —
 * those are destinations the index cannot reach — but it moves the failure mode:
 * a page that no longer exists is obvious, while a heading that was reworded is
 * silent. `AnchorLink` renders an unresolvable target as ordinary text, so a
 * rotted landing page looks exactly like a working one.
 *
 * These assertions run against the real shipped markdown (no synthetic
 * fixtures — see feedback_synthetic_fixtures_false_confidence.md), so a node
 * carrying different content simply has nothing to check.
 */

import { describe, it, expect } from 'vitest';

import { RAW_BY_FILE, SECTIONS } from './wikiContent';
import {
  SYMPTOM_DEFS,
  QUESTION_DEFS,
  SYMPTOMS,
  QUESTIONS,
  MISSING_DESK_ENTRIES,
  TROUBLESHOOTING_FILE,
  FAQ_FILE,
} from './wikiDesk';
import { slugify } from './wikiUtils';

const ALL_DEFS = [...SYMPTOM_DEFS, ...QUESTION_DEFS];
const shipped = (file: string) => typeof RAW_BY_FILE[file] === 'string';

describe('landing-page desk entries', () => {
  it('every declared heading still exists verbatim in its page', () => {
    // The message names the offender: a failure here is a content edit, and the
    // person reading it is usually not the person who made it.
    expect(MISSING_DESK_ENTRIES.map((d) => `${d.file} :: ${d.heading}`)).toEqual([]);
  });

  it('each heading is present as a real ## or ### line in the markdown', () => {
    for (const def of ALL_DEFS) {
      if (!shipped(def.file)) continue;
      const lines = RAW_BY_FILE[def.file].split('\n').map((l) => l.trim());
      expect(
        lines.some((l) => l === `## ${def.heading}` || l === `### ${def.heading}`),
        `${def.file} has no heading line for "${def.heading}"`,
      ).toBe(true);
    }
  });

  it('anchors come from slugify, not from a hand-written string', () => {
    for (const entry of [...SYMPTOMS, ...QUESTIONS]) {
      expect(entry.anchor).toBe(slugify(entry.heading));
      expect(entry.anchor.length).toBeGreaterThan(0);
    }
  });

  it('resolves all ten entries when the two source pages ship', () => {
    if (!shipped(TROUBLESHOOTING_FILE) || !shipped(FAQ_FILE)) return;
    expect(SYMPTOMS).toHaveLength(SYMPTOM_DEFS.length);
    expect(QUESTIONS).toHaveLength(QUESTION_DEFS.length);
  });

  it('strips the FAQ ordinal for display but keeps it for the lookup', () => {
    for (const entry of QUESTIONS) {
      expect(entry.label).not.toMatch(/^\d/);
      expect(entry.heading).toMatch(/^\d/);
    }
  });

  it('leaves the symptom labels exactly as written', () => {
    for (const entry of SYMPTOMS) {
      expect(entry.label).toBe(entry.heading);
    }
  });
});

describe('landing page does not duplicate the index', () => {
  /**
   * The measurable form of the rule the redesign rests on: the landing page may
   * repeat the opening section and its three steps — a numbered path is
   * something the index cannot express — and nothing else. Every other row it
   * shows is a heading inside a page, which no index row can reach.
   */
  it('shares at most four titles with the index, all from the first section', () => {
    if (SECTIONS.length === 0) return;

    const indexTitles = new Set<string>();
    for (const section of SECTIONS) {
      if (section.title) indexTitles.add(section.title);
      for (const page of section.pages) indexTitles.add(page.title);
    }

    const firstSectionTitles = new Set<string>([
      SECTIONS[0].title,
      ...SECTIONS[0].pages.slice(0, 3).map((p) => p.title),
    ]);

    // What the landing page renders as clickable text, besides the path block.
    const deskLabels = [
      ...SYMPTOMS.map((e) => e.label),
      ...QUESTIONS.map((e) => e.label),
      'كل الأعراض',
      'كل الأسئلة',
      'ابحث عن أي شيء…',
    ];

    const collisions = deskLabels.filter((label) => indexTitles.has(label));
    expect(collisions).toEqual([]);

    // And the sanctioned overlap is exactly the first section's own titles.
    for (const title of firstSectionTitles) {
      expect(indexTitles.has(title)).toBe(true);
    }
    expect(firstSectionTitles.size).toBeLessThanOrEqual(4);
  });
});
