import fs from 'node:fs';
import path from 'node:path';

export const connectorCliFailure = (code, detail, json = false) => {
  const value = { ok: false, code, detail };
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `FAIL ${code}: ${detail}\n`);
  process.exitCode = 2;
};

export const readBoundedPrivateInput = async (file, { secret = false, maximumBytes = 1024 * 1024 } = {}) => {
  if (file === '-') {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length; if (size > maximumBytes) throw new Error('CONNECTOR_INPUT_TOO_LARGE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const resolved = path.resolve(file); const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('CONNECTOR_INPUT_NOT_REGULAR');
  if (secret && (stat.mode & 0o077) !== 0) throw new Error('CONNECTOR_SECRETS_FILE_PERMISSIONS');
  if (stat.size < 2 || stat.size > maximumBytes) throw new Error('CONNECTOR_INPUT_SIZE_INVALID');
  const descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const pinned = fs.fstatSync(descriptor);
    if (!pinned.isFile() || pinned.dev !== stat.dev || pinned.ino !== stat.ino) {
      throw new Error('CONNECTOR_INPUT_IDENTITY_CHANGED');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally { fs.closeSync(descriptor); }
};

export const exactJson = (raw) => {
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('CONNECTOR_INPUT_JSON_INVALID');
  return parsed;
};
