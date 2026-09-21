import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DOCUMENT_MAX_BYTES, DocumentShareError, readSharedDocument, readSharedPageAsset } from './document-share-files.js';
import { CHILD_WIRE_BYTES, PARENT_WIRE_BYTES, createMessageReader, createMessageWriter,
  decodeBytes, exactFields } from './document-share-preview-protocol.js';

const SOURCE_BYTES = 512 * 1024;
const OUTPUT_BYTES = 8 * 1024 * 1024;
const CHILD_MODULE = fileURLToPath(new URL('./document-share-preview-child.js', import.meta.url));
const WARNINGS = new Set(['RESOURCE_OMITTED', 'STYLE_OMITTED', 'CONTENT_OMITTED']);
const RESOURCE_EXTENSIONS = { css: new Set(['.css']), image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']), font: new Set(['.woff2', '.woff', '.ttf', '.otf']) };
let activeBundles = 0;

/** CSP shared by the preview route and its isolated renderer. */
export const documentPreviewCsp = () => "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
/** Whether the stored document supports a static HTML preview. */
export const isPreviewableDocument = (relativePath) => ['.html', '.htm', '.xhtml'].includes(path.extname(relativePath).toLowerCase());

/** Launch only the fixed parser module with a minimal environment and a 128 MiB V8 heap. */
export function launchDocumentPreviewParser() {
  // Fixed parser executable and module, never a user command or inherited Node flags.
  // This is a performance boundary, not an OS sandbox or a total RSS limit.
  return spawn(process.execPath, ['--max-old-space-size=128', CHILD_MODULE], {
    shell: false, cwd: path.dirname(CHILD_MODULE),
    // Node otherwise reinserts this parent variable even with an explicit env.
    env: { LANG: 'C.UTF-8', TZ: 'UTC', NODE_V8_COVERAGE: undefined },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
}

function publicFailure(error) {
  if (error instanceof DocumentShareError) return error;
  if (error?.code === 'DOCUMENT_TOO_LARGE') return new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
  return new DocumentShareError('TEMPORARILY_UNAVAILABLE', 503);
}

function createLifetime(signal) {
  const abort = new AbortController();
  const state = { abort, child: null, exited: Promise.resolve(), failure: null, pending: new Set() };
  state.result = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
  // Source reads/startup can still be in flight when the deadline rejects the result.
  state.result.catch(() => {});
  state.fail = (error) => {
    if (state.failure) return;
    state.failure = publicFailure(error);
    abort.abort();
    state.child?.kill('SIGKILL');
    state.reject(state.failure);
  };
  const cancel = () => state.fail(new DocumentShareError('REQUEST_CANCELLED', 499));
  const timer = setTimeout(() => state.fail(new DocumentShareError('PREVIEW_TIMEOUT', 504)), 3000);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  state.cleanup = async () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    abort.abort();
    state.child?.kill('SIGKILL');
    await state.exited;
    await Promise.allSettled([...state.pending]);
    state.detach?.();
    state.child?.stdin.destroy();
    state.child?.stdout.destroy();
  };
  return state;
}

async function trackIO(state, operation) {
  if (state.failure) throw state.failure;
  const pending = Promise.resolve().then(operation);
  state.pending.add(pending);
  try { return await pending; } finally { state.pending.delete(pending); }
}

function connectChild(state, child, handleMessage) {
  state.child = child;
  state.exited = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', (error) => { if (!child.pid) resolve(); state.fail(error); });
  });
  const completed = () => {
    if (!state.receivedResult) state.fail(new DocumentShareError('TEMPORARILY_UNAVAILABLE', 503));
  };
  child.once('close', completed);
  child.stdout.once('end', completed);
  child.stdin.on('error', state.fail);
  state.detach = createMessageReader(child.stdout, CHILD_WIRE_BYTES, handleMessage, state.fail);
  const send = createMessageWriter(child.stdin, PARENT_WIRE_BYTES, state.abort.signal);
  return (message) => trackIO(state, () => send(message));
}

