import type { FileHandle } from 'node:fs/promises';

/**
 * Bounded, streaming read of the leading JSONL records of a pinned transcript
 * (ADR-201 A1.4). A record's id key is not always inside the first 64 KiB: a
 * Claude conversation that opens with a pasted log or image has a first record
 * of megabytes whose `sessionId` key comes last. Rather than parse such a
 * record, this scanner walks it once in 64 KiB chunks with O(1) state and picks
 * out the string values at the requested key paths (`['sessionId']`,
 * `['payload', 'id']`). Only a key of an object at that exact path counts — a
 * `"sessionId"` text inside a message is an escaped string, never a key.
 *
 * L4 (ADR-201 qa): the scanner must never see another value than JSON.parse
 * does. JSON.parse keeps the LAST of duplicate keys and decodes escaped keys and
 * values, which this scanner does not; so a target path whose key (or a parent
 * key) occurs twice in one record whatever the value types (R3), whose value is
 * escaped (or too long to capture), or that an escaped key could spell, reports
 * {@link AMBIGUOUS_HEADER_VALUE}. That value equals no id, so every binder
 * refuses the file. Paths are matched key by key: a dotted key such as
 * `"payload.id"` is not the path `payload` → `id`.
 */

/** Value reported for a target path the scanner cannot read unambiguously (never a valid id). */
export const AMBIGUOUS_HEADER_VALUE = '\u0000ambiguous';

