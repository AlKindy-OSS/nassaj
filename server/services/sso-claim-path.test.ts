import assert from 'node:assert/strict';
import test from 'node:test';

import {
  claimNames,
  claimPathRefusal,
  normalizeClaimValue,
  parseClaimPath,
  resolveClaimPath,
  USER_EDITABLE_CLAIMS,
} from './sso-claim-path.js';

const segmentsOf = (raw: string) => {
  const parsed = parseClaimPath(raw);
  return parsed.ok ? parsed.segments : null;
};

test('grammar: idents, bracketed JSON strings, both bracket forms', () => {
  assert.deepEqual(segmentsOf('roles'), ['roles']);
  assert.deepEqual(segmentsOf('realm_access.roles'), ['realm_access', 'roles']);
  assert.deepEqual(segmentsOf('resource_access["nassaj"].roles'), ['resource_access', 'nassaj', 'roles']);
  assert.deepEqual(segmentsOf('resource_access.["nassaj"].roles'), ['resource_access', 'nassaj', 'roles']);
  assert.deepEqual(segmentsOf('["urn:example:iam:org:project:42:roles"]'), ['urn:example:iam:org:project:42:roles']);
  assert.deepEqual(segmentsOf('["a.b"]["c\\"d"]'), ['a.b', 'c"d']);
  assert.deepEqual(segmentsOf('["\\u0645\\u0646\\u0638\\u0645\\u0629"]'), ['منظمة']);
  assert.deepEqual(segmentsOf('$x.a-b_9'), ['$x', 'a-b_9']);
});

test('grammar rejects malformed paths', () => {
  for (const raw of [
    '', '.a', 'a.', 'a..b', 'a b', 'a[b]', "a['b']", 'a[""]', 'a["x"', 'a["x"]b', 'a["x\\"]', '[', '["unterminated',
    'a.[', 'x'.repeat(65), 'a/b', 'a["\\q"]', 'ünicode', 42, null, undefined,
  ]) {
    assert.equal(parseClaimPath(raw).ok, false, JSON.stringify(raw));
  }
});

test('caps: 8 segments and 256 characters are the limits', () => {
  assert.equal(parseClaimPath(Array(8).fill('a').join('.')).ok, true);
  assert.equal(parseClaimPath(Array(9).fill('a').join('.')).ok, false);
  const long = `["${'x'.repeat(252)}"]`;
  assert.equal(long.length, 256);
  assert.equal(parseClaimPath(long).ok, true);
  assert.equal(parseClaimPath(`["${'x'.repeat(253)}"]`).ok, false);
  assert.equal(parseClaimPath('x'.repeat(64)).ok, true);
});

test('__proto__, constructor and prototype are rejected at every position, bracketed or not', () => {
  for (const word of ['__proto__', 'constructor', 'prototype']) {
    for (const raw of [word, `a.${word}`, `a.${word}.b`, `["${word}"]`, `a["${word}"].b`, `["\\u005f_proto__"]`]) {
      assert.equal(parseClaimPath(raw).ok, false, raw);
    }
    assert.deepEqual(resolveClaimPath({ a: {} }, ['a', word]), { present: false });
  }
});

test('the resolver walks own properties of plain objects only', () => {
  const inherited = Object.create({ roles: ['admin'] });
  assert.deepEqual(resolveClaimPath(inherited, ['roles']), { present: false });
  assert.deepEqual(resolveClaimPath({ a: ['x'] }, ['a', '0']), { present: false }, 'arrays are not traversed');
  assert.deepEqual(resolveClaimPath({ a: 'str' }, ['a', 'length']), { present: false });
  assert.deepEqual(resolveClaimPath(null, ['a']), { present: false });
  assert.deepEqual(resolveClaimPath({ a: { b: null } }, ['a', 'b']), { present: true, value: null });
  const nullProto = Object.assign(Object.create(null), { roles: 'admin' });
  assert.deepEqual(resolveClaimPath(nullProto, ['roles']), { present: true, value: 'admin' });
});