function validateRequest(message, context) {
  if (!exactFields(message, ['type', 'seq', 'kind', 'reference', 'baseReference'])
    || message.type !== 'asset' || message.seq !== context.seq + 1
    || !Object.hasOwn(RESOURCE_EXTENSIONS, message.kind)
    || typeof message.reference !== 'string' || !message.reference.length || message.reference.length > 512
    || typeof message.baseReference !== 'string' || message.baseReference.length > 1024
    || !context.bases.has(message.baseReference)
    || !RESOURCE_EXTENSIONS[message.kind].has(path.posix.extname(message.reference).toLowerCase())) {
    throw new DocumentShareError('TEMPORARILY_UNAVAILABLE', 503);
  }
  context.seq++;
  if (context.seq > 64) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
}

async function serveAsset(message, context, state, readAsset, send) {
  validateRequest(message, context);
  let file;
  try {
    file = await trackIO(state, () => readAsset(context.root, context.relativePath, message.reference,
      context.identity, state.abort.signal, message.baseReference));
  } catch (error) {
    if (error?.code === 'SHARE_UNAVAILABLE' || ['ELOOP', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error?.code)) {
      if (!state.failure) await send({ type: 'asset', seq: message.seq, bytes: null });
      return;
    }
    throw error;
  }
  if (state.failure) throw state.failure;
  context.bytes += file.bytes.length;
  if (context.bytes > DOCUMENT_MAX_BYTES) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
  if (message.kind === 'css') context.bases.add(file.relativePath);
  await send({ type: 'asset', seq: message.seq, bytes: file.bytes.toString('base64') });
}

function acceptResult(message, state) {
  if (exactFields(message, ['type', 'code']) && message.type === 'error') {
    throw new DocumentShareError(message.code === 'DOCUMENT_TOO_LARGE' ? message.code : 'TEMPORARILY_UNAVAILABLE',
      message.code === 'DOCUMENT_TOO_LARGE' ? 413 : 503);
  }
  if (!exactFields(message, ['type', 'html', 'warnings']) || message.type !== 'result'
    || !Array.isArray(message.warnings) || message.warnings.length > 3
    || message.warnings.some((warning) => !WARNINGS.has(warning))) {
    throw new DocumentShareError('TEMPORARILY_UNAVAILABLE', 503);
  }
  const html = decodeBytes(message.html, OUTPUT_BYTES).toString('utf8');
  state.receivedResult = true;
  state.resolve({ html, warnings: message.warnings });
}

/** Inject file/process boundaries into a closure; the public route always uses the fixed defaults. */
export function createSharedDocumentPreviewBuilder({ readDocument = readSharedDocument,
  readAsset = readSharedPageAsset, launchChild = launchDocumentPreviewParser } = {}) {
  return async (root, relativePath, identity, signal) => {
    if (!isPreviewableDocument(relativePath)) throw new DocumentShareError('SHARE_UNAVAILABLE');
    if (activeBundles >= 2) throw new DocumentShareError('RATE_LIMITED', 429);
    activeBundles++;
    const state = createLifetime(signal);
    try {
      const source = await trackIO(state, () => readDocument(root, relativePath, identity, state.abort.signal, SOURCE_BYTES));
      if (state.failure) throw state.failure;
      if (source.length > SOURCE_BYTES) throw new DocumentShareError('DOCUMENT_TOO_LARGE', 413);
      const context = { root, relativePath, identity, bytes: source.length, seq: 0, bases: new Set([relativePath]) };
      let send;
      send = connectChild(state, launchChild(), (message) => {
        if (state.failure || state.receivedResult) throw state.failure ?? new DocumentShareError('TEMPORARILY_UNAVAILABLE', 503);
        if (message?.type === 'asset') return serveAsset(message, context, state, readAsset, send);
        acceptResult(message, state);
      });
      await send({ type: 'source', relativePath, bytes: source.toString('base64') });
      const result = await state.result;
      if (state.failure) throw state.failure;
      return result;
    } catch (error) { throw state.failure ?? publicFailure(error); }
    finally { await state.cleanup(); activeBundles--; }
  };
}

/** Assemble a preview under the global two-child capacity and three-second deadline. */
export const buildSharedDocumentPreview = createSharedDocumentPreviewBuilder();
