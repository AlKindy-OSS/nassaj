import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QuestionAnswerContent } from './QuestionAnswerContent';

// Regression coverage for the chat-interface crash where an AskUserQuestion
// payload loaded from a session transcript arrives malformed. The component
// renders with `defaultOpen: true`, so it executes as soon as a session loads;
// a single bad payload used to throw "TypeError: e.map is not a function" and
// take down the whole chat view via the error boundary.
//
// nassaj-dev runs alternate providers (agy CLI, Hermes) whose transcripts do
// not always match Claude's AskUserQuestion shape, so the shapes below are the
// realistic corruption vectors we must degrade against — never throw.
//
// Convention follows the repo's `node:test` + `tsx` server tests and uses
// react-dom/server renderToStaticMarkup so no DOM/jsdom is required.
// Run: npx tsx --test src/**/QuestionAnswerContent.test.tsx

function renderMalformed(props: unknown) {
  return renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, props as never),
  );
}

test('questions arriving as a string (corrupt transcript) does not throw', () => {
  assert.doesNotThrow(() =>
    renderMalformed({ questions: 'Pick one?', answers: {} }),
  );
});

test('questions arriving as an object with a length prop does not throw', () => {
  // A plain object with a numeric `length` would pass a naive `.length` check
  // yet has no `.map`; Array.isArray is the only correct guard.
  assert.doesNotThrow(() =>
    renderMalformed({
      questions: { length: 2, 0: { question: 'q?' }, 1: { question: 'q2?' } },
      answers: {},
    }),
  );
});

test('null / undefined questions renders nothing without throwing', () => {
  assert.doesNotThrow(() => renderMalformed({ questions: null, answers: {} }));
  assert.doesNotThrow(() =>
    renderMalformed({ questions: undefined, answers: undefined }),
  );
});

test('a question entry that is null / non-object / lacks a string prompt is skipped', () => {
  assert.doesNotThrow(() =>
    renderMalformed({
      questions: [
        null,
        'oops',
        42,
        { header: 'no-prompt' },
        { question: 42 },
        { question: 'Real?', options: [{ label: 'A' }] },
      ],
      answers: {},
    }),
  );
});

test('options arriving as a string does not throw on .some / .map', () => {
  // Provider sent `options` as a string instead of an array. An answer is
  // present so the collapsed-chip path (.some) and the expanded path (.map)
  // are both reachable.
  const html = renderMalformed({
    questions: [{ question: 'Pick one?', options: 'A, B' }],
    answers: { 'Pick one?': 'A' },
  });
  // Degrades safely: the custom-answer fallback still surfaces the answer.
  assert.ok(typeof html === 'string');
});

test('options array containing malformed entries is filtered, not crashed', () => {
  assert.doesNotThrow(() =>
    renderMalformed({
      questions: [
        { question: 'Pick one?', options: [null, 'oops', 7, {}, { label: 42 }, { label: 'A' }] },
      ],
      answers: { 'Pick one?': 'A, Custom' },
    }),
  );
});

test('a non-string answer does not throw on .split', () => {
  assert.doesNotThrow(() =>
    renderMalformed({
      questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
      answers: { 'Pick one?': { unexpected: true } },
    }),
  );
});

test('a well-formed question + answer still renders its prompt', () => {
  const html = renderToStaticMarkup(
    React.createElement(QuestionAnswerContent, {
      questions: [
        { question: 'Pick one?', header: 'H', options: [{ label: 'A' }, { label: 'B' }] },
      ],
      answers: { 'Pick one?': 'A' },
    }),
  );
  assert.ok(html.includes('Pick one?'));
  assert.ok(html.includes('H'));
});
