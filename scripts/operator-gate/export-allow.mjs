// export-allow.mjs — the SINGLE SOURCE of the neutral allow-list shared by every
// operator-marker scanner.
//
// The leak rules split into two halves. The FORBIDDEN half (the operator tokens
// themselves: the private repo owner, our domains, the owner's name) carries the
// exact secrets it hunts for, so it stays inline in leak-rules.mjs, which is
// EXCLUDED from the public export. The ALLOW half — generic placeholder home
// users, the `example.ts.net` tailnet placeholder, and the i18n theme-preset
// display-label shape that legitimately carries a brand word — contains NO
// operator secret. It is intentionally-public data (`irukhaimi`/`alkindy`/
// `nawras` are shipped theme ids), so this file is leak-clean and MAY ship.
//
// Extracting it here lets two surfaces that previously each carried their own
// copy converge on one definition, without leaking:
//   1. the export leak gate (leak-rules.mjs, via scan-export-tree.mjs) — excluded
//      from the export, imports both halves.
//   2. the SHIPPED public-operations-boundary test — ships in the public tree, so
//      it can only import a leak-clean module; it imports this one.
// export-public.sh carries a narrow allow exception for exactly this file so the
// shipped test can still resolve it in the public tree, and the leak gate scans
// it like any other file, failing closed if a secret ever lands here.

/**
 * Home-directory owners that are generic placeholders, not our operator. A
 * `/home/<user>` or encoded `-home-<user>-` path whose owner is in this set is
 * neutral example content, not an operator leak.
 */
export const genericHomeUsers = new Set(
    ['agent', 'demo', 'dev', 'example', 'op', 'operator', 'owner', 'runner', 'service', 'user', 'x'],
);

/**
 * The sole neutral tailnet host label. `<host>.example.ts.net` is placeholder
 * documentation; any other `*.ts.net` label is a real operator tailnet and leaks.
 */
export const neutralTailnetHost = 'example';

/**
 * The one legitimate context for a brand/surname word: an i18n theme-preset
 * DISPLAY-LABEL line, e.g. `"irukhaimi": "الرخيمي"` or `"irukhaimi": "Al-Rukhaimi"`.
 * A forbidden-token rule with an `allow` fails only on a line this does not cover,
 * so a genuine label passes while any prose leak still fails. The three ids are
 * shipped theme presets, never operator secrets.
 */
export const themeLabelAllow = /"(?:irukhaimi|alkindy|nawras)"\s*:\s*"[^"]*"/;
