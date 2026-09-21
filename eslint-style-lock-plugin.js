/**
 * STYLE_LOCK — ESLint plugin.
 *
 * §1 `no-sub-13px`: bans text-xs (12px) and arbitrary Tailwind classes
 * text-[10px], text-[11px], text-[12px], plus CSS font-size: 10/11/12px.
 *
 * §2 `no-raw-palette-surface`: bans raw Tailwind neutral-palette *surface*
 * classes (bg-white, bg-gray-100, text-gray-900, border-gray-200, …). Those
 * are frozen greys: they ignore `--card`/`--muted`/`--border`, so every brand
 * theme preset (`src/lib/theme-presets.ts` rewrites 30+ variables) leaves them
 * behind — a white card stranded on a cream background. Semantic accents
 * (red/green/amber/blue) are deliberately NOT covered here; they carry meaning
 * and have their own tokens (--success/--warning/--danger).
 *
 * To allow a documented exception, add on the same line:
 *   // design-ok: <reason>
 */

/**
 * Raw neutral surface classes → the semantic token that follows the theme.
 * Exported so `scripts/check-theme-compliance.mjs` enforces the identical list
 * without a second copy drifting out of sync.
 */
export const SURFACE_REPLACEMENTS = [
  [/\bbg-white\b/, "bg-card (or bg-background)"],
  // `bg-black/<alpha>` is exempt: a translucent scrim dims whatever is behind
  // it and reads correctly under every preset. Opaque `bg-black` does not.
  [/\bbg-black\b(?!\/)/, "bg-foreground"],
  [/\bbg-(?:gray|slate|zinc|neutral|stone)-(?:50|100|200)\b/, "bg-muted"],
  [/\bbg-(?:gray|slate|zinc|neutral|stone)-(?:700|800|900|950)\b/, "bg-card / bg-muted"],
  [/\btext-(?:gray|slate|zinc|neutral|stone)-(?:700|800|900|950)\b/, "text-foreground"],
  [/\btext-(?:gray|slate|zinc|neutral|stone)-(?:400|500|600)\b/, "text-muted-foreground"],
  [/\bborder-(?:gray|slate|zinc|neutral|stone)-(?:100|200|300|700|800)\b/, "border-border"],
];

/** @type {import('eslint').ESLint.Plugin} */
const styleLockPlugin = {
  rules: {
    "no-sub-13px": {
      meta: {
        type: "problem",
        docs: {
          description:
            "STYLE_LOCK §1: text-xs (12px) and arbitrary sub-13px sizes are banned.",
        },
        schema: [],
        messages: {
          noSub13px:
            "STYLE_LOCK §1: banned sub-13px text ({{match}}). Use text-[13px] or larger. Add `// design-ok: <reason>` on the same line for documented exceptions.",
        },
      },
      create(context) {
        const sourceCode = context.sourceCode || context.getSourceCode();
        const bannedRe = /\btext-xs\b|\btext-\[(10|11|12)px\]/g;
        const cssBannedRe = /font-size\s*:\s*(10|11|12)px/g;

        function hasDesignOkComment(line) {
          const comments = sourceCode.getAllComments();
          return comments.some(
            (c) =>
              c.loc.start.line === line && /design-ok/i.test(c.value)
          );
        }

        function checkNode(node, raw) {
          if (typeof raw !== "string") return;
          const match =
            raw.match(bannedRe)?.[0] || raw.match(cssBannedRe)?.[0];
          if (!match) return;
          if (hasDesignOkComment(node.loc.start.line)) return;

          context.report({
            node,
            messageId: "noSub13px",
            data: { match },
          });
        }

        return {
          Literal(node) {
            checkNode(node, node.value);
          },
          TemplateLiteral(node) {
            checkNode(
              node,
              node.quasis.map((q) => q.value.raw).join("")
            );
          },
        };
      },
    },

    "no-raw-palette-surface": {
      meta: {
        type: "problem",
        docs: {
          description:
            "STYLE_LOCK §2: raw neutral-palette surface classes ignore theme presets.",
        },
        schema: [],
        messages: {
          rawSurface:
            "STYLE_LOCK §2: `{{match}}` is a frozen grey — it ignores theme presets. Use `{{suggest}}`. Add `// design-ok: <reason>` on the same line for documented exceptions.",
        },
      },
      create(context) {
        const sourceCode = context.sourceCode || context.getSourceCode();

        function hasDesignOkComment(line) {
          return sourceCode
            .getAllComments()
            .some((c) => c.loc.start.line === line && /design-ok/i.test(c.value));
        }

        function checkNode(node, raw) {
          if (typeof raw !== "string") return;
          for (const [re, suggest] of SURFACE_REPLACEMENTS) {
            const match = raw.match(re);
            if (!match) continue;
            if (hasDesignOkComment(node.loc.start.line)) return;
            context.report({
              node,
              messageId: "rawSurface",
              data: { match: match[0], suggest },
            });
            return;
          }
        }

        return {
          Literal(node) {
            checkNode(node, node.value);
          },
          TemplateLiteral(node) {
            checkNode(
              node,
              node.quasis.map((q) => q.value.raw).join("")
            );
          },
        };
      },
    },
  },
};

export default styleLockPlugin;
