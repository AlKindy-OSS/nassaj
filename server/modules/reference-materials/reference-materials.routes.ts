import { randomUUID } from 'node:crypto';

import express, { type Request, type Response } from 'express';

import { auditLogDb } from '@/modules/database/index.js';
import {
  referenceMaterialsService,
  type ReferenceMaterialKind,
} from '@/modules/reference-materials/reference-materials.service.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const isPlatformMode = (): boolean => process.env.VITE_IS_PLATFORM === 'true';

const readUser = (req: Request): { id: string | number | null; role: string | null } => {
  const user = (req as Request & { user?: { id?: string | number; role?: string } }).user;
  return {
    id: user?.id ?? null,
    role: user?.role ?? null,
  };
};

const canManage = (req: Request): boolean => {
  if (isPlatformMode()) return false;
  const role = readUser(req).role;
  return role === 'owner' || role === 'admin';
};

const assertCanManage = (req: Request): void => {
  if (isPlatformMode()) {
    throw new AppError('Reference materials cannot be written in platform mode.', {
      code: 'REFERENCE_MATERIAL_PLATFORM_WRITE_FORBIDDEN',
      statusCode: 403,
    });
  }
  if (!canManage(req)) {
    throw new AppError('Editing reference materials requires an admin or owner.', {
      code: 'REFERENCE_MATERIAL_WRITE_FORBIDDEN',
      statusCode: 403,
    });
  }
};

const parseMaterial = (value: unknown): ReferenceMaterialKind => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (
    normalized === 'instructions'
    || normalized === 'memory'
    || normalized === 'agents'
    || normalized === 'skills'
  ) {
    return normalized;
  }
  throw new AppError('Unknown reference material.', {
    code: 'REFERENCE_MATERIAL_UNKNOWN',
    statusCode: 400,
  });
};

const parseProvider = (value: unknown): LLMProvider | undefined => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized) return undefined;
  if (
    normalized === 'claude'
    || normalized === 'codex'
    || normalized === 'cursor'
    || normalized === 'gemini'
    || normalized === 'antigravity'
    || normalized === 'opencode'
    || normalized === 'hermes'
    || normalized === 'kimi'
    || normalized === 'deepseek'
    || normalized === 'glm'
    || normalized === 'sakana'
  ) {
    return normalized;
  }
  throw new AppError('Unsupported provider.', {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};

const readStringBody = (body: unknown, field: string): string => {
  if (!body || typeof body !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 1_000_000) {
    throw new AppError(`${field} is required.`, {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return value;
};

const assertBodyFields = (body: unknown, allowed: readonly string[]): void => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return;
  if (Object.keys(body).some((field) => !allowed.includes(field))) {
    throw new AppError('Request body contains an unsupported field.', {
      code: 'REFERENCE_MATERIAL_UNKNOWN_FIELD',
      statusCode: 400,
    });
  }
};

const readPagination = (req: Request): { page: number; pageSize: number } => {
  const parse = (value: unknown, fallback: number, maximum: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^\d+$/.test(value)) {
      throw new AppError('Invalid pagination.', { code: 'INVALID_PAGINATION', statusCode: 400 });
    }
    const parsed = Number(value);
    if (parsed < 1 || parsed > maximum) {
      throw new AppError('Invalid pagination.', { code: 'INVALID_PAGINATION', statusCode: 400 });
    }
    return parsed;
  };
  return { page: parse(req.query.page, 1, 1_000_000), pageSize: parse(req.query.pageSize, 25, 100) };
};

const optionsFor = (req: Request) => {
  const user = readUser(req);
  return {
    userId: user.id,
    canManage: canManage(req),
  };
};

const CREATABLE_SKILL_PROVIDERS = new Set<LLMProvider>(['claude', 'codex', 'cursor', 'gemini']);

const assertCreateSupported = (material: ReferenceMaterialKind, provider?: LLMProvider): void => {
  if (material === 'instructions' || material === 'agents') {
    throw new AppError(`Creating ${material} is not supported.`, {
      code: 'REFERENCE_MATERIAL_CREATE_UNSUPPORTED',
      statusCode: 400,
    });
  }
  if (material === 'skills' && (!provider || !CREATABLE_SKILL_PROVIDERS.has(provider))) {
    throw new AppError('This provider does not support skill creation.', {
      code: 'REFERENCE_MATERIAL_PROVIDER_UNSUPPORTED',
      statusCode: 400,
    });
  }
};

router.get(
  '/:material',
  asyncHandler(async (req: Request, res: Response) => {
    const material = parseMaterial(req.params.material);
    const options = optionsFor(req);
    const entries = await referenceMaterialsService.list({ ...options, material });
    const { page, pageSize } = readPagination(req);
    const offset = (page - 1) * pageSize;
    res.json(createApiSuccessResponse({
      material,
      canManage: options.canManage,
      affectedScopeNote: 'operator-home materials affect every member when affectedScope is all_members',
      entries: entries.slice(offset, offset + pageSize),
      total: entries.length,
      page,
      pageSize,
    }));
  }),
);

router.get(
  '/:material/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const material = parseMaterial(req.params.material);
    const item = await referenceMaterialsService.read(material, String(req.params.id), optionsFor(req));
    res.json(createApiSuccessResponse({
      material,
      canManage: canManage(req),
      item,
    }));
  }),
);

