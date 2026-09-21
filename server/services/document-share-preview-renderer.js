import path from 'node:path';

import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';

import { PreviewProtocolError as DocumentShareError } from './document-share-preview-protocol.js';

const DOCUMENT_MAX_BYTES = 25 * 1024 * 1024;

const RASTER = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif']]);
const FONTS = new Map([['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf']]);
const PREVIEW_SOURCE_MAX_BYTES = 512 * 1024;
const PREVIEW_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const PREVIEW_MAX_NODES = 10_000;
const PREVIEW_CSS_MAX_BYTES = 256 * 1024;
const PREVIEW_MAX_DECLARATIONS = 2_000;
const PREVIEW_MAX_CSS_DEPTH = 32;

function safeDataUrl(value, kind) {
  if (typeof value !== 'string' || value.length > 2_000_000) return null;
  const match = /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match || kind !== 'image') return null;
  const bytes = Buffer.from(match[2], 'base64');
  const mime = match[1].toLowerCase();
  const valid = (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    || (mime === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')))
    || (mime === 'image/gif' && /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString('ascii')))
    || (mime === 'image/webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP')
    || (mime === 'image/avif' && bytes.subarray(4, 8).toString('ascii') === 'ftyp');
  return valid && bytes.length <= DOCUMENT_MAX_BYTES ? `data:${mime};base64,${bytes.toString('base64')}` : null;
}

function exceedsCssDepth(node, depth = 0) {
  if (depth > PREVIEW_MAX_CSS_DEPTH) return true;
  return Boolean(node.nodes?.some((child) => exceedsCssDepth(child, depth + 1)));
}

function reservePreviewOutput(state, bytes) {
  state.outputBytes += bytes;
  if (state.outputBytes > PREVIEW_OUTPUT_MAX_BYTES) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
}

/** Render a constrained HTML share: all executable and remote capabilities are removed. */
export async function renderSharedDocumentPreview(source, relativePath, readAsset) {
  if (source.length > PREVIEW_SOURCE_MAX_BYTES) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
  const state = { warnings: new Set(), totalBytes: source.length, outputBytes: source.length, resources: 0, loaded: new Map() };
  const { warnings } = state;
  const reserveOutput = (bytes) => reservePreviewOutput(state, bytes);
  const asset = createAssetResolver({ relativePath, readAsset, state });
  const rewriteCss = (input, base = relativePath) => rewritePreviewCss(input, base, asset, warnings);
  return renderPreviewDom(source, { relativePath, warnings, asset, rewriteCss, reserveOutput });
}

