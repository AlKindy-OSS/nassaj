/**
 * Builds the `srcdoc` of the sandboxed chart frame (Vega-Lite, Vega, D3).
 *
 * Security model (ADR-211): the frame runs with `sandbox="allow-scripts"` only,
 * so it has an opaque origin — no cookies, no storage, no access to the parent
 * DOM, no popups, forms, modals or top navigation. The CSP below additionally
 * removes every network channel (`connect-src 'none'`, images and fonts only as
 * data:/blob:) and every non-inline script source, so the inlined libraries and
 * the block itself are the only code that can run, and the document itself
 * cannot fetch, load or beacon anything.
 *
 * What neither the sandbox nor this CSP stops: the frame navigating ITSELF
 * (`location.href` or a clicked link). That is blocked by the app page's
 * ENFORCED `frame-src 'self' blob:` (server/middleware/frame-src-csp.js,
 * B-1657): the browser refuses an external target before any request is sent.
 * It is server-side, so it holds only where the server serves the HTML (not
 * the Vite dev server). The parent also removes the frame on any `load` after
 * the first (`VizSandbox`), but that alone never fires for a page that keeps
 * loading. No 'unsafe-eval': Vega runs through its AST interpreter instead of
 * codegen.
 */

import { FRAME_FONT_FAMILY } from './vizLibraries';

export type FrameKind = 'vega' | 'd3';

export const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** Message channel tag shared by both sides of the postMessage protocol. */
export const FRAME_CHANNEL = 'nassaj-viz';

/** Height the D3 function receives as its drawing area. */
export const D3_DEFAULT_HEIGHT = 360;

/**
 * Neutralizes the two sequences that can end or re-mode an inline <script>
 * element early. Both rewrites are no-ops for the JavaScript meaning of the
 * text wherever they can legally appear (strings, regexes, comments).
 */
export function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

/**
 * The runtime that lives inside the frame. Plain ES5-ish text on purpose: it
 * is inlined verbatim and never passes through the app's bundler.
 */
function frameRuntime(kind: FrameKind, nonce: string): string {
  return `(function(){
'use strict';
var NONCE=${JSON.stringify(nonce)},KIND=${JSON.stringify(kind)},CH=${JSON.stringify(FRAME_CHANNEL)};
var parentWin=window.parent,root=document.getElementById('root'),failed=false;
function post(type,extra){var m={channel:CH,nonce:NONCE,type:type};if(extra){for(var k in extra){m[k]=extra[k];}}parentWin.postMessage(m,'*');}
function fail(err){if(failed)return;failed=true;var t=err&&err.message?err.message:String(err);
  if(KIND==='d3'&&/EvalError|evaluate a string/i.test(String(err&&err.name)+' '+t)){t+=' (eval is blocked here; d3.csvParse/tsvParse need it, use d3.csvParseRows/tsvParseRows instead)';}
  post('error',{message:String(t).slice(0,300)});}
function reportHeight(){post('height',{height:Math.ceil(document.body.scrollHeight)});}
window.addEventListener('error',function(e){fail(e.message||'Script error');});
window.addEventListener('unhandledrejection',function(e){fail(e.reason);});
if(typeof ResizeObserver==='function'){new ResizeObserver(reportHeight).observe(document.body);}
function refuse(){return Promise.reject(new Error('External data is disabled in chat charts'));}
function runVega(msg){
  var loader=vega.loader();loader.load=refuse;loader.sanitize=refuse;loader.http=refuse;loader.file=refuse;
  var spec=msg.spec;
  // vega-embed merges usermeta.embedOptions over ours (ast, actions, loader…).
  if(spec&&spec.usermeta&&typeof spec.usermeta==='object'){delete spec.usermeta.embedOptions;}
  if(msg.mode==='vega-lite'&&spec&&spec.width===undefined&&!spec.facet&&!spec.repeat&&!spec.concat&&!spec.hconcat&&!spec.vconcat){spec.width='container';}
  var level=0,logger={level:function(l){if(arguments.length){level=l;return logger;}return level;},
    error:function(){fail([].slice.call(arguments).join(' '));return logger;},
    warn:function(){var t=[].slice.call(arguments).join(' ');if(/Loading failed/.test(t)){fail(t);}return logger;},info:function(){return logger;},debug:function(){return logger;}};
  var opts={mode:msg.mode,actions:false,renderer:'svg',ast:true,expr:vegaInterpreter.expressionInterpreter,loader:loader,logger:logger,
    config:{background:'transparent',font:${JSON.stringify(`"${FRAME_FONT_FAMILY}", sans-serif`)}}};
  if(msg.theme==='dark'){opts.theme='dark';}
  return vegaEmbed(root,spec,opts);
}
function runD3(msg){
  if(typeof window.__nassajD3!=='function'){throw new Error('D3 block did not load');}
  return window.__nassajD3(d3,root,msg.width,${D3_DEFAULT_HEIGHT});
}
window.addEventListener('message',function(e){
  if(e.source!==parentWin)return;
  var msg=e.data;
  if(!msg||msg.channel!==CH||msg.nonce!==NONCE||msg.type!=='render')return;
  var dark=msg.theme==='dark';
  document.documentElement.setAttribute('data-theme',dark?'dark':'light');
  document.documentElement.style.colorScheme=dark?'dark':'light';
  try{
    Promise.resolve(KIND==='d3'?runD3(msg):runVega(msg)).then(function(){if(!failed){post('rendered');reportHeight();}},fail);
  }catch(err){fail(err);}
});
window.addEventListener('load',function(){if(!failed){post('ready');}});
})();`;
}

