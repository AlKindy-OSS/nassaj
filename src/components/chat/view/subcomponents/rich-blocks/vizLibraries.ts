/**
 * Chart library sources for the sandboxed frame, loaded once per page.
 *
 * The frame has `connect-src 'none'` and no network at all, so the parent reads
 * the libraries' prebuilt UMD files (hashed Vite chunks, fetched lazily on the
 * first chart) and inlines their text into the frame's `srcdoc`. The packages'
 * `exports` maps hide those build files, hence the root-relative paths.
 */

export type VizLibraryKind = 'vega' | 'd3';

export type VizLibraries = {
  /** Inline scripts, in load order. */
  scripts: string[];
  /** `@font-face` CSS with data: URIs (empty when unavailable). */
  fontCss: string;
};

/** The family name the frame uses for the embedded Arabic-capable font. */
export const FRAME_FONT_FAMILY = 'Nassaj Chart Sans';

const INTERPRETER_IMPORT =
  "import { ascending, isString, DisallowedObjectProperties } from 'vega-util';";
const INTERPRETER_EXPORT = 'export { expression as expressionInterpreter };';

/**
 * vega-interpreter ships as ESM only. Its single import comes from vega-util,
 * which the vega UMD bundle re-exports on `self.vega`; rewrite it into a classic
 * script that publishes `self.vegaInterpreter`. Fails closed if the published
 * file ever changes shape — a chart then falls back to source instead of
 * running an unknown transformation.
 */
export function interpreterAsClassicScript(esm: string): string {
  if (!esm.includes(INTERPRETER_IMPORT) || !esm.includes(INTERPRETER_EXPORT)) {
    throw new Error('vega-interpreter build has an unexpected shape');
  }
  const body = esm
    .replace(INTERPRETER_IMPORT, 'const { ascending, isString, DisallowedObjectProperties } = self.vega;')
    .replace(INTERPRETER_EXPORT, 'self.vegaInterpreter = { expressionInterpreter: expression };')
    .replace(/\/\/# sourceMappingURL=.*$/m, '');
  return `(function(){\n${body}\n})();`;
}

async function loadFontCss(): Promise<string> {
  try {
    const [arabic, latin] = await Promise.all([
      import('@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-arabic-400-normal.woff2?inline'),
      import('@fontsource/ibm-plex-sans-arabic/files/ibm-plex-sans-arabic-latin-400-normal.woff2?inline'),
    ]);
    const face = (src: string) =>
      `@font-face{font-family:"${FRAME_FONT_FAMILY}";font-style:normal;font-weight:400;`
      + `font-display:block;src:url(${src}) format("woff2");}`;
    const safe = [arabic.default, latin.default].filter((uri) => /^data:[\w/+.-]+;base64,[\w+/=]+$/.test(uri));
    return safe.map(face).join('');
  } catch {
    return '';
  }
}

async function loadVega(): Promise<string[]> {
  const [vega, vegaLite, interpreter, embed] = await Promise.all([
    import('/node_modules/vega/build/vega.min.js?raw'),
    import('/node_modules/vega-lite/build/vega-lite.min.js?raw'),
    import('/node_modules/vega-interpreter/build/vega-interpreter.js?raw'),
    import('/node_modules/vega-embed/build/vega-embed.min.js?raw'),
  ]);
  return [vega.default, vegaLite.default, interpreterAsClassicScript(interpreter.default), embed.default];
}

async function loadD3(): Promise<string[]> {
  const d3 = await import('/node_modules/d3/dist/d3.min.js?raw');
  return [d3.default];
}

const cache = new Map<VizLibraryKind, Promise<VizLibraries>>();

/** Loads (once) the inline sources for one frame kind. */
export function loadVizLibraries(kind: VizLibraryKind): Promise<VizLibraries> {
  let pending = cache.get(kind);
  if (!pending) {
    pending = Promise.all([kind === 'vega' ? loadVega() : loadD3(), loadFontCss()])
      .then(([scripts, fontCss]) => ({ scripts, fontCss }));
    // A failed load (offline chunk, stale deployment) may be retried by a later block.
    pending.catch(() => cache.delete(kind));
    cache.set(kind, pending);
  }
  return pending;
}
