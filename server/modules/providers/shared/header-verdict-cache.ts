import type { BigIntStats } from 'node:fs';

import type { HeaderVerdict } from './session-transcript-specs.js';

/**
 * Bounded memo of header verdicts (ADR-201 B-1599 L6). Binding a transcript to
 * its session id scans its leading records (up to 16 MiB for a long first
 * record) on every open; a polled idle session repeated that scan each time.
 *
 * The verdict is keyed by everything it depends on — the rules (spec),
 * provider, session id, realpath and root — and by the pinned descriptor's
 * identity and content clock: dev, ino, birth time, size, mtime and ctime. Any
 * write (an append, an in-place rewrite, a truncate) or a utimes moves ctime,
 * which no caller can set back, so a changed file misses and is verified again.
 *
 * Timestamps are coarse (one kernel tick): a file rewritten twice inside one
 * tick keeps its ctime. As with git's "racily clean" index entries, a verdict
 * is therefore cached only once the file's ctime is at least
 * {@link HEADER_VERDICT_SETTLE_MS} old, so any later change carries a newer ctime.
 */

export const HEADER_VERDICT_CACHE_MAX = 1024;
export const HEADER_VERDICT_SETTLE_MS = 2000;

/**
 * What a verdict was computed for: the rules that judged it (`rules`, compared
 * by identity — e.g. the provider's TranscriptSpec), the binding inputs and the
 * fstat of the pinned descriptor.
 */
export type VerdictSubject = {
  rules: object; provider: string; sessionId: string; realpath: string; root: string; stat: BigIntStats;
};

const ruleIds = new WeakMap<object, number>();
let nextRuleId = 0;

function ruleId(rules: object): number {
  let id = ruleIds.get(rules);
  if (id === undefined) {
    id = nextRuleId += 1;
    ruleIds.set(rules, id);
  }
  return id;
}

function verdictKey({ rules, provider, sessionId, realpath, root, stat }: VerdictSubject): string {
  return JSON.stringify([ruleId(rules), provider, sessionId, realpath, root,
    ...[stat.dev, stat.ino, stat.birthtimeNs, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)]);
}

/** Least-recently-used map of verdicts, bounded to `max` entries. */
export class HeaderVerdictCache {
  private readonly entries = new Map<string, HeaderVerdict>();

  /** `clock` returns epoch milliseconds; tests replace it to model a settled file. */
  constructor(private readonly max = HEADER_VERDICT_CACHE_MAX, public clock: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * The cached verdict of `subject`, else `verify()`'s, cached when the file
   * has settled. A throw from `verify` is never cached.
   */
  async verify(subject: VerdictSubject, verify: () => Promise<HeaderVerdict>): Promise<HeaderVerdict> {
    const key = verdictKey(subject);
    if (this.entries.has(key)) {
      const verdict = this.entries.get(key) as HeaderVerdict;
      this.remember(key, verdict);
      return verdict;
    }
    const verdict = await verify();
    if (this.isSettled(subject.stat)) this.remember(key, verdict);
    return verdict;
  }

  private isSettled(stat: BigIntStats): boolean {
    const settledBeforeNs = BigInt(Math.floor(this.clock() - HEADER_VERDICT_SETTLE_MS)) * 1_000_000n;
    return stat.ctimeNs < settledBeforeNs;
  }

  private remember(key: string, verdict: HeaderVerdict): void {
    this.entries.delete(key);
    this.entries.set(key, verdict);
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
  }
}

/** The process-wide cache used by the transcript reader. */
export const headerVerdicts = new HeaderVerdictCache();
