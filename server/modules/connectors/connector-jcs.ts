/** Strict RFC 8785-style canonical JSON helpers for signed connector policy artifacts. */

const hasInvalidUnicode = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
};

export const isConnectorPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

/** RFC 8785 key ordering is lexicographic over UTF-16 code units. */
export const connectorJcs = (value: unknown): string => {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') {
    if (hasInvalidUnicode(value)) throw new Error('connector_jcs_invalid_unicode');
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('connector_jcs_invalid_number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(connectorJcs).join(',')}]`;
  if (!isConnectorPlainObject(value)) throw new Error('connector_jcs_unsupported_value');
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    if (hasInvalidUnicode(key)) throw new Error('connector_jcs_invalid_unicode');
    if (value[key] === undefined) throw new Error('connector_jcs_unsupported_value');
  }
  return `{${keys.map(key => `${JSON.stringify(key)}:${connectorJcs(value[key])}`).join(',')}}`;
};

/** A textual parser that rejects duplicates, whitespace, and all non-canonical spellings. */
export const parseConnectorCanonicalJson = (text: string): unknown | null => {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1_048_576) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return connectorJcs(parsed) === text ? parsed : null;
  } catch {
    return null;
  }
};

/** Own an object input, or parse a byte-for-byte canonical JSON text input. */
export const ownConnectorJsonValue = (value: unknown): unknown | null => {
  if (typeof value === 'string') return parseConnectorCanonicalJson(value);
  try { return structuredClone(value); } catch { return null; }
};

export const connectorExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
};

export const connectorStrictIsoTime = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds : null;
};

export const connectorPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && !Object.is(value, -0);

export const connectorNonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);

export const connectorValidId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);

export const connectorValidSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);

export const connectorValidSha512 = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{86}$/u.test(value);

export const connectorDeepFreeze = <T>(value: T): Readonly<T> => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) connectorDeepFreeze(nested);
    Object.freeze(value);
  }
  return value;
};
