import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Question } from '../../../types/types';
import { resolveTextDirection } from '../../../../../utils/textDirection';

/** اتجاه نصّ حرّ قادم من المزوّد — سؤال أو خيار — أو `undefined` فيرث. */
const dirOf = (text: string | null | undefined) => resolveTextDirection(text) ?? undefined;

interface QuestionAnswerContentProps {
  questions: Question[];
  answers: Record<string, string>;
  className?: string;
}

/**
 * Renders an untrusted value as text a human can actually read.
 *
 * Strings come back verbatim (a provider that sent the prompt itself instead of
 * a question array is still carrying the user's content); everything else is
 * pretty-printed JSON. `JSON.stringify` throws on circular graphs and on
 * BigInt, and returns `undefined` for `undefined`/functions/symbols — all three
 * are handled so this can never be the thing that breaks the render.
 */
function rawPayloadText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'bigint') return `${val}n`;
        if (typeof val === 'function') return '[Function]';
        if (val && typeof val === 'object') {
          if (seen.has(val as object)) return '[Circular]';
          seen.add(val as object);
        }
        return val;
      },
      2,
    );
    return json ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unreadable]';
    }
  }
}

/**
 * B-100 — the degraded view for a payload we could not interpret.
 *
 * Returning `null` here (the previous behaviour) was a quieter version of the
 * same bug the Array.isArray guard fixed: the crash stopped, but the tool block
 * rendered empty, so a malformed AskUserQuestion still removed the user's
 * content from the transcript with nothing to say it had. Whatever arrived is
 * shown as received instead — unreadable beats invisible.
 *
 * A string payload keeps its own direction (it may well be an Arabic prompt);
 * structural JSON is pinned LTR because its punctuation is code, not prose.
 */
const MalformedPayload: React.FC<{ value: unknown; label: string }> = ({ value, label }) => {
  const text = rawPayloadText(value);
  const isProse = typeof value === 'string';

  return (
    <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        <svg
          className="h-3.5 w-3.5 flex-shrink-0"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
        {label}
      </div>
      {isProse ? (
        <p
          className="whitespace-pre-wrap break-words text-[13px] leading-snug text-foreground"
          dir={dirOf(text)}
        >
          {text}
        </p>
      ) : (
        <pre
          className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-snug text-foreground"
          dir="ltr"
        >
          {text}
        </pre>
      )}
    </div>
  );
};

const MALFORMED_SET_LABEL = 'Unreadable question data — shown as received';
const MALFORMED_ENTRY_LABEL = 'Unreadable question — shown as received';