export const HEADER_CHUNK_BYTES = 64 * 1024;
/** Hard bound on bytes scanned per candidate; a longer leading record is refused as oversize. */
export const HEADER_SCAN_LIMIT_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE = 256;
const MAX_DEPTH = 8;
/** Characters that end an uncaptured string run: quote, escape, or a (malformed) raw newline. */
const STRING_STOP = /["\\\n]/g;

/** String values of one record at the requested paths, keyed by `path.join('.')`. */
export type HeaderRecord = Readonly<Record<string, string>>;

/** `stop` ends the scan; `next` moves to the following record. */
export type HeaderVisit = (record: HeaderRecord) => 'stop' | 'next';

export type HeaderScanEnd = 'stopped' | 'eof' | 'oversize';

/** Character-level state of one JSONL record. */
class RecordScanner {
  /** Target paths by identity (`JSON.stringify(path)`, so a dotted key never aliases a path). */
  private readonly targets: Map<string, readonly string[]>;
  /** Identities of every target path and of each of its parents. */
  private readonly targetPrefixes: Set<string>;
  private values: Record<string, string> = {};
  /** Target (or target parent) key paths already met in this record. */
  private seenKeys = new Set<string>();
  private containers: string[] = [];
  private keys: Array<string | null> = [];
  private expectKey = false;
  private inString = false;
  private escaped = false;
  /** The current string contained an escape sequence. */
  private stringEscaped = false;
  private capture: string | null = null;

  constructor(paths: readonly (readonly string[])[]) {
    this.targets = new Map(paths.map((keyPath) => [JSON.stringify(keyPath), keyPath] as const));
    this.targetPrefixes = new Set(paths.flatMap((keyPath) =>
      keyPath.map((_key, index) => JSON.stringify(keyPath.slice(0, index + 1)))));
  }

  /** Values collected so far for the current record; resets the record state. */
  take(): HeaderRecord {
    const record = this.values;
    this.values = {};
    this.seenKeys = new Set();
    this.containers = [];
    this.keys = [];
    this.expectKey = false;
    this.inString = false;
    this.escaped = false;
    this.stringEscaped = false;
    this.capture = null;
    return record;
  }

  /**
   * Feeds `text` from `start` up to the next record separator. Returns the
   * separator's index, or -1 when the whole rest of `text` was consumed. Long
   * string values that are not captured are skipped with one regex search.
   */
  feed(text: string, start: number): number {
    for (let index = start; index < text.length; index += 1) {
      if (this.inString && this.capture === null && !this.escaped) {
        STRING_STOP.lastIndex = index;
        const stop = STRING_STOP.exec(text);
        if (!stop) return -1;
        index = stop.index;
      }
      const ch = text[index];
      if (ch === '\n') return index;
      if (this.inString) this.feedString(ch);
      else this.feedStructure(ch);
    }
    return -1;
  }

  private feedString(ch: string): void {
    if (this.escaped) {
      this.escaped = false;
      this.stringEscaped = true;
      this.capture = null;
    } else if (ch === '\\') {
      this.escaped = true;
    } else if (ch === '"') {
      this.inString = false;
      this.endString();
    } else if (this.capture !== null) {
      this.capture = this.capture.length < MAX_CAPTURE ? this.capture + ch : null;
    }
  }

  private feedStructure(ch: string): void {
    const depth = this.containers.length;
    if (ch === '"') {
      this.inString = true;
      this.stringEscaped = false;
      this.capture = depth > 0 && depth <= MAX_DEPTH ? '' : null;
    } else if (ch === '{' || ch === '[') {
      this.containers.push(ch);
      this.keys[depth + 1] = null;
      this.expectKey = ch === '{';
    } else if (ch === '}' || ch === ']') {
      this.containers.pop();
      this.expectKey = false;
    } else if (ch === ',') {
      this.expectKey = this.containers[depth - 1] === '{';
    } else if (ch === ':') {
      this.expectKey = false;
    }
  }

  private endString(): void {
    const depth = this.containers.length;
    const text = this.capture;
    const escaped = this.stringEscaped;
    this.capture = null;
    if (depth === 0 || depth > MAX_DEPTH) return;
    if (this.expectKey && this.containers[depth - 1] === '{') {
      // An escaped key may decode to a target name (or to a target's parent).
      this.keys[depth] = escaped ? null : text;
      // An escaped key may decode to any target under the known parent keys.
      if (escaped) this.poison(this.keys.slice(1, depth), depth);
      else this.noteKey(depth);
      return;
    }
    const keyPath = this.objectKeyPath(depth);
    const target = keyPath && this.targets.get(JSON.stringify(keyPath));
    if (!target) return;
    const joined = target.join('.');
    // Duplicate key (JSON.parse keeps the last), or a value this scan did not read verbatim.
    this.values[joined] = text === null || escaped || joined in this.values ? AMBIGUOUS_HEADER_VALUE : text;
  }

  /** Key path of the value at `depth` when every container is an object and every key is known, else null. */
  private objectKeyPath(depth: number): string[] | null {
    if (!this.containers.every((container) => container === '{')) return null;
    const keyPath = this.keys.slice(1, depth + 1);
    return keyPath.some((key) => key === null) ? null : keyPath as string[];
  }

  /**
   * R3: a second key at a target path, or at a target's parent, makes every
   * target under it ambiguous whatever the value types (JSON.parse keeps the
   * last value, which may be a number, null, an object or an array).
   */
  private noteKey(depth: number): void {
    const keyPath = this.objectKeyPath(depth);
    if (!keyPath) return;
    const identity = JSON.stringify(keyPath);
    if (!this.targetPrefixes.has(identity)) return;
    if (this.seenKeys.has(identity)) this.poison(keyPath, keyPath.length);
    else this.seenKeys.add(identity);
  }

  /** Marks every target of at least `minLength` keys that starts with `prefix` (an unknown key matches none). */
  private poison(prefix: readonly (string | null)[], minLength: number): void {
    for (const target of this.targets.values()) {
      if (target.length >= minLength && prefix.every((key, index) => key === target[index])) {
        this.values[target.join('.')] = AMBIGUOUS_HEADER_VALUE;
      }
    }
  }
}

/**
 * Scans the leading records of `fd` from offset 0, calling `visit` with each
 * record's values at `paths` until it returns `stop`, the file ends (`eof`; a
 * final record without a newline is still visited), or `limit` bytes were read
 * without the visit stopping (`oversize`). Reads are positional: the
 * descriptor's file position is untouched.
 */
export async function scanHeaderRecords(
  fd: FileHandle,
  paths: readonly (readonly string[])[],
  visit: HeaderVisit,
  limit: number = HEADER_SCAN_LIMIT_BYTES,
): Promise<HeaderScanEnd> {
  const scanner = new RecordScanner(paths);
  const decoder = new TextDecoder('utf-8');
  const chunk = Buffer.alloc(HEADER_CHUNK_BYTES);
  let pendingRecord = false;
  for (let position = 0; position < limit;) {
    const { bytesRead } = await fd.read(chunk, 0, Math.min(chunk.length, limit - position), position);
    if (bytesRead === 0) break;
    position += bytesRead;
    const text = decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
    for (let start = 0; start < text.length;) {
      const separator = scanner.feed(text, start);
      const end = separator < 0 ? text.length : separator;
      pendingRecord ||= end > start;
      if (separator < 0) break;
      start = separator + 1;
      if (!pendingRecord) continue;
      pendingRecord = false;
      if (visit(scanner.take()) === 'stop') return 'stopped';
    }
    if (bytesRead < Math.min(chunk.length, limit - (position - bytesRead))) break;
  }
  const { size } = await fd.stat({ bigint: true });
  if (BigInt(limit) < size) return 'oversize';
  if (pendingRecord && visit(scanner.take()) === 'stop') return 'stopped';
  return 'eof';
}
