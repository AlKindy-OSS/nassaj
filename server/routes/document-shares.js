import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import express from 'express';

import { DocumentShareError, inspectSharedDocument, readSharedDocument, sharedPageAssetScope } from '../services/document-share-files.js';
import { buildSharedDocumentPreview, documentPreviewCsp, isPreviewableDocument } from '../services/document-share-preview.js';
import { documentShareUrl, trustedDocumentShareOrigin } from '../services/document-share-url.js';

const ID = /^[a-f0-9]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const admin = (user) => user && ['owner', 'admin'].includes(user.role);
const unavailable = () => new DocumentShareError('SHARE_UNAVAILABLE');

/** Share identifiers are safe to log; credentials and local paths never are. */
function publicRow(row) {
  return { id: row.id, relativePath: row.relative_path, audience: row.audience,
    expiresAt: row.expires_at, revokedAt: row.revoked_at, createdAt: row.created_at, sourceMissing: Boolean(row.source_missing_at) };
}

function previewMetadata(row) {
  const previewScope = sharedPageAssetScope(row.relative_path);
  return previewScope ? { previewPath: `/api/document-shares/${row.id}/preview`, previewScope } : {};
}

function expiry(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) {
    throw new DocumentShareError('INVALID_INPUT', 400);
  }
  return new Date(value).toISOString();
}

function headers(_req, res, next) {
  res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
  next();
}

function respondError(res, error) {
  if (res.destroyed || res.headersSent) return;
  const missing = ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error.code);
  const status = error instanceof DocumentShareError ? error.status : missing ? 404 : 503;
  const code = error instanceof DocumentShareError ? error.code : missing ? 'SHARE_UNAVAILABLE' : 'TEMPORARILY_UNAVAILABLE';
  res.status(status).json({ error: { code } });
}

function boundedRequests() {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    for (const [key, item] of clients) if (item.until < now) clients.delete(key);
    const key = req.ip || req.socket.remoteAddress;
    const item = clients.get(key) || { until: now + 60_000, count: 0 };
    if ((!clients.has(key) && clients.size >= 2048) || ++item.count > 120) {
      res.set('Retry-After', '60');
      return res.status(429).json({ error: { code: 'RATE_LIMITED' } });
    }
    clients.set(key, item);
    next();
  };
}

function validBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !fields.includes(key))) throw new DocumentShareError('INVALID_INPUT', 400);
}

/** Recheck manager and project after asynchronous filesystem work, before SQL writes. */
/**
 * Management gate (ADR-172 P1-3): platform owner/admin, or — once membership
 * enforcement is on — anyone `canManageProject` (= canAccessProject) admits.
 * Owner decision 2026-09-23 (qa #7): every project member may manage share
 * links, including public ones; this is intended, not an oversight.
 * Public share-token reads (authorizeRead, audience 'client') are deliberately
 * NOT subject to canAccessProject: the token IS the capability for outsiders.
 */
function assertManager(req, store, verifyUser, originalProject, canManageProject) {
  if (req.assertCurrentIdentity?.() === false) {
    throw new DocumentShareError('AUTH_REQUIRED', 401);
  }
  const user = req.user ?? verifyUser(req.get('Authorization'));
  if (!user) throw new DocumentShareError('AUTH_REQUIRED', 401);
  if (!admin(user) && !canManageProject(req.params.projectId, user.id)) {
    throw new DocumentShareError('ACCESS_DENIED', 403);
  }
  const project = store.project(req.params.projectId);
  if (!project || (originalProject && project.project_path !== originalProject.project_path)) throw unavailable();
  return { user, project };
}

function createManagementHandler({ getStore, verifyUser, audit, canManageProject }) {
  return (handler) => async (req, res) => {
    try {
      const store = getStore();
      const { user, project } = assertManager(req, store, verifyUser, undefined, canManageProject);
      const checkWrite = () => assertManager(req, store, verifyUser, project, canManageProject);
      await handler(req, res, { store, project, user, audit, checkWrite });
    } catch (error) { respondError(res, error); }
  };
}

