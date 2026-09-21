import { cn } from '../../../../../../lib/utils';
import SessionProviderLogo from '../../../../../llm-logo-provider/SessionProviderLogo';
import type { AgentProvider } from '../../../../types/types';
import { COMING_SOON_SETTINGS_PROVIDERS } from '../visibleAgents';
import type { AgentSelectorSectionProps } from '../types';

/**
 * Marks drawn as a FILLED rounded square (Claude, Kimi, Hermes) against ones
 * drawn as a line/figure on nothing (Codex's ring, Cursor's cube, the
 * Antigravity arch, OpenCode's brackets).
 *
 * Set to the same box, the filled ones read noticeably larger — they paint
 * every pixel of it, while a line mark only touches its outline. Optical size,
 * not measured size, is what the eye compares, so the filled ones are given the
 * smaller box (24 px against 28 px) to land at the same apparent weight. This
 * is the ordinary icon-set correction, and it is why the row looked uneven
 * while every icon in it was technically identical.
 */
const FILLED_SQUARE_MARKS: readonly string[] = ['claude', 'kimi', 'hermes'];

/**
 * ‏**مصدَّرة** (T-1206): صارت تُقرأ خارج الشريط — «افتح حساب Kimi ←» في تبويب
 * المحرّكات، و«يُكتب داخل OpenCode» على صفّ الموضع الأجنبي، وصفوف تبويب
 * المورّدين. كلها تسمّي **بلاطةً في هذا الشريط بعينه**، فنسخةٌ ثانية من الأسماء
 * كانت ستسمّي وجهةً باسمٍ لا يظهر على الزرّ الذي تقود إليه.
 */
export const AGENT_NAMES: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  qwen: 'Qwen Code',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  hermes: 'Hermes',
  sakana: 'Sakana',
};

/**
 * The agent picker at the top of Settings → Agents.
 *
 * WHAT IT WAS. Eleven bare logos in a squeezed pill bar, ~28 px tall. Choosing
 * an agent meant recognising a mark, and several of these marks (a green bolt,
 * a cube, a code glyph) are not recognisable out of context. The name existed
 * only in a `title` attribute — a hover, on a product used from a phone.
 *
 * WHAT IT IS. A wrapping grid of tiles, each carrying the logo at a readable
 * size AND the name in text, always. Three consequences worth stating:
 *
 *  - No horizontal scroller. Every agent is on screen at once, so "which agents
 *    exist" is answered by looking rather than by dragging a rail to find out
 *    what is hidden past its edge.
 *  - A real touch target instead of a 28 px pill segment.
 *
 * NO FRAME PER TILE (T-1172, round 3). The tiles were seven bordered boxes
 * (`border-border bg-card`), each holding an icon and one word. That is §0's
 * defect verbatim — a container with nothing to contain, repeated seven times —
 * and the frames did no work the wrapping row was not already doing: a row of
 * evenly spaced marks reads as one set without being drawn as seven.
 *
 * So the frames are gone and SELECTION carries the one surface that remains:
 * the active agent sits on `bg-muted` with its name at `font-semibold`. That is
 * not a grouping surface (§1 forbids those) but a control STATE — the same
 * thing `SegmentedControl` does with its active segment, which is why it reads
 * as "chosen" rather than as "boxed".
 *
 * The name is 13 px, not 11: STYLE_LOCK §1 puts the floor at 13 and the old
 * tile bought its width by going under it. The tile widened to 84 px to pay for
 * that honestly.
 *
 * THE DOT MEANS ONE THING. It used to be a different colour per agent (blue for
 * Claude, purple for Cursor, emerald for Antigravity), which encoded WHICH agent
 * it sat next to — information the logo already carries — in the visual channel
 * a reader reads as status. It is now one mark for every agent, and a shape
 * rather than a hue: a solid disc is connected, a hollow ring is not. No raw
 * `emerald` — there is no `--success` token in `src/index.css`, so any green
 * here would be a colour from outside the system (STYLE_LOCK §2.1).
 */
