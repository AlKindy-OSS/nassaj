import type { Database } from 'better-sqlite3';
import type { Request, Response } from 'express';

import { c4ReviewInvocation } from '../../account-wallet/index.js';
import { AgentReviewError, AgentReviewRepository, assertReviewInteger, assertReviewKeys, assertReviewSession,
  assertReviewToken, type ReviewTransition, type ReviewSource, type ReviewStatus } from '../../database/index.js';

import { AgentReviewHttpAuthority, type ReviewAccessSeams } from './agent-review-http-authority.js';

export type AgentReviewRowDto = { source: ReviewSource; agentId: string; resultGeneration: string; status: ReviewStatus;
  revision: number; unavailable: boolean; readOnly: boolean };
export type AgentReviewIncidentDto = { incidentId: number; source: ReviewSource; scope: 'container' | 'identity'; agentId: string;
  sourceContainerId: string; incidentGeneration: number; reason: string; evidenceSha256: string; revision: number };
export type AgentReviewPageDto = { sessionId: string; canReview: boolean; availability: 'available' | 'unavailable';
  rows: AgentReviewRowDto[]; summary: Record<string, number>; incidents: AgentReviewIncidentDto[];
  pagination: { limit: number; offset: number; incidentLimit: number; incidentAfterId: number; nextIncidentAfterId: number | null } };
type Reply<T> = { data: T; assertCurrent: () => true };

function pageInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new AgentReviewError('invalid_input');
  const number = Number(value); assertReviewInteger(number, minimum);
  if (number > maximum) throw new AgentReviewError('invalid_input');
  return number;
}

/** Durable HTTP application service. It never imports or invokes artifact readers or ingestors. */
export class AgentReviewHttpService {
  readonly #authority: AgentReviewHttpAuthority;
  constructor(private readonly db: Database, seams?: ReviewAccessSeams) { this.#authority = new AgentReviewHttpAuthority(db, seams); }

  /** Return bounded durable rows and quarantine references, with a late-disclosure assertion. */
  async get(req: Request): Promise<Reply<AgentReviewPageDto>> {
    const sessionId = req.params.sessionId; assertReviewSession(sessionId);
    const keys = Object.keys(req.query);
    if (keys.some(key => !['limit', 'offset', 'incidentLimit', 'incidentAfterId'].includes(key))) throw new AgentReviewError('invalid_input');
    const page = { limit: pageInteger(req.query.limit, 50, 1, 100), offset: pageInteger(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      incidentLimit: pageInteger(req.query.incidentLimit, 50, 1, 100), incidentAfterId: pageInteger(req.query.incidentAfterId, 0, 0, Number.MAX_SAFE_INTEGER) };
    const authority = this.#authority.capture(req, sessionId, 'read');
    await Promise.resolve(); authority.assertCurrent();
    const repo = new AgentReviewRepository(this.db, { actorUserId: authority.actorUserId, assertCurrent: () => authority.assertCurrent() });
    let canReview = false;
    try { authority.assertCurrent('write'); canReview = repo.isController(sessionId); }
    catch (error) {
      const code = error instanceof AgentReviewError ? error.code : (error as { code?: string })?.code;
      if (!['forbidden', 'session_not_found', 'SESSION_NOT_FOUND'].includes(code ?? '')) throw error;
    }
    const summary = repo.readSummary(sessionId);
    const rows = (repo.listCurrent(sessionId, { limit: page.limit, offset: page.offset }) as Array<Omit<AgentReviewRowDto, 'unavailable' | 'readOnly'> & { unavailable: number }>)
      .map(row => ({ ...row, unavailable: Boolean(row.unavailable), readOnly: row.source === 'external' }));
    const incidents = repo.listActiveIncidents(sessionId, { limit: page.incidentLimit, afterId: page.incidentAfterId }) as AgentReviewIncidentDto[];
    const last = incidents.at(-1) as { incidentId: number } | undefined;
    return { data: { sessionId, canReview, availability: summary.activeIncidents ? 'unavailable' : 'available', rows, summary, incidents,
      pagination: { ...page, nextIncidentAfterId: incidents.length === page.incidentLimit ? last?.incidentId ?? null : null } },
    assertCurrent: () => authority.assertCurrent() };
  }

  /** Reauthorize inside BEGIN IMMEDIATE before receipt replay/CAS; return a late-disclosure assertion. */
  async patch(req: Request, res?: Response): Promise<Reply<ReturnType<AgentReviewRepository['transition']>>> {
    const sessionId = req.params.sessionId; assertReviewSession(sessionId);
    const agentId = req.params.agentId; assertReviewToken(agentId, 'agent');
    if (Object.keys(req.query).length) throw new AgentReviewError('invalid_input');
    assertReviewKeys(req.body, ['source', 'resultGeneration', 'action', 'expectedRevision', 'idempotencyKey']);
    const input = { ...req.body, sessionId, agentId } as ReviewTransition;
    const authority = this.#authority.capture(req, sessionId, 'write');
    await Promise.resolve();
    authority.assertCurrent(); // Pre-BEGIN denial retains positive zero-effect truth.
    const repo = new AgentReviewRepository(this.db, { actorUserId: authority.actorUserId,
      assertCurrent: (db, session) => {
        if (db !== this.db || session !== sessionId || !db.inTransaction) throw new AgentReviewError('forbidden');
        return authority.assertCurrent();
      } });
    const data = repo.transition(input, res ? c4ReviewInvocation(req, res) : undefined);
    return { data, assertCurrent: () => authority.assertCurrent() };
  }
}