function registerCreate(router, manage, writer, publicOrigin) {
  router.post('/projects/:projectId/document-shares', writer, manage(async (req, res, context) => {
    const { store, project, user, audit, checkWrite } = context;
    // Reject invalid deployment configuration before creating an irreversible capability.
    const origin = trustedDocumentShareOrigin(publicOrigin);
    validBody(req.body, ['relativePath', 'audience', 'expiresAt']);
    const { relativePath, audience } = req.body;
    if (!['members', 'client'].includes(audience)) throw new DocumentShareError('INVALID_INPUT', 400);
    const expiresAt = expiry(req.body.expiresAt);
    const identity = await inspectSharedDocument(project.project_path, relativePath);
    checkWrite();
    const id = randomBytes(16).toString('hex');
    const token = audience === 'client' ? randomBytes(32).toString('base64url') : null;
    const row = { id, project_id: project.project_id, relative_path: relativePath, audience,
      token_hash: token ? digest(token) : null, root_dev: identity.root_dev, root_ino: identity.root_ino,
      created_by: user.id, created_at: new Date().toISOString(), expires_at: expiresAt, revoked_at: null };
    if (!store.insert(row).changes) throw new DocumentShareError('SHARE_LIMIT_REACHED', 429);
    audit('document_share_created', user.id, id);
    const sharePath = token ? `/share/${id}#token=${token}` : `/share/members/${id}`;
    res.status(201).json({ share: { ...publicRow(row), ...previewMetadata(row) }, sharePath,
      shareUrl: documentShareUrl(origin, sharePath) });
  }));
}

function registerUpdate(router, manage, writer) {
  router.patch('/projects/:projectId/document-shares/:id', writer, manage(async (req, res, context) => {
    const { store, project, user, audit, checkWrite } = context;
    validBody(req.body, ['relativePath', 'expiresAt']);
    const row = store.get(req.params.id);
    if (!row || row.project_id !== project.project_id || row.revoked_at) throw unavailable();
    const relativePath = req.body.relativePath ?? row.relative_path;
    const expiresAt = Object.hasOwn(req.body, 'expiresAt') ? expiry(req.body.expiresAt) : row.expires_at;
    const identity = await inspectSharedDocument(project.project_path, relativePath);
    checkWrite();
    if (store.get(row.id)?.revoked_at) throw unavailable();
    if (!store.update(row.id, relativePath, expiresAt, identity).changes) {
      const current = store.get(row.id);
      if (!current || current.revoked_at) throw unavailable();
      throw new DocumentShareError('SHARE_LIMIT_REACHED', 429);
    }
    audit('document_share_updated', user.id, row.id);
    res.json({ share: publicRow(store.get(row.id)) });
  }));
}

function registerRevoke(router, manage, writer) {
  router.post('/projects/:projectId/document-shares/:id/revoke', writer, manage(async (req, res, { store, project, user, audit, checkWrite }) => {
    const row = store.get(req.params.id);
    if (!row || row.project_id !== project.project_id) throw unavailable();
    checkWrite();
    store.revoke(row.id, new Date().toISOString());
    audit('document_share_revoked', user.id, row.id);
    res.status(204).end();
  }));
}

function checkReadUnchanged(req, store, verifyUser, isMember, row) {
  const current = authorizeRead(req, store, verifyUser, isMember);
  if (current.relative_path !== row.relative_path || current.root_dev !== row.root_dev || current.root_ino !== row.root_ino) {
    throw new DocumentShareError('DOCUMENT_BUSY', 409);
  }
}

