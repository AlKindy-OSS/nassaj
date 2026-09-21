/**
 * wikiDesk.ts — the landing page's two "front desk" lists.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The index column answers "I know the page, take me to it". The landing page
 * answers the other question — "I do not know what I need". Those are different
 * questions, and they need different units: the index navigates by PAGE TITLE,
 * the landing page navigates by SYMPTOM or QUESTION, which are headings INSIDE
 * pages. That is also what stops the two surfaces from listing the same
 * nineteen titles at each other across one viewport.
 *
 * A heading target is only useful if it exists. `AnchorLink` renders an
 * unresolvable target as plain text — honest to the reader, silent to the
 * author — so a landing page of hand-typed anchors would rot invisibly on the
 * first content edit. Hence:
 *
 *  - an entry is declared as { file, heading } where `heading` is the heading
 *    text VERBATIM as written in the markdown;
 *  - the anchor is not written here at all. It is resolved at build time from
 *    the shipped markdown through `extractToc`, which slugifies with the same
 *    `slugify` that `HeadingWithId` uses when it renders the heading. One
 *    function, so the two can never disagree;
 *  - a heading that no longer exists is DROPPED from the rendered list rather
 *    than shown as a dead row, and reported in MISSING_DESK_ENTRIES, which
 *    WikiHome.desk.test.ts asserts is empty. Editing content therefore breaks
 *    the build's tests, not the reader's click.
 */

import { RAW_BY_FILE } from './wikiContent';
import { extractHeadings } from './wikiUtils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An entry as authored: which page, and the heading text as it is written. */
export type DeskEntryDef = {
  file: string;
  /** Heading text exactly as it appears in the markdown, minus the `##` marks. */
  heading: string;
};

/** An entry once its anchor has been resolved against the shipped content. */
export type DeskEntry = DeskEntryDef & {
  /** What the row shows — the heading, with any ordinal prefix removed. */
  label: string;
  /** Heading id, produced by the same slugify the article renderer uses. */
  anchor: string;
};

// ---------------------------------------------------------------------------
// Authored content
// ---------------------------------------------------------------------------

/**
 * Block 3 — "something is broken". Ordered by how often the team hits it, which
 * is not the order the page is written in.
 */
export const SYMPTOM_DEFS: DeskEntryDef[] = [
  { file: '40-troubleshooting.md', heading: 'المحادثة لا تردّ' },
  { file: '40-troubleshooting.md', heading: 'الموقع لا يفتح أصلاً (خطأ 502)' },
  { file: '40-troubleshooting.md', heading: 'خرجتُ من حسابي فجأة' },
  { file: '40-troubleshooting.md', heading: 'الردّ توقّف عند «no final response»' },
  {
    file: '40-troubleshooting.md',
    heading: '«المستخدم لا يريد هذا الإجراء» — وأنا لم أرفض شيئاً',
  },
];

/**
 * Block 4 — "questions every newcomer asks". The FAQ numbers its headings, and
 * the number is an artefact of the page's own ordering: it means nothing out of
 * context, so it is stripped for display (see ORDINAL_PREFIX) while the lookup
 * still uses the verbatim heading.
 */
export const QUESTION_DEFS: DeskEntryDef[] = [
  { file: '50-faq.md', heading: '1. ما الفرق بين المشروع والجلسة والمحادثة؟' },
  { file: '50-faq.md', heading: '2. من ينفّذ — المنسّق أم الوكيل؟' },
  { file: '50-faq.md', heading: '4. لماذا يتوقّف نسّاج فجأة عن قبول المهام؟' },
  { file: '50-faq.md', heading: '23. من يرى المحادثات — الكل أم فقط فريقي؟' },
  { file: '50-faq.md', heading: '31. كيف أضيف مشروعاً جديداً؟' },
];

/** `12.` / `15ب.` — the FAQ's own numbering, meaningless outside that page. */
const ORDINAL_PREFIX = /^\d+ب?\.\s*/;

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Heading text → id, for one page, taken from the shipped markdown. */
function headingIds(file: string): Map<string, string> {
  const raw = RAW_BY_FILE[file];
  const ids = new Map<string, string>();
  if (typeof raw !== 'string') return ids;
  // The compact article TOC intentionally shows H2 only, while desk links may
  // target useful H3 questions (notably the FAQ). Resolve against every
  // rendered heading rather than coupling this navigation contract to the TOC.
  for (const entry of extractHeadings(raw)) {
    if (!ids.has(entry.text)) ids.set(entry.text, entry.id);
  }
  return ids;
}

/**
 * Resolves a list of definitions against the shipped content.
 * Returns the entries that resolved, plus those that did not — the caller
 * renders the first and the test suite asserts the second is empty.
 */
export function resolveDeskEntries(
  defs: DeskEntryDef[],
  options: { stripOrdinal?: boolean } = {},
): { entries: DeskEntry[]; missing: DeskEntryDef[] } {
  const entries: DeskEntry[] = [];
  const missing: DeskEntryDef[] = [];
  const idsByFile = new Map<string, Map<string, string>>();

  for (const def of defs) {
    if (!idsByFile.has(def.file)) idsByFile.set(def.file, headingIds(def.file));
    const anchor = idsByFile.get(def.file)!.get(def.heading);
    if (!anchor) {
      missing.push(def);
      continue;
    }
    entries.push({
      ...def,
      anchor,
      label: options.stripOrdinal ? def.heading.replace(ORDINAL_PREFIX, '') : def.heading,
    });
  }

  return { entries, missing };
}

const symptoms = resolveDeskEntries(SYMPTOM_DEFS);
const questions = resolveDeskEntries(QUESTION_DEFS, { stripOrdinal: true });

export const SYMPTOMS: DeskEntry[] = symptoms.entries;
export const QUESTIONS: DeskEntry[] = questions.entries;

/**
 * Every declared entry whose page IS shipped but whose heading is no longer in
 * it — i.e. a heading that was renamed or removed. Entries whose whole page is
 * absent are not rot: a node that carries different content simply has nothing
 * to offer here, exactly as wikiLinks.test.ts treats a missing page.
 */
export const MISSING_DESK_ENTRIES: DeskEntryDef[] = [
  ...symptoms.missing,
  ...questions.missing,
].filter((def) => typeof RAW_BY_FILE[def.file] === 'string');

/** The two pages the "see everything" tail rows lead to. */
export const TROUBLESHOOTING_FILE = '40-troubleshooting.md';
export const FAQ_FILE = '50-faq.md';