// Exception to the stateless ContentRenderer pattern: multi-question navigation requires local state.
export const QuestionAnswerContent: React.FC<QuestionAnswerContentProps> = ({
  questions,
  answers,
  className = '',
}) => {
  const { t } = useTranslation('chat');
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // Tool inputs are runtime data loaded from session transcripts (incl. agy/Hermes
  // and other providers) and may be malformed, e.g. `questions` arriving as a
  // non-array. Guard with Array.isArray so a single bad payload can't crash the
  // whole chat view with "e.map is not a function".
  //
  // The two non-array cases are NOT the same and must not share an exit:
  //   - absent (null/undefined/[]) — there is genuinely nothing to show, and the
  //     call site already normalises falsy to []. Render nothing.
  //   - present but not an array — the provider sent us something; dropping it
  //     silently is what made this bug invisible after the crash was fixed.
  if (questions !== null && questions !== undefined && !Array.isArray(questions)) {
    return (
      <div className={`space-y-2 ${className}`}>
        <MalformedPayload value={questions} label={MALFORMED_SET_LABEL} />
      </div>
    );
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    return null;
  }

  const hasAnyAnswer = Object.keys(answers || {}).length > 0;
  const total = questions.length;

  return (
    <div className={`space-y-2 ${className}`}>
      {questions.map((rawQuestion, idx) => {
        // Entries come from session transcripts and may be malformed. A null or
        // undefined slot is padding and carries nothing, so it is dropped; any
        // other shape (a bare string prompt, a number, an object with no string
        // `question`) is content we failed to parse and is surfaced as-is rather
        // than deleted from the user's transcript.
        if (rawQuestion === null || rawQuestion === undefined) {
          return null;
        }
        if (typeof rawQuestion !== 'object' || typeof rawQuestion.question !== 'string') {
          return (
            <MalformedPayload key={idx} value={rawQuestion} label={MALFORMED_ENTRY_LABEL} />
          );
        }
        const q = rawQuestion;
        const answer = answers?.[q.question];
        // `answer` may be a non-string (or absent) in malformed payloads; only
        // call string methods when it is actually a string.
        const answerLabels = typeof answer === 'string' ? answer.split(', ') : [];
        const skipped = !answer;
        const isExpanded = expandedIdx === idx;
        // `options` is typed as an array but comes from untrusted runtime data;
        // keep only valid entries so the `.some`/`.map` calls below never throw.
        const options = Array.isArray(q.options)
          ? q.options.filter((opt) => opt && typeof opt === 'object' && typeof opt.label === 'string')
          : [];

        return (
          <div
            key={idx}
            className="overflow-hidden rounded-lg border border-border bg-muted/50"
          >
            <button
              type="button"
              onClick={() => setExpandedIdx(isExpanded ? null : idx)}
              className="flex w-full items-start gap-2.5 px-3 py-2 text-start transition-colors hover:bg-accent"
            >
              <div className={`mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full ${
                answerLabels.length > 0
                  ? 'bg-blue-100 dark:bg-blue-900/40'
                  : 'bg-muted'
              }`}>
                {answerLabels.length > 0 ? (
                  <svg className="h-2.5 w-2.5 text-blue-600 dark:text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <div className="h-1.5 w-1.5 rounded-full bg-gray-300 dark:bg-gray-600" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                {/*
                  Letter-spacing and forced upper-casing were removed from the
                  header badge below: `q.header` is provider text and is routinely
                  Arabic, where letter-spacing breaks the cursive join outright and
                  case folding is a no-op that only distorts the Latin headers.
                  Together they are the eyebrow pattern STYLE_LOCK §1 forbids.
                */}
                <div className="flex flex-wrap items-center gap-2">
                  {q.header && (
                    <span className="inline-flex items-center rounded border border-blue-100/80 bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold text-blue-600 dark:border-blue-800/40 dark:bg-blue-900/30 dark:text-blue-400">
                      {q.header}
                    </span>
                  )}
                  {total > 1 && (
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {idx + 1}/{total}
                    </span>
                  )}
                </div>
                <div
                  className="mt-0.5 text-xs leading-snug text-muted-foreground"
                  dir={dirOf(q.question)}
                >
                  {q.question}
                </div>

                {!isExpanded && answerLabels.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {answerLabels.map((lbl) => {
                      const isCustom = !options.some(o => o.label === lbl);
                      return (
                        <span
                          key={lbl}
                          className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-1.5 py-0.5 text-[11px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                          dir={dirOf(lbl)}
                        >
                          {lbl}
                          {isCustom && (
                            <span className="text-[9px] font-normal text-blue-400 dark:text-blue-500">{t('questionAnswer.custom')}</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}

                {!isExpanded && skipped && hasAnyAnswer && (
                  <span className="mt-1 inline-block text-[10px] italic text-muted-foreground">
                    {t('questionAnswer.skipped')}
                  </span>
                )}
              </div>

              <svg
                className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200 ${
                  isExpanded ? 'rotate-180' : ''
                }`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isExpanded && (
              <div className="border-t border-border px-3 pb-2.5 pt-0.5">
                <div className="ms-[26px] space-y-1">
                  {options.map((opt) => {
                    const wasSelected = answerLabels.includes(opt.label);
                    return (
                      <div
                        key={opt.label}
                        className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-[12px] ${
                          wasSelected
                            ? 'border border-blue-200/60 bg-blue-50/80 dark:border-blue-800/40 dark:bg-blue-900/20'
                            : 'text-muted-foreground'
                        }`}
                      >
                        <div className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${q.multiSelect ? 'rounded-[3px]' : 'rounded-full'} flex items-center justify-center border-[1.5px] ${
                          wasSelected
                            ? 'border-blue-500 bg-blue-500 dark:border-blue-400 dark:bg-blue-500'
                            : 'border-border'
                        }`}>
                          {wasSelected && (
                            <svg className="h-2 w-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <span
                            className={wasSelected ? 'font-medium text-foreground' : ''}
                            dir={dirOf(opt.label)}
                          >
                            {opt.label}
                          </span>
                          {opt.description && (
                            <span
                              dir={dirOf(opt.description)}
                              className={`mt-0.5 block text-[11px] ${
                              wasSelected ? 'text-blue-600/70 dark:text-blue-300/70' : 'text-muted-foreground'
                            }`}>
                              {opt.description}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {answerLabels.filter(lbl => !options.some(o => o.label === lbl)).map(lbl => (
                    <div
                      key={lbl}
                      className="flex items-start gap-2 rounded-lg border border-blue-200/60 bg-blue-50/80 px-2.5 py-1.5 text-[12px] dark:border-blue-800/40 dark:bg-blue-900/20"
                    >
                      <div className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${q.multiSelect ? 'rounded-[3px]' : 'rounded-full'} flex items-center justify-center border-[1.5px] border-blue-500 bg-blue-500 dark:border-blue-400 dark:bg-blue-500`}>
                        <svg className="h-2 w-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="font-medium text-foreground" dir={dirOf(lbl)}>{lbl}</span>
                        <span className="ms-1 text-[10px] text-blue-500 dark:text-blue-400">{t('questionAnswer.custom')}</span>
                      </div>
                    </div>
                  ))}

                  {skipped && hasAnyAnswer && (
                    <div className="px-2.5 py-1 text-[11px] italic text-muted-foreground">
                      {t('questionAnswer.noAnswer')}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {!hasAnyAnswer && total === 1 && (
        <div className="text-[11px] italic text-muted-foreground">
          {t('questionAnswer.skipped')}
        </div>
      )}
    </div>
  );
};
