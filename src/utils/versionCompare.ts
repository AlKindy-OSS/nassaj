/** Parsed client-side version used only for ordering already-observed labels. */
export type ParsedVersion = {
  raw: string;
  valid: boolean;
  core: string[];
  prerelease: string[];
};

const NUMERIC = /^\d+$/;

const invalidVersion = (raw: string): ParsedVersion => ({
  raw,
  valid: false,
  core: [],
  prerelease: [],
});

/**
 * Parses a version label for display ordering. This does not relax the strict
 * four-part admission rules enforced by the server and health contracts.
 */
export function parseVersion(input: unknown): ParsedVersion {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return invalidVersion(raw);

  const body = raw.replace(/^[vV]/, '').split('+')[0];
  const dashIndex = body.indexOf('-');
  const coreText = dashIndex === -1 ? body : body.slice(0, dashIndex);
  const prereleaseText = dashIndex === -1 ? '' : body.slice(dashIndex + 1);
  if (!coreText || (dashIndex !== -1 && prereleaseText.length === 0)) {
    return invalidVersion(raw);
  }

  const segments = coreText.split('.');
  if (!segments.every((segment) => NUMERIC.test(segment))) return invalidVersion(raw);

  const prerelease = prereleaseText ? prereleaseText.split('.') : [];
  if (prerelease.some((identifier) => identifier.length === 0)) return invalidVersion(raw);

  return { raw, valid: true, core: segments, prerelease };
}

const sign = (value: number): number => value > 0 ? 1 : value < 0 ? -1 : 0;

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = NUMERIC.test(left);
  const rightNumeric = NUMERIC.test(right);
  if (leftNumeric && rightNumeric) return compareNumericText(left, right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return sign(left < right ? -1 : left > right ? 1 : 0);
}

function compareNumericText(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '');
  const normalizedRight = right.replace(/^0+(?=\d)/, '');
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length > normalizedRight.length ? 1 : -1;
  }
  return sign(normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0);
}

function comparePrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    const result = compareIdentifier(left[index], right[index]);
    if (result !== 0) return result;
  }
  return 0;
}

/** Returns 1 when left is newer, -1 when older, and 0 when equal. */
export function compareVersions(left: string, right: string): number {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);

  if (parsedLeft.valid !== parsedRight.valid) return parsedLeft.valid ? 1 : -1;
  if (!parsedLeft.valid) {
    return sign(parsedLeft.raw < parsedRight.raw ? -1 : parsedLeft.raw > parsedRight.raw ? 1 : 0);
  }

  for (let index = 0; index < Math.max(parsedLeft.core.length, parsedRight.core.length); index += 1) {
    const result = compareNumericText(parsedLeft.core[index] ?? '0', parsedRight.core[index] ?? '0');
    if (result !== 0) return result;
  }
  return comparePrerelease(parsedLeft.prerelease, parsedRight.prerelease);
}
