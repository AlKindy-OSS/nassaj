import { fileURLToPath } from 'node:url';

import { renderSharedDocumentPreview } from './document-share-preview-renderer.js';
import { CHILD_WIRE_BYTES, PARENT_WIRE_BYTES, createMessageReader, createMessageWriter,
  decodeBytes, exactFields, PreviewProtocolError } from './document-share-preview-protocol.js';

async function readAsset(state, reference, kind, baseReference) {
  if (state.pending) throw new PreviewProtocolError();
  const id = ++state.seq;
  const result = new Promise((resolve, reject) => { state.pending = { id, resolve, reject }; });
  await state.send({ type: 'asset', seq: id, kind, reference, baseReference });
  return result;
}

async function render(message, state) {
  try {
    const source = decodeBytes(message.bytes, 512 * 1024);
    const result = await state.render(source, message.relativePath, (...args) => readAsset(state, ...args));
    await state.send({ type: 'result', html: Buffer.from(result.html).toString('base64'), warnings: result.warnings });
  } catch (error) {
    await state.send({ type: 'error', code: error?.code === 'DOCUMENT_TOO_LARGE' ? error.code : 'TEMPORARILY_UNAVAILABLE' });
  }
  state.output.end();
  state.input.destroy();
}

function receive(message, state) {
  if (!state.started) {
    if (!exactFields(message, ['type', 'relativePath', 'bytes']) || message.type !== 'source'
      || typeof message.relativePath !== 'string' || message.relativePath.length > 1024) throw new PreviewProtocolError();
    state.started = true;
    void render(message, state).catch(() => state.terminate(1));
    return;
  }
  if (!state.pending || !exactFields(message, ['type', 'seq', 'bytes']) || message.type !== 'asset'
    || message.seq !== state.pending.id) throw new PreviewProtocolError();
  const request = state.pending;
  state.pending = null;
  if (message.bytes === null) request.reject(new PreviewProtocolError('SHARE_UNAVAILABLE', 404));
  else request.resolve({ bytes: decodeBytes(message.bytes, 25 * 1024 * 1024) });
}

/** Run the fixed parser protocol on supplied streams; injectable renderer enables direct coverage. */
export function runDocumentPreviewParser(input, output, terminate, renderer = renderSharedDocumentPreview) {
  const state = { input, output, terminate, render: renderer, started: false, seq: 0, pending: null,
    send: createMessageWriter(output, CHILD_WIRE_BYTES) };
  const detach = createMessageReader(input, PARENT_WIRE_BYTES, (message) => receive(message, state), () => terminate(1));
  input.on('end', () => terminate(0));
  output.on('error', () => terminate(1));
  return detach;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runDocumentPreviewParser(process.stdin, process.stdout, (code) => process.exit(code));
}
