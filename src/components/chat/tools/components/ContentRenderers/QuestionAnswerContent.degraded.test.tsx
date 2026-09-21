import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { QuestionAnswerContent } from './QuestionAnswerContent';
import syntheticPayload from './__fixtures__/ask-user-question.synthetic.json';

/**
 * B-100 — a malformed AskUserQuestion payload must DEGRADE, not disappear.
 *
 * History: the component called `questions.map` behind a truthiness check, so a
 * truthy non-array threw "e.map is not a function" and the ErrorBoundary took
 * down the whole chat view. That crash was fixed with `Array.isArray`, but the
 * guard returned `null` — which traded a loud failure for a silent one: the tool
 * block rendered empty and the user's content vanished from the transcript with
 * nothing to indicate anything had been dropped.
 *
 * These tests pin the third state: whatever arrived is shown as received.
 *
 * The healthy baseline is a synthetic, shape-preserving AskUserQuestion payload.
 * Each malformed case changes exactly one structural field, keeping the test
 * useful without redistributing a user's transcript.
 */

const SAMPLE_QUESTIONS = syntheticPayload.input.questions;
const SAMPLE_PROMPT = SAMPLE_QUESTIONS[0].question;
const SAMPLE_HEADER = SAMPLE_QUESTIONS[0].header;
const SAMPLE_OPTION = SAMPLE_QUESTIONS[0].options[0].label;

const render = (props: unknown) =>
  renderToStaticMarkup(React.createElement(QuestionAnswerContent, props as never));

/** Strips tags so assertions read against visible text, not markup. */
const visibleText = (html: string) => html.replace(/<[^>]*>/g, '');

describe('QuestionAnswerContent — malformed payload is shown, not swallowed (B-100)', () => {
  it('renders the raw prompt when `questions` arrives as a bare string', () => {
    // A provider that flattened the payload to just the prompt text. The user
    // still wrote/was asked this; it must reach the screen.
    const html = render({ questions: 'Which database should we use?', answers: {} });

    expect(visibleText(html)).toContain('Which database should we use?');
  });

  it("preserves the representative Arabic prompt and gives it its own direction", () => {
    const html = render({ questions: SAMPLE_PROMPT, answers: {} });

    expect(visibleText(html)).toContain(SAMPLE_PROMPT);
    // Provider prose carries its own base direction rather than inheriting the
    // surrounding container (STYLE_LOCK §5).
    expect(html).toContain('dir="rtl"');
  });

  it('renders the raw object when `questions` is an array-like object', () => {
    // A plain object with a numeric `length` passes a naive `.length` check yet
    // has no `.map`. Array.isArray is the only correct discriminator.
    const html = render({
      questions: { length: 1, 0: SAMPLE_QUESTIONS[0] },
      answers: {},
    });

    expect(visibleText(html)).toContain(SAMPLE_PROMPT);
  });

  it('renders the raw object when the tool input is nested one level too deep', () => {
    // `{ questions: { questions: [...] } }` — a wrapper that forwarded the whole
    // tool_use.input instead of its `questions` field. The content is all there;
    // only the nesting is wrong, so losing it entirely is the worst outcome.
    const html = render({ questions: syntheticPayload.input, answers: {} });
    const text = visibleText(html);

    expect(text).toContain(SAMPLE_PROMPT);
    expect(text).toContain(SAMPLE_OPTION);
  });

  it('surfaces a malformed ENTRY inline while still rendering its valid siblings', () => {
    const html = render({
      questions: [
        SAMPLE_QUESTIONS[0],
        'a bare string entry',
        { header: SAMPLE_HEADER, options: SAMPLE_QUESTIONS[0].options },
      ],
      answers: { [SAMPLE_PROMPT]: SAMPLE_OPTION },
    });
    const text = visibleText(html);

    expect(text).toContain(SAMPLE_PROMPT);
    expect(text).toContain('a bare string entry');
    expect(text).toContain(SAMPLE_OPTION);
  });

  it('renders nothing when there is genuinely nothing to show', () => {
    // The absent cases must NOT produce a fallback panel — an empty question set
    // is normal, and the call site already normalises falsy to []. Showing
    // "unreadable data" here would be noise on a healthy transcript.
    for (const questions of [null, undefined, []]) {
      expect(render({ questions, answers: {} })).toBe('');
    }
    // null/undefined slots inside an otherwise valid array are padding, not content.
    expect(render({ questions: [null, undefined], answers: {} })).not.toContain('shown as received');
  });

  it('labels the degraded panel so it is not mistaken for the question itself', () => {
    expect(visibleText(render({ questions: 'raw', answers: {} }))).toContain('shown as received');
  });
});

describe('QuestionAnswerContent — degrading never throws (B-100)', () => {
  it('survives a circular payload that would break JSON.stringify', () => {
    const circular: Record<string, unknown> = { question: 'Loop?' };
    circular.self = circular;

    expect(() => render({ questions: circular, answers: {} })).not.toThrow();
    expect(visibleText(render({ questions: circular, answers: {} }))).toContain('Circular');
  });

  it('survives a BigInt payload that would make JSON.stringify throw', () => {
    expect(() => render({ questions: { count: BigInt(3) }, answers: {} })).not.toThrow();
  });

  it('survives numbers, booleans and functions as the payload', () => {
    for (const questions of [42, true, () => 'nope']) {
      expect(() => render({ questions, answers: {} })).not.toThrow();
    }
  });

  it('survives malformed `options` and non-string answers on a valid question', () => {
    expect(() =>
      render({
        questions: [{ question: 'Pick one?', options: 'A, B' }],
        answers: { 'Pick one?': 'A' },
      }),
    ).not.toThrow();

    expect(() =>
      render({
        questions: [{ question: 'Pick one?', options: [null, 7, {}, { label: 'A' }] }],
        answers: { 'Pick one?': { unexpected: true } },
      }),
    ).not.toThrow();
  });
});

describe('QuestionAnswerContent — the healthy path is untouched (B-100)', () => {
  it('renders the representative payload with no degraded panel', () => {
    const html = render({
      questions: SAMPLE_QUESTIONS,
      answers: { [SAMPLE_PROMPT]: SAMPLE_OPTION },
    });
    const text = visibleText(html);

    expect(text).toContain(SAMPLE_PROMPT);
    expect(text).toContain(SAMPLE_HEADER);
    expect(text).toContain(SAMPLE_OPTION);
    expect(text).not.toContain('shown as received');
  });
});