router.post(
  '/:material',
  asyncHandler(async (req: Request, res: Response) => {
    assertCanManage(req);
    assertBodyFields(req.body, ['name', 'provider', 'content']);
    const material = parseMaterial(req.params.material);
    const content = readStringBody(req.body, 'content');
    const name = typeof (req.body as Record<string, unknown>).name === 'string'
      ? (req.body as Record<string, unknown>).name as string
      : undefined;
    const provider = parseProvider((req.body as Record<string, unknown>).provider);
    assertCreateSupported(material, provider);
    const user = readUser(req);
    const operationId = randomUUID();
    const auditContext = {
      userId: typeof user.id === 'number' ? user.id : null,
      metadata: {
        operationId,
        material,
        requestedName: name ?? null,
        provider: provider ?? null,
        affectedScope: material === 'memory' || material === 'skills' ? 'all_members' : 'unknown',
        role: user.role,
      },
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    };
    auditLogDb.recordStrict('reference_material_create_intent', {
      ...auditContext,
      metadata: { ...auditContext.metadata, phase: 'intent' },
    });
    const item = await referenceMaterialsService.create(material, { name, provider, content }, optionsFor(req));
    auditLogDb.recordStrict('reference_material_created', {
      ...auditContext,
      metadata: {
        ...auditContext.metadata,
        id: item.id,
        affectedScope: item.affectedScope,
        phase: 'committed',
      },
    });
    res.status(201).json(createApiSuccessResponse({ material, item }));
  }),
);

router.put(
  '/:material/:id',
  asyncHandler(async (req: Request, res: Response) => {
    assertCanManage(req);
    assertBodyFields(req.body, ['content']);
    const material = parseMaterial(req.params.material);
    const id = String(req.params.id);
    const content = readStringBody(req.body, 'content');
    const user = readUser(req);
    const current = await referenceMaterialsService.read(material, id, optionsFor(req));
    if (!current.canEdit) {
      throw new AppError('This reference material is read-only.', {
        code: 'REFERENCE_MATERIAL_READ_ONLY',
        statusCode: 400,
      });
    }
    const operationId = randomUUID();
    const auditContext = {
      userId: typeof user.id === 'number' ? user.id : null,
      metadata: {
        operationId,
        material,
        id: current.id,
        provider: current.provider,
        affectedScope: current.affectedScope,
        role: user.role,
      },
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    };
    auditLogDb.recordStrict('reference_material_update_intent', {
      ...auditContext,
      metadata: { ...auditContext.metadata, phase: 'intent' },
    });
    const item = await referenceMaterialsService.update(material, id, content, optionsFor(req));
    auditLogDb.recordStrict('reference_material_updated', {
      ...auditContext,
      metadata: { ...auditContext.metadata, phase: 'committed' },
    });
    res.json(createApiSuccessResponse({ material, item }));
  }),
);

export default router;