test('normalization: string, array of strings, object keys; anything else absent', () => {
  assert.deepEqual(normalizeClaimValue('admin'), { status: 'ok', names: ['admin'] });
  assert.deepEqual(normalizeClaimValue(['a', 7, null, 'b', { c: 1 }]), { status: 'ok', names: ['a', 'b'] });
  assert.deepEqual(normalizeClaimValue({ admin: { s: 'x' }, user: {} }), { status: 'ok', names: ['admin', 'user'] });
  for (const value of [7, true, null, undefined]) assert.deepEqual(normalizeClaimValue(value), { status: 'absent' });
});

test('caps: 64 vs 65 names and 128 vs 129 characters; overflow refuses, never truncates', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) => `r${i}`);
  assert.equal(normalizeClaimValue(names(64)).status, 'ok');
  assert.deepEqual(normalizeClaimValue(names(65)), { status: 'too_large' });
  assert.deepEqual(normalizeClaimValue([...names(64), 7]), { status: 'too_large' }, 'raw array length counts');
  assert.deepEqual(normalizeClaimValue(Object.fromEntries(names(65).map((n) => [n, 1]))), { status: 'too_large' });
  assert.equal(normalizeClaimValue('x'.repeat(128)).status, 'ok');
  assert.deepEqual(normalizeClaimValue('x'.repeat(129)), { status: 'too_large' });
  assert.deepEqual(normalizeClaimValue(['ok', 'x'.repeat(129)]), { status: 'too_large' });
  assert.deepEqual(claimNames({ g: names(65) }, ['g']), { status: 'too_large' });
  assert.deepEqual(claimNames({}, ['g']), { status: 'absent' });
});

test('I9: user-editable claims are refused as the top segment of role and tenant paths', () => {
  for (const claim of USER_EDITABLE_CLAIMS) {
    assert.equal(claimPathRefusal(claim, 'role'), 'claim_path_user_editable', claim);
    assert.equal(claimPathRefusal(`${claim}.x`, 'tenant'), 'claim_path_user_editable', claim);
    assert.equal(claimPathRefusal(`["${claim}"]`, 'role'), 'claim_path_user_editable', claim);
  }
  assert.equal(claimPathRefusal('org.name', 'tenant'), null, 'only the top-level segment is checked');
});

test('email: allowed only as a whole tenant path, never as a role path', () => {
  assert.equal(claimPathRefusal('email', 'tenant'), null);
  assert.equal(claimPathRefusal('["email"]', 'tenant'), null);
  assert.equal(claimPathRefusal('email', 'role'), 'claim_path_user_editable');
  assert.equal(claimPathRefusal('email.domain', 'tenant'), 'claim_path_user_editable');
  assert.equal(claimPathRefusal('', 'role'), 'role_claim_path_invalid');
  assert.equal(claimPathRefusal('a..b', 'tenant'), 'tenant_claim_path_invalid');
  assert.equal(claimPathRefusal('groups', 'role'), null);
});

// ---------------------------------------------------------------------------
// Property-style fuzzing (ADR-194 test plan item 1).
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const ALPHABET = ['a', 'Z', '9', '_', '$', '-', '.', '[', ']', '"', '\\', ':', ' ', 'é', 'م', '\u0000', 'u'];
const IDENT_CHARS = 'abcXYZ019_$-';
const SPECIAL_SEGMENTS = ['__proto__', 'constructor', 'prototype', 'a.b', 'x:y', 'منظمة', 'q"q', 'back\\slash', 'é'];

function randomIdent(next: () => number): string {
  const length = 1 + Math.floor(next() * 6);
  return Array.from({ length }, () => IDENT_CHARS[Math.floor(next() * IDENT_CHARS.length)]).join('');
}

function randomSegment(next: () => number): string {
  return next() < 0.3 ? SPECIAL_SEGMENTS[Math.floor(next() * SPECIAL_SEGMENTS.length)] : randomIdent(next);
}