const FRAME_STYLE = `
html,body{margin:0;padding:0;background:transparent;overflow:hidden;}
html{color:#1f2937;color-scheme:light;}
html[data-theme=dark]{color:#e5e7eb;}
body{font-family:"${FRAME_FONT_FAMILY}",system-ui,sans-serif;font-size:13px;line-height:1.5;}
#root{padding:8px;box-sizing:border-box;width:100%;max-width:100%;overflow-x:auto;}
#root svg{max-width:100%;height:auto;}
.vega-embed{width:100%;}
`;

export type FrameDocumentInput = {
  kind: FrameKind;
  nonce: string;
  libraries: string[];
  fontCss: string;
  /** D3 only: the block's code, wrapped as the body of a function. */
  userCode?: string;
};

/** Returns the complete HTML for the frame's `srcdoc`. */
export function buildFrameDocument({ kind, nonce, libraries, fontCss, userCode }: FrameDocumentInput): string {
  const scripts = libraries.map((lib) => `<script>${escapeInlineScript(lib)}</script>`);
  scripts.push(`<script>${escapeInlineScript(frameRuntime(kind, nonce))}</script>`);
  if (kind === 'd3') {
    const body = escapeInlineScript(userCode ?? '');
    scripts.push(`<script>window.__nassajD3=(function(d3, root, width, height){\n${body}\n});</script>`);
  }
  return [
    '<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    `<style>${fontCss}${FRAME_STYLE}</style>`,
    '</head><body><div id="root" dir="ltr"></div>',
    scripts.join(''),
    '</body></html>',
  ].join('');
}

/** Frame height bounds; the frame reports its own height inside these. */
export const MIN_FRAME_HEIGHT = 80;
export const MAX_FRAME_HEIGHT = 1200;
/**
 * After the iframe's first `load` event (its scripts have run by then), a frame
 * that has not said `ready` within this window is treated as broken.
 */
export const READY_AFTER_LOAD_MS = 3000;
/** Overall cap from mount to `ready` (slow devices parse ~1 MB of inline script). */
export const READY_TIMEOUT_MS = 15000;
/** A render that has not finished by then is treated as broken. */
export const RENDER_TIMEOUT_MS = 10000;

export function clampFrameHeight(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(value)));
}
