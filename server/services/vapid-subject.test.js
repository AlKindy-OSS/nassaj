/** T-2044 S2: configurable, validated VAPID subject. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_VAPID_SUBJECT,
  isUnreachableSubjectHost,
  isValidVapidSubject,
  resolveVapidSubject,
} from './vapid-subject.js';

test('isValidVapidSubject: accepts mailto: addresses and https: URLs', () => {
  for (const ok of ['mailto:ops@example.com', 'https://example.com', 'https://example.com/contact']) {
    assert.equal(isValidVapidSubject(ok), true, ok);
  }
});

test('isValidVapidSubject: rejects other schemes and malformed values', () => {
  for (const bad of [undefined, '', 'ops@example.com', 'http://example.com', 'mailto:', 'mailto:@x.com',
    'mailto:ops@', 'mailto:o ps@x.com', 'https://', 'https:not a url', 'ftp://example.com', 42]) {
    assert.equal(isValidVapidSubject(bad), false, String(bad));
  }
});

test('isUnreachableSubjectHost: flags .local and localhost hosts only', () => {
  assert.equal(isUnreachableSubjectHost(DEFAULT_VAPID_SUBJECT), true);
  assert.equal(isUnreachableSubjectHost('https://localhost:3000'), true);
  assert.equal(isUnreachableSubjectHost('mailto:a@LOCALHOST'), true);
  assert.equal(isUnreachableSubjectHost('https://app.localhost'), true);
  assert.equal(isUnreachableSubjectHost('mailto:a@example.com'), false);
  assert.equal(isUnreachableSubjectHost('https://local.example.com'), false);
});

test('resolveVapidSubject: unset keeps the historical default and warns once about .local', () => {
  const { subject, warnings } = resolveVapidSubject({});
  assert.equal(subject, 'mailto:noreply@claudecodeui.local');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\.local\/localhost/);
});

test('resolveVapidSubject: a valid configured subject wins with no warnings', () => {
  assert.deepEqual(resolveVapidSubject({ VAPID_SUBJECT: '  mailto:ops@example.com ' }),
    { subject: 'mailto:ops@example.com', warnings: [] });
  assert.deepEqual(resolveVapidSubject({ VAPID_SUBJECT: 'https://example.com' }),
    { subject: 'https://example.com', warnings: [] });
});

test('resolveVapidSubject: invalid value falls back to the default with a value-free warning', () => {
  const { subject, warnings } = resolveVapidSubject({ VAPID_SUBJECT: 'secret-ish-garbage' });
  assert.equal(subject, DEFAULT_VAPID_SUBJECT);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /not a valid/);
  assert.ok(warnings.every((w) => !w.includes('secret-ish-garbage')));
});

test('resolveVapidSubject: valid but localhost subject is kept and warned about', () => {
  const { subject, warnings } = resolveVapidSubject({ VAPID_SUBJECT: 'mailto:me@localhost' });
  assert.equal(subject, 'mailto:me@localhost');
  assert.equal(warnings.length, 1);
});
