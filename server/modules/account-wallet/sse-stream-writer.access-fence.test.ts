import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SSEStreamWriter } from './sse-stream-writer.js';

const responseFixture = (headersSent = false, writableEnded = false) => {
  const writes: string[] = [];
  let ended = 0;
  return {
    response: {
      headersSent,
      writableEnded,
      write: (chunk: string) => { writes.push(chunk); },
      end: () => { ended += 1; },
      once: () => undefined,
    },
    writes,
    ended: () => ended,
  };
};

test('pre-header stale access closes without payload or control disclosure', () => {
  const fixture = responseFixture();
  const writer = new SSEStreamWriter(
    fixture.response, 7, null, () => 'project_access_changed',
  );

  assert.equal(writer.assertCurrentAccess(), false);
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.ended(), 1);
});

test('post-header stale access emits only one sanitized control and drops queued content', () => {
  const fixture = responseFixture(true);
  let stale = false;
  const writer = new SSEStreamWriter(
    fixture.response, 7, null, () => stale ? 'identity_changed' : null,
  );
  writer.send({ type: 'content', text: 'before' });
  stale = true;
  writer.send({ type: 'content', text: 'secret-after-revoke' });
  writer.send({ type: 'content', text: 'second-late' });

  assert.equal(fixture.writes.length, 2);
  assert.match(fixture.writes[0]!, /before/u);
  assert.doesNotMatch(fixture.writes[1]!, /secret-after-revoke|second-late/u);
  assert.match(fixture.writes[1]!, /identity_changed/u);
  assert.equal(fixture.ended(), 1);
});

test('an unwritable stale stream emits nothing and a fresh replacement remains independent', () => {
  const oldFixture = responseFixture(true, true);
  const oldWriter = new SSEStreamWriter(
    oldFixture.response, 7, null, () => 'project_access_changed',
  );
  oldWriter.send({ type: 'content', text: 'late-old' });
  assert.deepEqual(oldFixture.writes, []);
  assert.equal(oldFixture.ended(), 0);

  const replacement = responseFixture(true);
  const replacementWriter = new SSEStreamWriter(replacement.response, 7, null, () => null);
  replacementWriter.send({ type: 'content', text: 'fresh' });
  assert.match(replacement.writes[0]!, /fresh/u);
  assert.equal(replacement.ended(), 0);
});

test('completion rechecks access and never appends done after revocation', () => {
  const fixture = responseFixture(true);
  let stale = false;
  const writer = new SSEStreamWriter(
    fixture.response, 7, null, () => stale ? 'project_access_changed' : null,
  );
  stale = true;
  writer.end();

  assert.equal(fixture.writes.length, 1);
  assert.doesNotMatch(fixture.writes[0]!, /done/u);
  assert.match(fixture.writes[0]!, /project_access_changed/u);
  assert.equal(fixture.ended(), 1);
});
