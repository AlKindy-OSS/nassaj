import express, { type Request } from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import { localModelsService } from './services/local-models.service.js';

const router = express.Router();
const identity = (req: Request) => {
  const user = (req as Request & { user?: { id?: unknown; role?: string } }).user;
  const id = Number(user?.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('يلزم تسجيل الدخول.', { code: 'UNAUTHORIZED', statusCode: 401 });
  return { id, role: user?.role ?? 'member' };
};
const serverId = (req: Request) => {
  if (typeof req.params.id !== 'string' || !/^[a-f0-9-]{36}$/u.test(req.params.id)) throw new AppError('معرّف خادم غير صالح.', { code: 'INVALID_INPUT', statusCode: 400 });
  return req.params.id;
};
router.get('/servers', asyncHandler(async (req, res) => {
  const user = identity(req);
  res.json(createApiSuccessResponse(localModelsService.list(user.id, user.role, Number(req.query.limit ?? 50), Number(req.query.offset ?? 0))));
}));
router.get('/settings', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(localModelsService.feature(identity(req).role)));
}));
router.put('/settings', asyncHandler(async (req, res) => {
  const user = identity(req);
  res.json(createApiSuccessResponse(localModelsService.settings(user.id, user.role, req.body)));
}));
router.post('/servers', asyncHandler(async (req, res) => {
  res.status(201).json(createApiSuccessResponse(localModelsService.save(identity(req).id, req.body)));
}));
router.patch('/servers/:id', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(localModelsService.save(identity(req).id, req.body, serverId(req))));
}));
router.delete('/servers/:id', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(localModelsService.remove(identity(req).id, serverId(req))));
}));
router.post('/servers/:id/catalog', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(await localModelsService.catalog(identity(req).id, serverId(req), true)));
}));
router.post('/servers/:id/test', asyncHandler(async (req, res) => {
  res.json(createApiSuccessResponse(await localModelsService.catalog(identity(req).id, serverId(req), false)));
}));
export default router;
