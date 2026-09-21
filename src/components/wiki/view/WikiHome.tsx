/**
 * WikiHome.tsx — the wiki landing page: a front desk, not a second index.
 *
 * WHAT THIS SCREEN IS FOR
 * -----------------------
 * It used to list every section and every page. So does the index column beside
 * it, so one open panel showed the same nineteen titles twice, three hundred
 * pixels apart. Closing the index by default hid that rather than fixing it —
 * the reader reopens the index and the duplication is back, now with a dead gap
 * where the layout expected the width.
 *
 * The fix is to give the two surfaces different questions to answer:
 *
 *   index         "I know the page — take me to it"      unit: a page title
 *   landing page  "I do not know what I need"            unit: a symptom or a question
 *
 * So this page navigates to HEADINGS INSIDE pages (file#anchor) — destinations
 * the index cannot reach at all — and its rows are things a reader recognises
 * from their own screen, not titles from a table of contents. The overlap with
 * the index is exactly four strings: the "ابدأ من هنا" section title and its
 * three pages, which appear here as a numbered path because they are a sequence
 * and the index cannot show that.
 *
 * The one exception aside, no page title appears on this screen.
 *
 * The anchors are resolved from the shipped markdown (see wikiDesk.ts), never
 * typed here: a dead anchor renders as plain text, which no one notices.
 *
 * The grids live in wiki-panel.css under element-qualified selectors rather
 * than in Tailwind utilities here — see the note at the head of that file for
 * the collision hazard that requires it.
 */

import { Search, ChevronLeft, LifeBuoy, HelpCircle } from 'lucide-react';

import { SECTIONS } from '../wikiContent';
import { SYMPTOMS, QUESTIONS, TROUBLESHOOTING_FILE, FAQ_FILE } from '../wikiDesk';
import type { DeskEntry } from '../wikiDesk';
import { wikiIcon } from '../wikiIcons';
import { searchShortcutLabel } from '../platformKey';
import { useWikiLabels } from '../useWikiLabels';

type Props = {
  /** Opens a page, optionally scrolling to a heading id inside it. */
  onNavigate: (file: string, anchorId?: string) => void;
  onOpenSearch: () => void;
};

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** One row of a desk panel — a question, a symptom, or the "all of them" tail. */
function EntryRow({
  label,
  onSelect,
  tail,
  labelLang,
}: {
  label: string;
  onSelect: () => void;
  /** The last row of a panel, which leads to the whole page rather than a heading. */
  tail?: boolean;
  /**
   * Set only on the tail row. Entry labels are headings lifted verbatim out of
   * the Arabic markdown, so they carry no `lang` in any interface language.
   */
  labelLang?: 'en';
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      data-wiki-entry-row
      data-wiki-entry-tail={tail ? 'true' : undefined}
      className="nassaj-control"
    >
      <span className="nassaj-control__surface">
        {/* Isolated: several of these end in a Latin fragment inside Arabic
            quotation marks («no final response»), and without isolation the
            closing mark migrates to the wrong end of the row. */}
        <span data-wiki-entry-label lang={labelLang}>
          {label}
        </span>
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" data-wiki-row-chevron />
      </span>
    </button>
  );
}

