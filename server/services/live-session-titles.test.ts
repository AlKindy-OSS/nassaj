/**
 * live-session-titles.test.ts (B-270)
 *
 * The deferred-restart panel used to list its blockers as five identical
 * "claude · 14m" lines — enough to know the restart was refused, not enough to
 * know WHICH conversation to close. The gate script now reports the session id
 * it parsed out of each child's argv, and this helper turns that id into the
 * same `custom_name` title the sidebar shows.
 *
 * What matters here is the enrichment's failure behaviour, since it runs on the
 * path of a SAFE deferral: it must never turn a refused restart into a 500, and
 * it must not hand an admin the title of a conversation living in a project they
 * are not a member of.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { attachSessionTitles } from './live-session-titles.js';

const VISIBLE_PROJECT = '/workspace/visible';
const PRIVATE_PROJECT = '/workspace/private';

const SESSIONS: Record<string, { custom_name: string | null; project_path: string | null }> = {
  'sess-visible': { custom_name: '\u0625\u0639\u0627\u062f\u0629 \u0647\u064a\u0643\u0644\u0629 \u0635\u0641\u062d\u0629 \u0627\u0644\u0645\u0632\u0648\u062f\u064a\u0646', project_path: VISIBLE_PROJECT },
  'sess-private': { custom_name: '\u062e\u0637\u0629 \u0625\u0637\u0644\u0627\u0642 \u0633\u0631\u064a\u0629', project_path: PRIVATE_PROJECT },
  'sess-untitled': { custom_name: '   ', project_path: VISIBLE_PROJECT },
  'sess-nopath': { custom_name: '\u0645\u062d\u0627\u062f\u062b\u0629 \u0628\u0644\u0627 \u0645\u0634\u0631\u0648\u0639', project_path: null },
};

/** Repositories injected in place of the real ones (no module mocking needed). */
function deps(over: { visibilityThrows?: boolean; lookupThrows?: boolean } = {}) {
  return {
    projectsDb: {
      getVisibleProjectPaths: () => {
        if (over.visibilityThrows) throw new Error('db down');
        return [VISIBLE_PROJECT];
      },
    },
    sessionsDb: {
      getSessionById: (id: string) => {
        if (over.lookupThrows) throw new Error('db down');
        return SESSIONS[id] ?? null;
      },
    },
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  pid: 1234,
  provider: 'claude',
  ageS: 840,
  sessionId: 'sess-visible',
  ...over,
});

test('a visible session gets the title the sidebar shows', () => {
  const [out] = attachSessionTitles([row()], 7, deps());
  assert.equal(out.title, 'إعادة هيكلة صفحة المزودين');
  assert.equal(out.titleRedacted, undefined);
  // The technical fields the panel also renders must survive untouched.
  assert.equal(out.pid, 1234);
  assert.equal(out.provider, 'claude');
  assert.equal(out.ageS, 840);
});

test('a session in an invisible project is redacted, not titled', () => {
  const [out] = attachSessionTitles([row({ sessionId: 'sess-private' })], 7, deps());
  assert.equal(out.title, undefined, 'the private title must never be handed over');
  assert.equal(out.titleRedacted, true, 'the panel still says something is blocking');
  assert.equal(out.pid, 1234, 'pid and age stay — the owner can still act on it');
});

test('a run with no project path is titled (nothing to leak)', () => {
  const [out] = attachSessionTitles([row({ sessionId: 'sess-nopath' })], 7, deps());
  assert.equal(out.title, 'محادثة بلا مشروع');
});

test('blank and missing titles fall through to the client fallback', () => {
  const [blank] = attachSessionTitles([row({ sessionId: 'sess-untitled' })], 7, deps());
  assert.equal(blank.title, undefined, 'a whitespace-only name is not a title');

  const [unknown] = attachSessionTitles([row({ sessionId: 'sess-does-not-exist' })], 7, deps());
  assert.equal(unknown.title, undefined);
  assert.equal(unknown.titleRedacted, undefined);
});

test('a row with no session id is returned untouched', () => {
  const input = [row({ sessionId: undefined })];
  const out = attachSessionTitles(input, 7, deps());
  assert.equal(out[0], input[0], 'no id → no lookup, same object');
});

test('a database failure degrades to title-less rows, never an exception', () => {
  const noVisibility = attachSessionTitles([row()], 7, deps({ visibilityThrows: true }));
  assert.equal(noVisibility[0].title, undefined, 'deferral still answers without titles');

  const noLookup = attachSessionTitles([row()], 7, deps({ lookupThrows: true }));
  assert.equal(noLookup[0].title, undefined);
  assert.equal(noLookup[0].pid, 1234, 'the row itself survives the failed lookup');
});

test('an empty or malformed list is passed straight through', () => {
  const empty: unknown[] = [];
  assert.equal(attachSessionTitles(empty, 7, deps()), empty);
  assert.equal(attachSessionTitles(null, 7, deps()), null);
});
