/**
 * T-1950 — normalizeProjectLink: validation and normalization of the
 * user-supplied project link.
 *
 * The link_url migration on a legacy DB is covered separately in
 * server/modules/database/project-link.migration.test.ts (it needs
 * database-module internals that this module may not deep-import).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeProjectLink,
  PROJECT_LINK_MAX_LENGTH,
} from '@/modules/projects/services/project-link.service.js';
import { AppError } from '@/shared/utils.js';

function assertRejected(input: unknown): void {
  assert.throws(
    () => normalizeProjectLink(input),
    (error: unknown) =>
      error instanceof AppError && error.statusCode === 400 && error.code === 'INVALID_PROJECT_LINK',
    `expected 400 for ${JSON.stringify(input)}`,
  );
}

test('null, empty and whitespace-only input clear the link', () => {
  assert.equal(normalizeProjectLink(null), null);
  assert.equal(normalizeProjectLink(''), null);
  assert.equal(normalizeProjectLink('   \t '), null);
});

test('non-string, non-null types are rejected before any trimming', () => {
  for (const input of [undefined, 42, true, {}, ['https://a.example'], { toString: () => 'x' }]) {
    assertRejected(input);
  }
});

test('input without a scheme gets https:// and is canonicalized', () => {
  assert.equal(normalizeProjectLink('example.com'), 'https://example.com/');
  assert.equal(normalizeProjectLink('  Example.COM/path?q=1#h  '), 'https://example.com/path?q=1#h');
});

test('bare host:port is treated as a host and given an https:// prefix', () => {
  assert.equal(normalizeProjectLink('example.com:8080'), 'https://example.com:8080/');
  assert.equal(normalizeProjectLink('localhost:3000'), 'https://localhost:3000/');
  assert.equal(normalizeProjectLink('example.com:8080/x'), 'https://example.com:8080/x');
  assert.equal(normalizeProjectLink('https://example.com:8080/x'), 'https://example.com:8080/x');
});

test('scheme-like host:digit inputs cannot smuggle a dangerous scheme', () => {
  // "javascript:1" is host "javascript" on port 1 over https — harmless.
  assert.equal(normalizeProjectLink('javascript:1'), 'https://javascript:1/');
  // Non-numeric port after the prefix is an invalid URL, not a scheme.
  assertRejected('javascript:1+alert(1)');
  assertRejected('data:1,x');
  // A non-digit after ':' is still a scheme, and a disallowed one.
  assertRejected('javascript:%61lert(1)');
});

test('http and https links are kept as-is (canonical href)', () => {
  assert.equal(normalizeProjectLink('http://example.com'), 'http://example.com/');
  assert.equal(normalizeProjectLink('HTTPS://example.com/a'), 'https://example.com/a');
});

test('dangerous or non-web schemes are rejected, not prefixed', () => {
  for (const input of [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com',
    'vbscript:msgbox(1)',
    'mailto:a@example.com',
  ]) {
    assertRejected(input);
  }
});

test('embedded credentials are rejected', () => {
  assertRejected('https://user:pass@example.com');
  assertRejected('https://user@example.com');
  assertRejected('user:pass@example.com');
});

test('missing host is rejected', () => {
  assertRejected('https://');
  assertRejected('https://:443/');
});

test('length cap: 2048 accepted, 2049 rejected before prefixing', () => {
  const base = 'https://example.com/';
  const exact = base + 'a'.repeat(PROJECT_LINK_MAX_LENGTH - base.length);
  assert.equal(exact.length, 2048);
  assert.equal(normalizeProjectLink(exact), exact);
  assertRejected(exact + 'a');
  assertRejected('a'.repeat(2049));
});

test('length cap re-applied after prefixing/normalization', () => {
  // 2048 chars without scheme → 2056 after the https:// prefix.
  const bare = 'example.com/' + 'a'.repeat(PROJECT_LINK_MAX_LENGTH - 'example.com/'.length);
  assert.equal(bare.length, 2048);
  assertRejected(bare);
});

test('control characters are rejected', () => {
  for (const input of ['https://exa\u0000mple.com', 'https://example.com/\u0007', 'https://example.com/\u007f', 'https://example.com/\u0085x']) {
    assertRejected(input);
  }
});

test('internal whitespace is rejected (leading/trailing is trimmed)', () => {
  assertRejected('https://example.com/a b');
  assertRejected('example .com');
  assertRejected('https://example.com/ x');
  assert.equal(normalizeProjectLink('  https://example.com  '), 'https://example.com/');
});

test('IDN hosts are accepted and stored in punycode', () => {
  assert.equal(normalizeProjectLink('https://مثال.السعودية/'), 'https://xn--mgbh0fb.xn--mgberp4a5d4ar/');
  assert.equal(normalizeProjectLink('bücher.example'), 'https://xn--bcher-kva.example/');
});
