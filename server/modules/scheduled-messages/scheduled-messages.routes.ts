import express from 'express';

import type { ScheduledMessageStatus } from '@/modules/database/index.js';
import type { ScheduledMessagesService } from '@/modules/scheduled-messages/scheduled-messages.service.js';
import { ScheduledMessageError } from '@/modules/scheduled-messages/scheduled-messages.service.js';

const STATUSES = new Set<ScheduledMessageStatus>(['pending', 'running', 'sent', 'failed', 'cancelled']);
const CREATE_FIELDS = new Set(['sessionId', 'content', 'scheduledFor', 'options']);
const UPDATE_FIELDS = new Set(['content', 'scheduledFor', 'options']);
const DEFAULT_PAGE_LIMIT = 200;
const MAX_PAGE_LIMIT = 200;
const MAX_PAGE_OFFSET = 10_000;

function body(req: express.Request, allowed: ReadonlySet<string>): Record<string, unknown> {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new ScheduledMessageError('invalid_body', 400);
  }
  if (Object.keys(req.body).some((key) => !allowed.has(key))) {
    throw new ScheduledMessageError('unsupported_field', 400);
  }
  return req.body as Record<string, unknown>;
}

function messageId(value: string): string {
  if (!value || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ScheduledMessageError('scheduled_message_not_found', 404);
  }
  return value;
}

function userId(req: express.Request): number {
  const value = Number((req as express.Request & { user?: { id?: unknown } }).user?.id);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ScheduledMessageError('unauthorized', 401);
  return value;
}

function sendError(res: express.Response, error: unknown): express.Response {
  if (error instanceof ScheduledMessageError) {
    return res.status(error.statusCode).json({ error: error.code, code: error.code });
  }
  console.error('[scheduled-messages] request failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  return res.status(500).json({ error: 'scheduled_message_operation_failed', code: 'scheduled_message_operation_failed' });
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, code: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    throw new ScheduledMessageError(code, 400);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ScheduledMessageError(code, 400);
  }
  return parsed;
}

export function createScheduledMessagesRouter(service: ScheduledMessagesService): express.Router {
  const router = express.Router();
  router.get('/summary', (req, res) => {
    try { return res.json(service.summary(userId(req))); }
    catch (error) { return sendError(res, error); }
  });
  router.get('/', (req, res) => {
    try {
      const rawStatus = req.query.status;
      if (rawStatus !== undefined && (typeof rawStatus !== 'string' || !STATUSES.has(rawStatus as ScheduledMessageStatus))) {
        throw new ScheduledMessageError('invalid_status', 400);
      }
      const sessionId = req.query.sessionId;
      if (sessionId !== undefined && typeof sessionId !== 'string') {
        throw new ScheduledMessageError('invalid_session_id', 400);
      }
      return res.json(service.list(userId(req), {
        ...(sessionId ? { sessionId } : {}),
        ...(rawStatus ? { status: rawStatus as ScheduledMessageStatus } : {}),
        limit: boundedInteger(req.query.limit, DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT, 'invalid_limit'),
        offset: boundedInteger(req.query.offset, 0, 0, MAX_PAGE_OFFSET, 'invalid_offset'),
      }));
    } catch (error) { return sendError(res, error); }
  });
  router.post('/', (req, res) => {
    try { return res.status(201).json({ message: service.create(userId(req), body(req, CREATE_FIELDS)) }); }
    catch (error) { return sendError(res, error); }
  });
  router.patch('/:id', (req, res) => {
    try { return res.json({ message: service.update(userId(req), messageId(req.params.id), body(req, UPDATE_FIELDS)) }); }
    catch (error) { return sendError(res, error); }
  });
  router.delete('/:id', (req, res) => {
    try { service.cancel(userId(req), messageId(req.params.id)); return res.status(204).end(); }
    catch (error) { return sendError(res, error); }
  });
  return router;
}