function DeskPanel({
  icon: Icon,
  title,
  summary,
  entries,
  tailLabel,
  tailFile,
  onNavigate,
  labelLang,
  labelDir,
}: {
  icon: typeof LifeBuoy;
  title: string;
  summary: string;
  entries: DeskEntry[];
  tailLabel: string;
  tailFile: string;
  onNavigate: (file: string, anchorId?: string) => void;
  /** `en` when the shell labels are English; undefined otherwise. */
  labelLang?: 'en';
  /**
   * Base direction of the SUMMARY, which is a translated sentence. The title is
   * a short label and orders itself; the entry rows below are Arabic headings
   * lifted from the markdown and keep the inherited rtl.
   */
  labelDir: 'rtl' | 'ltr';
}) {
  return (
    <section data-wiki-home-panel>
      <header>
        <span data-wiki-panel-icon>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <h2 lang={labelLang}>{title}</h2>
      </header>
      <p data-wiki-panel-summary lang={labelLang} dir={labelDir}>
        {summary}
      </p>
      <ul data-wiki-panel-list>
        {entries.map((entry) => (
          <li key={`${entry.file}#${entry.anchor}`}>
            <EntryRow
              label={entry.label}
              onSelect={() => onNavigate(entry.file, entry.anchor)}
            />
          </li>
        ))}
        <li>
          <EntryRow
            label={tailLabel}
            onSelect={() => onNavigate(tailFile)}
            tail
            labelLang={labelLang}
          />
        </li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function WikiHome({ onNavigate, onOpenSearch }: Props) {
  const { t, langAttr, labelDir } = useWikiLabels();
  const pathSection = SECTIONS.find((section) => section.id === 'start') ?? SECTIONS[0];
  const PathIcon = wikiIcon(pathSection?.icon);
  const hasContent = SECTIONS.length > 0;

  return (
    // dir/lang inherited from the panel root, which is rtl/ar for the whole wiki.
    <div data-wiki-home>
      {/* ── Opening ─────────────────────────────────────────────────────────
          Aligned to the start, not centred: every other screen in the panel
          starts on that axis, and a centred hero would read as marketing on a
          document a stuck colleague opened to get unstuck. */}
      <header data-wiki-home-intro>
        {/* No logo here: the index column beside it already carries one. */}
        <h1 lang={langAttr}>{t('home.title')}</h1>
        {/* A sentence, not a label: it needs its own base direction or its
            full stop lands at the visual start of the line. */}
        <p lang={langAttr} dir={labelDir}>{t('home.blurb')}</p>
      </header>

      {/* ── 1 · Search — the first door, for "I know the word, not the page" ── */}
      <button
        type="button"
        onClick={onOpenSearch}
        data-wiki-home-search
        className="nassaj-control"
      >
        <span className="nassaj-control__surface">
          <Search className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1" lang={langAttr}>
            {t('home.searchPlaceholder')}
          </span>
          <kbd className="hidden flex-shrink-0 md:inline">{searchShortcutLabel()}</kbd>
        </span>
      </button>

      {!hasContent ? (
        <p data-wiki-home-empty lang={langAttr}>
          {t('home.empty')}
        </p>
      ) : (
        <>
          {/* ── 2 · The path — the ONE place page titles are repeated. ──────
              The index shows these three as equal rows with no number and no
              order, which loses the fact that they are steps. Numbering them
              adds something the index cannot say. */}
          <section data-wiki-home-path>
            {/* The summary rides on the title's line from md up (it is one short
                clause, and the block below it is only three cards tall), and
                wraps under it on a phone. */}
            <header>
              <span data-wiki-panel-icon>
                <PathIcon className="h-4 w-4" aria-hidden="true" />
              </span>
              <h2>{pathSection.title}</h2>
              {pathSection.summary && <p data-wiki-panel-summary>{pathSection.summary}</p>}
            </header>
            <div data-wiki-step-grid>
              {pathSection.pages.slice(0, 3).map((page, i) => (
                <button
                  key={page.file}
                  type="button"
                  onClick={() => onNavigate(page.file)}
                  data-wiki-step
                  className="nassaj-control"
                >
                  <span className="nassaj-control__surface">
                    {/* Latin digits, deliberately: every technical number in this
                        wiki (502, 3004, 2026-07-27) is Latin and cannot be
                        converted, so one system is the only way to avoid two on
                        the same screen. */}
                    <span data-wiki-step-number aria-hidden="true">
                      {i + 1}
                    </span>
                    <span data-wiki-step-title>{page.title}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* ── 3 + 4 · The desk. Two columns of equal length by construction:
              five rows and a tail each, so neither can leave a dead band under
              the other. Symptoms come first — in RTL that puts them in the
              right-hand column, the first thing the eye meets, and on a phone
              at the top, because someone opening the wiki from a phone is
              usually stuck right now. */}
          <div data-wiki-home-desk>
            <DeskPanel
              icon={LifeBuoy}
              title={t('home.symptomsTitle')}
              summary={t('home.symptomsSummary')}
              entries={SYMPTOMS}
              tailLabel={t('home.symptomsTail')}
              tailFile={TROUBLESHOOTING_FILE}
              onNavigate={onNavigate}
              labelLang={langAttr}
              labelDir={labelDir}
            />
            <DeskPanel
              icon={HelpCircle}
              title={t('home.questionsTitle')}
              summary={t('home.questionsSummary')}
              entries={QUESTIONS}
              tailLabel={t('home.questionsTail')}
              tailFile={FAQ_FILE}
              onNavigate={onNavigate}
              labelLang={langAttr}
              labelDir={labelDir}
            />
          </div>
        </>
      )}

      {/* ── Footer — the one place in the whole panel the Al-Kindy mark
          appears: it attributes the authorship of this text, and the end of the
          document's entrance is where an attribution belongs. The index used to
          carry a second copy, buried below its own fold. ─────────────────── */}
      <footer data-wiki-home-footer>
        <img src="/alkindy-symbol.svg" alt="" aria-hidden="true" className="h-6 w-auto opacity-70" />
        <span lang={langAttr}>{t('home.mark')}</span>
      </footer>
    </div>
  );
}