function createReader({ getStore, verifyUser, isMember, buildPreview }) {
  let readers = 0;
  return (mode) => async (req, res) => {
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    if (readers >= 4) return respondError(res, new DocumentShareError('RATE_LIMITED', 429));
    readers++;
    let source;
    try {
      const store = getStore();
      const row = authorizeRead(req, store, verifyUser, isMember);
      source = { store, row };
      const project = store.project(row.project_id);
      const info = await inspectSharedDocument(project.project_path, row.relative_path, row);
      checkReadUnchanged(req, store, verifyUser, isMember, row);
      if (mode === 'metadata') return res.json({ document: { name: path.basename(row.relative_path), size: info.size,
        modifiedAt: info.modifiedAt, downloadPath: `/api/document-shares/${row.id}/content`, ...previewMetadata(row) } });
      if (mode === 'preview') {
        if (!isPreviewableDocument(row.relative_path)) throw unavailable();
        const preview = await buildPreview(project.project_path, row.relative_path, row, abort.signal);
        checkReadUnchanged(req, store, verifyUser, isMember, row);
        res.set('Content-Security-Policy', documentPreviewCsp());
        return res.json(preview);
      }
      if (req.get('Range')) throw new DocumentShareError('RANGE_NOT_SUPPORTED', 416);
      const bytes = await readSharedDocument(project.project_path, row.relative_path, row, abort.signal);
      checkReadUnchanged(req, store, verifyUser, isMember, row);
      res.set({ 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'none',
        'Content-Security-Policy': "default-src 'none'; sandbox" });
      res.attachment(path.basename(row.relative_path));
      res.type('application/octet-stream').send(bytes);
    } catch (error) {
      if (error.code === 'ENOENT' && source) {
        try { source.store.markMissing(source.row.id, source.row.relative_path); }
        catch { return respondError(res, new DocumentShareError('TEMPORARILY_UNAVAILABLE', 503)); }
      }
      respondError(res, error);
    }
    finally { readers--; }
  };
}

/** Build share routes with explicit verified-user and project-membership dependencies. */
export function createDocumentSharesRouter({ getStore, verifyUser, isMember, canManageProject = () => false, audit = () => {}, writer = (_req, _res, next) => next(), publicOrigin, buildPreview = buildSharedDocumentPreview }) {
  const router = express.Router();
  router.use(headers, boundedRequests());
  const manage = createManagementHandler({ getStore, verifyUser, audit, canManageProject });
  router.get('/projects/:projectId/document-shares', manage(async (_req, res, { store, project }) => {
    res.json({ shares: store.list(project.project_id).map(publicRow), projectPath: project.project_path });
  }));
  registerCreate(router, manage, writer, publicOrigin);
  registerUpdate(router, manage, writer);
  registerRevoke(router, manage, writer);
  const read = createReader({ getStore, verifyUser, isMember, buildPreview });
  router.get('/document-shares/:id', writer, read('metadata'));
  router.get('/document-shares/:id/content', writer, read('content'));
  router.get('/document-shares/:id/preview', writer, read('preview'));
  router.use((_req, res) => respondError(res, unavailable()));
  return router;
}

function authorizeRead(req, store, verifyUser, isMember) {
  const secret = req.get('X-Share-Token');
  if (!secret && req.assertCurrentIdentity?.() === false) {
    throw new DocumentShareError('AUTH_REQUIRED', 401);
  }
  const user = secret ? null : (req.user ?? verifyUser(req.get('Authorization')));
  // For member requests authenticate before looking up any identifier.
  if (!secret && !user) throw new DocumentShareError('AUTH_REQUIRED', 401);
  if (!ID.test(req.params.id)) throw unavailable();
  const row = store.get(req.params.id);
  if (!row || row.revoked_at || row.source_missing_at
    || (row.expires_at && (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()))) throw unavailable();
  const project = store.project(row.project_id);
  if (!project) throw unavailable();
  if (row.audience === 'client') {
    if (!secret || !TOKEN.test(secret) || !/^[a-f0-9]{64}$/.test(row.token_hash ?? '')
      || !timingSafeEqual(Buffer.from(digest(secret), 'hex'), Buffer.from(row.token_hash, 'hex'))) throw unavailable();
  } else if (secret) {
    throw unavailable();
  } else if (!user || (!admin(user) && !isMember(project.project_path, user.id))) {
    throw new DocumentShareError('ACCESS_DENIED', 403);
  }
  return row;
}