/** Renders segments; idents bare or bracketed at random, everything else bracketed. */
function render(segments: string[], next: () => number): string {
  return segments.map((segment, index) => {
    const bare = /^[A-Za-z0-9_$-]{1,64}$/u.test(segment) && next() < 0.6;
    if (bare) return index === 0 ? segment : `.${segment}`;
    const bracket = `[${JSON.stringify(segment)}]`;
    return index > 0 && next() < 0.5 ? `.${bracket}` : bracket;
  }).join('');
}

/** Independent oracle: own-property walk over plain objects. */
function oracle(claims: unknown, segments: string[]): unknown {
  let current = claims;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function buildClaims(segments: string[], leaf: unknown): Record<string, unknown> {
  let value: unknown = leaf;
  for (const segment of [...segments].reverse()) {
    const holder: Record<string, unknown> = {};
    Object.defineProperty(holder, segment, { value, enumerable: true, configurable: true, writable: true });
    value = holder;
  }
  return value as Record<string, unknown>;
}

test('fuzz: random byte strings never throw and only valid paths parse', () => {
  const next = rng(0xc1a1);
  for (let i = 0; i < 20_000; i += 1) {
    const length = Math.floor(next() * 40);
    const raw = Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join('');
    const parsed = parseClaimPath(raw);
    if (parsed.ok) {
      assert.ok(parsed.segments.length >= 1 && parsed.segments.length <= 8, raw);
      assert.ok(parsed.segments.every((s) => !['__proto__', 'constructor', 'prototype'].includes(s)), raw);
    }
  }
});

test('fuzz: generated paths round-trip, honor depth/length caps and match the oracle', () => {
  const next = rng(0x0dd5);
  for (let i = 0; i < 5_000; i += 1) {
    const depth = 1 + Math.floor(next() * 10);
    const segments = Array.from({ length: depth }, () => randomSegment(next));
    const raw = render(segments, next);
    const parsed = parseClaimPath(raw);
    const forbidden = segments.some((s) => ['__proto__', 'constructor', 'prototype'].includes(s));
    const shouldParse = !forbidden && depth <= 8 && raw.length <= 256;
    assert.equal(parsed.ok, shouldParse, raw);
    if (!parsed.ok) continue;
    assert.deepEqual(parsed.segments, segments, raw);
    const leaf = next() < 0.5 ? ['admin', 7, 'user'] : { admin: { s1: 'x' } };
    const claims = buildClaims(segments, leaf);
    assert.deepEqual(resolveClaimPath(claims, parsed.segments), { present: true, value: oracle(claims, segments) });
    const missing = buildClaims(segments.slice(0, -1), {});
    assert.equal(resolveClaimPath(missing, parsed.segments).present, false);
  }
});

test('fuzz: inherited and prototype-polluted values are never read', () => {
  const next = rng(0xbeef);
  for (let i = 0; i < 2_000; i += 1) {
    const segments = Array.from({ length: 1 + Math.floor(next() * 4) }, () => randomIdent(next));
    const proto = buildClaims(segments, ['admin']);
    const claims = Object.create(proto) as Record<string, unknown>;
    assert.equal(resolveClaimPath(claims, segments).present, false, segments.join('.'));
    const polluted = JSON.parse(`{"__proto__":{"${segments[0]}":["admin"]}}`) as unknown;
    if (segments.length === 1) assert.equal(resolveClaimPath(polluted, segments).present, false);
  }
});

test('fuzz: normalization never throws; count/length overflow is always too_large', () => {
  const next = rng(0x7a11);
  for (let i = 0; i < 5_000; i += 1) {
    const count = Math.floor(next() * 70);
    const width = 1 + Math.floor(next() * 135);
    const asObject = next() < 0.5;
    const names = Array.from({ length: count }, (_, k) => `${k}`.padEnd(width, 'n'));
    const value = asObject ? Object.fromEntries(names.map((n) => [n, {}])) : names;
    const uniqueCount = asObject ? Object.keys(value).length : names.length;
    const result = normalizeClaimValue(value);
    const expectTooLarge = uniqueCount > 64 || (uniqueCount > 0 && width > 128);
    assert.equal(result.status, expectTooLarge ? 'too_large' : 'ok', `${count}x${width}`);
  }
});