function createAssetResolver(context) {
  const { relativePath, readAsset, state } = context;
  const { warnings, loaded } = state;
  const reserveOutput = (bytes) => reservePreviewOutput(state, bytes);
  return async (reference, kind, sourcePath = relativePath) => {
    const data = safeDataUrl(reference, kind);
    if (data) { reserveOutput(data.length); return { data, relativePath: reference }; }
    const extension = path.extname(reference.split(/[?#]/, 1)[0]).toLowerCase();
    const mime = kind === 'css' ? (extension === '.css' ? 'text/css' : null)
      : kind === 'image' ? RASTER.get(extension) : FONTS.get(extension);
    if (!mime || reference.includes('?') || reference.includes('#')) {
      warnings.add('RESOURCE_OMITTED'); return null;
    }
    const key = `${sourcePath}:${kind}:${reference}`;
    if (loaded.has(key)) {
      const cached = loaded.get(key);
      if (cached.data) reserveOutput(cached.data.length);
      return cached;
    }
    if (++state.resources > 64) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
    let file;
    try { file = await readAsset(reference, kind, sourcePath); }
    catch (error) {
      if ((error instanceof DocumentShareError && error.code === 'SHARE_UNAVAILABLE')
        || ['ELOOP', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) {
        warnings.add('RESOURCE_OMITTED'); return null;
      }
      throw error;
    }
    state.totalBytes += file.bytes.length;
    if (state.totalBytes > DOCUMENT_MAX_BYTES) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
    const result = { text: kind === 'css' ? file.bytes.toString('utf8') : null,
      data: kind === 'css' ? null : `data:${mime};base64,${file.bytes.toString('base64')}`,
      relativePath: reference };
    if (result.data) reserveOutput(result.data.length);
    loaded.set(key, result);
    return result;
  };
}

async function rewritePreviewCss(input, baseReference, asset, warnings) {
  if (Buffer.byteLength(input) > PREVIEW_CSS_MAX_BYTES) { warnings.add('STYLE_OMITTED'); return ''; }
  let sheet;
  try { sheet = postcss.parse(input); } catch { warnings.add('STYLE_OMITTED'); return ''; }
  if (exceedsCssDepth(sheet)) { warnings.add('STYLE_OMITTED'); return ''; }
  const removals = [];
  sheet.walkAtRules((rule) => { if (rule.name.toLowerCase() === 'import') { warnings.add('STYLE_OMITTED'); removals.push(rule); } });
  removals.forEach((rule) => rule.remove());
  const declarations = [];
  sheet.walkDecls((decl) => declarations.push(decl));
  if (declarations.length > PREVIEW_MAX_DECLARATIONS) { warnings.add('STYLE_OMITTED'); return ''; }
  for (const decl of declarations) await rewriteDeclaration(decl, baseReference, asset, warnings);
  return sheet.toString();
}

async function rewriteDeclaration(decl, baseReference, asset, warnings) {
  const parsed = valueParser(decl.value);
  if (exceedsValueDepth(parsed.nodes)) { decl.remove(); warnings.add('STYLE_OMITTED'); return; }
  const nodes = [];
  let unsupported = false;
  parsed.walk((node) => {
    if (node.type === 'function' && node.value.toLowerCase() === 'url') nodes.push(node);
    if (node.type === 'function' && ['image-set', 'cross-fade'].includes(node.value.toLowerCase())) unsupported = true;
  });
  if (unsupported) { decl.remove(); warnings.add('STYLE_OMITTED'); return; }
  for (const node of nodes) {
    const raw = valueParser.stringify(node.nodes).trim().replace(/^(?:"|')|(?:"|')$/g, '');
    const kind = /font/i.test(decl.prop) || decl.prop === 'src' ? 'font' : 'image';
    const value = await asset(raw, kind, baseReference);
    if (!value) { decl.remove(); break; }
    node.nodes = [{ type: 'word', value: value.data ?? '' }];
  }
  if (decl.parent) decl.value = parsed.toString();
}

function exceedsValueDepth(nodes) {
  const pending = nodes.map((node) => ({ node, depth: 0 }));
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (depth > PREVIEW_MAX_CSS_DEPTH) return true;
    for (const child of node.nodes ?? []) pending.push({ node: child, depth: depth + 1 });
  }
  return false;
}

async function renderPreviewDom(source, context) {
  const { warnings } = context;
  const dom = new JSDOM(source.toString('utf8'), { runScripts: undefined, resources: undefined });
  try {
    const { document } = dom.window;
    if (document.querySelectorAll('*').length > PREVIEW_MAX_NODES) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
    removeActiveContent(document, warnings);
    await inlineResources(document, context);
    return sanitizePreview(document, dom.window, warnings);
  } finally { dom.window.close(); }
}

function removeActiveContent(document, warnings) {
  const blocked = document.querySelectorAll('script,iframe,frame,frameset,object,embed,applet,form,base,meta,svg,math,video,audio,source,track');
  if (blocked.length) warnings.add('CONTENT_OMITTED');
  blocked.forEach((node) => node.remove());
  document.querySelectorAll('*').forEach((node) => {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ['style', 'srcset', 'action', 'formaction', 'target', 'background', 'poster', 'ping', 'cite', 'data'].includes(attribute.name.toLowerCase())) node.removeAttribute(attribute.name);
    }
    if (node.tagName === 'A') node.removeAttribute('href');
  });
}

async function inlineResources(document, context) {
  const { relativePath, asset, rewriteCss, reserveOutput } = context;
  const inlineStyles = [...document.querySelectorAll('style')];
  for (const link of [...document.querySelectorAll('link')]) {
    if (link.getAttribute('rel')?.toLowerCase() !== 'stylesheet') { link.remove(); continue; }
    const stylesheet = await asset(link.getAttribute('href') || '', 'css', relativePath);
    if (!stylesheet) { link.remove(); continue; }
    const style = document.createElement('style');
    const css = await rewriteCss(stylesheet.text, path.posix.join(path.posix.dirname(relativePath), stylesheet.relativePath));
    reserveOutput(Buffer.byteLength(css));
    style.textContent = css;
    link.replaceWith(style);
  }
  for (const style of inlineStyles) style.textContent = await rewriteCss(style.textContent || '', relativePath);
  for (const image of [...document.querySelectorAll('img')]) {
    const value = await asset(image.getAttribute('src') || '', 'image', relativePath);
    if (!value) image.remove(); else image.setAttribute('src', typeof value === 'string' ? value : value.data);
  }
  document.querySelectorAll('*:not(img)').forEach((node) => {
    node.removeAttribute('src');
    node.removeAttribute('href');
  });
}

function sanitizePreview(document, window, warnings) {
  const purifier = createDOMPurify(window);
  const html = purifier.sanitize(document.documentElement.outerHTML, {
    WHOLE_DOCUMENT: true,
    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'meta', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'action', 'formaction', 'target'],
  });
  if (Buffer.byteLength(html) > PREVIEW_OUTPUT_MAX_BYTES) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
  return { html, warnings: [...warnings] };
}
