import antigravityMark from '../../assets/provider-logos/antigravity.png';
import kimiMark from '../../assets/provider-logos/kimi.png';

/**
 * The marks that are shipped as raster art rather than drawn as SVG.
 *
 * WHY RASTER. Every other provider here has a mark simple enough to redraw
 * faithfully in paths (a wordmark, a glyph, a geometric shape). These do not:
 * Antigravity's arch is a four-stop gradient and Kimi's is a photographic-
 * weight tile. Tracing them by hand is how a brand mark becomes an "inspired
 * by" — which is exactly the state this replaces: a lightning bolt for
 * Antigravity, and a letter in a coloured square for Kimi.
 *
 * WHERE THEY CAME FROM — the real artwork, not an approximation:
 *  - `antigravity.png` — antigravity.google/assets/image/antigravity-logo.png
 *  - `kimi.png`        — the favicon shipped inside the installed
 *                        `@moonshot-ai/kimi-code` CLI (dist-web/favicon.ico)
 * Kimi's is read off the vendor's own installed binary, so it is the mark
 * that vendor ships, not one found on a logo aggregator. Kept for the live
 * Kimi ENGINE (T-1953); the Kimi agent BODY is retired and renders the grey
 * retired tile instead (`SessionProviderLogo`).
 *
 * They are IDENTIFICATION, not endorsement: each names the provider whose CLI
 * this row actually launches — the same nominative use already made of the
 * Cursor, Codex and OpenCode marks. No mark is recoloured, cropped or
 * composed into another; nassaj's own identity stays its own.
 *
 * Bundled through the asset pipeline (hashed, self-hosted) rather than hot-linked:
 * the app runs behind a tunnel and must render with no internet at all.
 */
const BRAND_MARK = {
  antigravity: { src: antigravityMark, label: 'Antigravity' },
  kimi: { src: kimiMark, label: 'Kimi' },
} as const;

export type BrandImageProvider = keyof typeof BRAND_MARK;

export function hasBrandImage(provider: unknown): provider is BrandImageProvider {
  return typeof provider === 'string' && Object.prototype.hasOwnProperty.call(BRAND_MARK, provider);
}

/**
 * `object-contain` inside a square box: Antigravity's arch is 128×118, and
 * stretching it to a square would distort the one mark whose proportions are
 * the whole shape. Decorative by default — every caller draws the provider name
 * beside it, and a second announcement would be read twice.
 */
export default function BrandImageLogo({
  provider,
  className = 'w-5 h-5',
}: {
  provider: BrandImageProvider;
  className?: string;
}) {
  const mark = BRAND_MARK[provider];
  return (
    <img
      src={mark.src}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`${className} object-contain`}
    />
  );
}
