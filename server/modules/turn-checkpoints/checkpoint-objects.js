/**
 * T-2095 M3: in-process loose-object writer. A blob is written from the exact
 * scanned bytes without spawning git per file: the object id is the hash of
 * "blob <len>\0" + bytes in the store's object format, the body is
 * zlib-deflated, and the file lands atomically (temporary file + rename) at
 * objects/<id[0:2]>/<id[2:]>. Content addressing makes a concurrent identical
 * write harmless.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const deflate = promisify(zlib.deflate);
const FORMAT_PATTERN = /^\s*objectformat\s*=\s*(sha1|sha256)\s*$/im;
const formats = new Map();

/** The store's object format ('sha1' or 'sha256'), read once from its server-written config. */
export async function storeObjectFormat(store) {
  if (!formats.has(store)) {
    const config = await fs.readFile(path.join(store, 'config'), 'utf8');
    formats.set(store, FORMAT_PATTERN.exec(config)?.[1] ?? 'sha1');
  }
  return formats.get(store);
}

/**
 * Writes one blob into the store and returns its object id.
 * @param {string} store bare checkpoint store
 * @param {Buffer} body exact bytes to store
 * @returns {Promise<string>}
 */
export async function writeLooseBlob(store, body) {
  const format = await storeObjectFormat(store);
  const header = Buffer.from(`blob ${body.length}\0`, 'latin1');
  const oid = crypto.createHash(format).update(header).update(body).digest('hex');
  const directory = path.join(store, 'objects', oid.slice(0, 2));
  const target = path.join(directory, oid.slice(2));
  try {
    await fs.access(target);
    return oid;
  } catch {
    // absent: write it below
  }
  const compressed = await deflate(Buffer.concat([header, body]));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `tmp_obj_${crypto.randomUUID()}`);
  await fs.writeFile(temporary, compressed, { mode: 0o444, flag: 'wx' });
  await fs.rename(temporary, target);
  return oid;
}