export default function AgentSelectorSection({
  agents,
  selectedAgent,
  onSelectAgent,
  agentContextById,
}: AgentSelectorSectionProps) {
  return (
    <div className="flex-shrink-0">
      {/* Deliberately NOT role="tablist"/"tab": that contract requires each tab
          to own a `tabpanel` via aria-controls, and this picker drives a whole
          panel tree below it, not one labelled region. A pressed toggle button
          states the same thing honestly — and keeps each tile a plain button
          for anything (assistive tech, tests) querying by role and name. */}
      {/* تسعة وكلاء ظاهرون حالياً. الأعمدة الخمسة في العرض المتوسط تقسمهم
          5+4 بدلاً من 8+1، وعند اتساع المساحة تظهر المجموعة في صف واحد. */}
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5 xl:grid-cols-9">
        {agents.map((agent) => {
          const isActive = selectedAgent === agent;
          const isConnected = agentContextById[agent].authStatus.authenticated;
          // Coming-soon providers (T-1760): no status dot — they have no
          // connection state to report; the dot would always show "not connected"
          // which is misleading for a provider that is not yet wired up at all.
          const isComingSoon = COMING_SOON_SETTINGS_PROVIDERS.includes(agent);

          return (
            <button
              key={agent}
              type="button"
              aria-pressed={isActive}
              onClick={() => onSelectAgent(agent)}
              // The tile's accessible name is pinned to the agent name alone.
              // Left to content, it would concatenate whatever the logo SVG
              // contributes with the visible label, and the announced name
              // would drift with the artwork.
              aria-label={AGENT_NAMES[agent]}
              title={AGENT_NAMES[agent]}
              className={cn(
                'relative flex min-w-0 touch-manipulation flex-col items-center justify-center gap-1.5',
                // بلا حدّ: الحدّ حول أيقونةٍ وكلمة لا يجمّع شيئاً — والصفّ نفسه
                // هو ما يجمّع (§0/§1). `rounded-md` لا `rounded-xl`: قيمة `xl`
                // ثابتة (0.75rem) لا تُشتقّ من `--radius`.
                'min-h-16 w-full rounded-md px-1.5 py-1.5 transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                // فرعان متنافيان بالكامل على `background-color` و`color`.
                isActive
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {/* Status rides in the corner rather than in the name row: it is a
                  property of the agent, not part of what it is called, and the
                  corner keeps the label centred whether or not a dot is there.
                  الشكل لا اللون: قرصٌ مصمت = موصول، وحلقةٌ مفرَّغة = غير موصول —
                  ولو رُسم الموصول وحده لصار غيابُ العلامة معلومةً غير مرئية.
                  Coming-soon tiles: no dot at all (T-1760). */}
              {!isComingSoon && (
                <span
                  className={cn(
                    'absolute top-1.5 end-1.5 h-2 w-2 rounded-full',
                    isConnected ? 'bg-foreground' : 'border border-muted-foreground',
                  )}
                  aria-hidden="true"
                />
              )}
              <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center" aria-hidden="true">
                <SessionProviderLogo
                  provider={agent}
                  className={cn(
                    FILLED_SQUARE_MARKS.includes(agent) ? 'h-6 w-6' : 'h-7 w-7',
                  )}
                />
              </span>
              {/* The names are Latin brand marks; an LTR base direction keeps
                  them from being reordered inside the RTL shell, and truncation
                  protects the tile width from the longest of them (Antigravity).

                  The direction is set in CSS, NOT as `dir="ltr"`: the RTL safety
                  net in `src/index.css` (`:root[dir="rtl"] [dir="ltr"]`) forces
                  `text-align: start` at a specificity that beats `.text-center`,
                  which pinned the name to the left edge under a centred logo.
                  It has to live on this block (not an inline child) so the
                  ellipsis lands at the END of the word, not its start. */}
              <span
                style={{ direction: 'ltr' }}
                className={cn(
                  'w-full truncate text-center text-[13px] leading-tight',
                  isActive ? 'font-semibold' : 'font-medium',
                )}
              >
                {AGENT_NAMES[agent]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
