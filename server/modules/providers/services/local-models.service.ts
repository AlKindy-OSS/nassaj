import crypto from 'node:crypto';

import { appConfigDb, auditLogDb, getConnection, localModelServersDb, type LocalModel, type LocalModelServer } from '@/modules/database/index.js';
import {
  deleteLocalModelSecret,
  getLocalModelSecret,
  hasLocalModelSecret,
  setLocalModelSecret,
} from '@/services/isolation/provider-secrets-store.js';
import { AppError } from '@/shared/utils.js';
import { safeFetchLocalModelJson, safeProbeLocalModelAuth, validateLocalModelUrl } from '@/modules/connectors/index.js';

export const LOCAL_MODELS_CONSENT_VERSION = '1';
export const LOCAL_PROVIDER_PREFIX = 'nassaj_local_';
/**
 * A rejected LOCAL-MODEL key must never be reported as 401.
 *
 * The global error middleware emits `{success:false,error:{code}}` with no root-level
 * `code`, and the client's `isSessionRejection` reads `body.code` only — so ANY 401
 * from this API reads as a Nassaj session rejection and triggers silent token refresh,
 * a replayed request and finally `auth:unauthorized` (logout/redirect loop, the Helium
 * incident pattern). 422 keeps the failure machine-readable through `code` while
 * staying outside the client's session-rejection path, and is unused elsewhere in this
 * service (400 invalid input, 403 disabled, 404 missing, 409 conflict, 429 throttle,
 * 502 unreachable), so it stays unambiguous.
 */
export const LOCAL_MODELS_AUTH_FAILED_STATUS = 422;
/** Joins a saved base URL with an API path, tolerating a stored trailing slash. */
const endpoint = (baseUrl: string, path: string): string => `${baseUrl.replace(/\/+$/u, '')}${path}`;
const failureMessage = (code: string): string => {
  if (code === 'LOCAL_MODELS_CONNECTION_FAILED') return 'تعذّر الاتصال بخادم النماذج. تحقق من العنوان والإعدادات ثم أعد المحاولة.';
  if (code === 'LOCAL_MODELS_AUTH_FAILED') return 'رفض خادم النماذج مفتاح الـ API. تحقق من المفتاح ثم أعد المحاولة.';
  return 'تعذّر تنفيذ طلب النماذج المحلية. تحقق من الإعدادات والصلاحيات.';
};
const failure = (code = 'LOCAL_MODELS_INVALID_INPUT', statusCode = 400) => new AppError(
  failureMessage(code), { code, statusCode });
const object = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure();
  return input as Record<string, unknown>;
};
const text = (value: unknown, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\x00-\x1f{}$]/u.test(value)) throw failure();
  return value.trim();
};
/** Strict manual/catalog model shape; unknown context remains absent. */
export function validateLocalModels(input: unknown): LocalModel[] {
  if (!Array.isArray(input) || input.length > 200) throw failure();
  const seen = new Set<string>();
  return input.map(value => {
    const row = object(value);
    if (Object.keys(row).some(key => !['id', 'name', 'contextWindow', 'maxOutput'].includes(key))) throw failure();
    const id = text(row.id, 200);
    if (seen.has(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw failure();
    seen.add(id);
    const model: LocalModel = { id, ...(row.name === undefined ? {} : { name: text(row.name, 160) }) };
    for (const field of ['contextWindow', 'maxOutput'] as const) {
      const size = row[field];
      if (size === undefined) continue;
      if (!Number.isSafeInteger(size) || Number(size) < 1 || Number(size) > 2097152) throw failure();
      model[field] = Number(size);
    }
    if (model.contextWindow && model.maxOutput && model.maxOutput > model.contextWindow) throw failure();
    return model;
  });
}
/** Canonical server-generated provider namespace, never supplied by clients. */
export const localProviderId = (id: string): string => `${LOCAL_PROVIDER_PREFIX}${id.replaceAll('-', '')}`;

const defaultDependencies = {
  repository: localModelServersDb, config: appConfigDb, audit: auditLogDb,
  fetchJson: safeFetchLocalModelJson,
  probeAuth: safeProbeLocalModelAuth,
  transaction: <T>(work: () => T): T => getConnection().transaction(work)(),
  secrets: {
    get: getLocalModelSecret,
    set: setLocalModelSecret,
    remove: deleteLocalModelSecret,
    has: hasLocalModelSecret,
  },
};

class LocalModelsService {
  constructor(private readonly deps: typeof defaultDependencies) {}

  /** Reads the persisted manager consent gate without side effects. */
  enabled = (): boolean => this.deps.config.get('local_models.enabled') === 'true'
    && this.deps.config.get('local_models.consent_version') === LOCAL_MODELS_CONSENT_VERSION;
  /** Returns only activation state and current caller management capability. */
  feature = (role: string) => ({ enabled: this.enabled(), consentVersion: this.deps.config.get('local_models.consent_version'), requiredConsentVersion: LOCAL_MODELS_CONSENT_VERSION, canManage: role === 'owner' || role === 'admin' });
  private requireEnabled = () => { if (!this.enabled()) throw failure('LOCAL_MODELS_DISABLED', 403); };
  private own = (callerId: number, id: string) => {
    const server = this.deps.repository.get(text(id, 64), callerId);
    if (!server) throw failure('LOCAL_MODEL_SERVER_NOT_FOUND', 404);
    return server;
  };
  private dto = (server: LocalModelServer, callerId: number) => ({ ...server, owned: server.ownerId === callerId, hasApiKey: this.deps.secrets.has(server.ownerId, server.id) });
  private audit = (callerId: number, id: string, operation: string) => this.deps.audit.recordStrict('local_model_server_changed', { userId: callerId, metadata: { serverId: id, operation } });
  private rate = new Map<number, { until: number; count: number }>();
  private throttle = (callerId: number) => {
    const now = Date.now();
    for (const [id, row] of this.rate) if (row.until <= now) this.rate.delete(id);
    const row = this.rate.get(callerId) ?? { until: now + 60000, count: 0 };
    if (++row.count > 10) throw failure('LOCAL_MODELS_RATE_LIMITED', 429);
    this.rate.set(callerId, row);
  };
  private validateServer = (input: unknown, existing?: LocalModelServer) => {
    const body = object(input);
    if (Object.keys(body).some(key => !['name', 'baseUrl', 'runtime', 'models', 'apiKey', 'removeApiKey'].includes(key))) throw failure();
    if (body.removeApiKey !== undefined && typeof body.removeApiKey !== 'boolean') throw failure();
    if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw failure();
    if (body.apiKey && body.removeApiKey) throw failure();
    const name = text(body.name ?? existing?.name, 100);
    let baseUrl: string;
    try {
      const url = validateLocalModelUrl(text(body.baseUrl ?? existing?.baseUrl, 2048));
      if (url.pathname === '/') url.pathname = '/v1';
      baseUrl = url.href.replace(/\/+$/u, '');
    } catch { throw failure(); }
    const runtime = body.runtime ?? existing?.runtime ?? 'other';
    if (!['ollama', 'lmstudio', 'llamacpp', 'vllm', 'other'].includes(String(runtime))) throw failure();
    const models = body.models === undefined ? existing?.models ?? [] : validateLocalModels(body.models);
    const apiKey = body.apiKey ? text(body.apiKey, 4096) : undefined;
    return { name, baseUrl, runtime: runtime as LocalModelServer['runtime'], models, apiKey, removeApiKey: body.removeApiKey === true };
  };
  /**
   * B-1298(a): a wrong API key must not pass. `/models` is served unauthenticated by
   * llama.cpp, so a bad key would go unnoticed there; probe an authenticated endpoint
   * that gates before loading a model and refuse a 401 with a distinct auth code.
   * Only runs when a key is configured — a keyless server has nothing to authenticate.
   *
   * Only 401 counts as an authentication failure. A 403 is NOT treated as one: a
   * reverse proxy, WAF or IP allowlist in front of the endpoint answers 403 for
   * reasons unrelated to the key, and blocking a user who holds a VALID key is the
   * worse failure. A 403 therefore falls through to the ordinary catalogue request,
   * which reports a connection failure if the endpoint really is unreachable.
   */
  private probeAuth = async (server: LocalModelServer, apiKey: string | null) => {
    if (!apiKey) return;
    let status: number;
    try {
      ({ status } = await this.deps.probeAuth(endpoint(server.baseUrl, '/chat/completions'), apiKey));
    } catch {
      throw failure('LOCAL_MODELS_CONNECTION_FAILED', 502);
    }
    if (status === 401) throw failure('LOCAL_MODELS_AUTH_FAILED', LOCAL_MODELS_AUTH_FAILED_STATUS);
  };
  /** Probes the saved endpoint explicitly; only catalogue refresh persists models. */
  catalog = async (callerId: number, id: string, persist: boolean) => {
    this.requireEnabled(); this.throttle(callerId);
    const server = this.own(callerId, id);
    const apiKey = this.deps.secrets.get(server.ownerId, server.id);
    await this.probeAuth(server, apiKey);
    let models: LocalModel[];
    try {
      const raw = await this.deps.fetchJson(endpoint(server.baseUrl, '/models'), apiKey);
      if (!Array.isArray(raw.data) || raw.data.length > 200) throw failure();
      models = validateLocalModels(raw.data.map(item => {
        const row = object(item);
        const id = text(row.id, 200);
        return server.models.find(model => model.id === id) ?? { id };
      }));
    } catch { throw failure('LOCAL_MODELS_CONNECTION_FAILED', 502); }
    if (persist) {
      this.requireEnabled();
      this.deps.transaction(() => {
        if (!this.deps.repository.updateModels(server, models)) throw failure('LOCAL_MODEL_SERVER_CHANGED', 409);
        this.audit(callerId, id, 'catalog');
      });
    }
    return { connected: true, models };
  };
  /** Disabled feature remains readable so settings can render its activation card. */
  list(callerId: number, role: string, limit = 50, offset = 0) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw failure();
    return { servers: this.deps.repository.list(callerId, limit, offset).map(row => this.dto(row, callerId)), total: this.deps.repository.count(callerId), limit, offset, feature: this.feature(role) };
  }
  /** Atomic configuration/consent/audit change; default remains disabled. */
  settings(callerId: number, role: string, input: unknown) {
    if (role !== 'owner' && role !== 'admin') throw failure('FORBIDDEN', 403);
    this.throttle(callerId);
    const body = object(input);
    if (Object.keys(body).some(key => !['enabled', 'consentVersion'].includes(key)) || typeof body.enabled !== 'boolean'
      || (body.enabled && body.consentVersion !== LOCAL_MODELS_CONSENT_VERSION)) throw failure();
    this.deps.transaction(() => {
      this.deps.audit.recordStrict('local_models_settings_updated', { userId: callerId, metadata: { enabled: body.enabled, consentVersion: LOCAL_MODELS_CONSENT_VERSION } });
      this.deps.config.set('local_models.enabled', String(body.enabled));
      if (body.enabled) this.deps.config.set('local_models.consent_version', LOCAL_MODELS_CONSENT_VERSION);
    });
    return this.feature(role);
  }
  /** Saves offline configuration without probing or claiming connectivity. */
  save(callerId: number, input: unknown, id?: string) {
    this.requireEnabled(); this.throttle(callerId);
    const existing = id ? this.own(callerId, id) : undefined;
    if (!existing && this.deps.repository.count(callerId) >= 20) throw failure('LOCAL_MODELS_SERVER_LIMIT', 409);
    const { apiKey, removeApiKey, ...fields } = this.validateServer(input, existing);
    const serverId = existing?.id ?? crypto.randomUUID();
    const previousKey = this.deps.secrets.get(callerId, serverId);
    try {
      if (apiKey) this.deps.secrets.set(callerId, serverId, apiKey);
      else if (removeApiKey) this.deps.secrets.remove(callerId, serverId);
      this.deps.transaction(() => {
        this.audit(callerId, serverId, existing ? 'update' : 'create');
        this.deps.repository.save({ ...fields, id: serverId, ownerId: callerId, providerId: localProviderId(serverId) });
      });
    } catch (error) {
      if (apiKey || removeApiKey) {
        if (previousKey) this.deps.secrets.set(callerId, serverId, previousKey);
        else this.deps.secrets.remove(callerId, serverId);
      }
      throw error;
    }
    return this.dto(this.own(callerId, serverId), callerId);
  }
  /** Revokes future runs, leaving already-running sessions alone. */
  remove(callerId: number, id: string) {
    this.own(callerId, id); this.throttle(callerId);
    const previousKey = this.deps.secrets.get(callerId, id);
    this.deps.secrets.remove(callerId, id);
    try {
      this.deps.transaction(() => {
        this.audit(callerId, id, 'delete');
        this.deps.repository.remove(id, callerId);
      });
    } catch (error) {
      if (previousKey) this.deps.secrets.set(callerId, id, previousKey);
      throw error;
    }
    return { removed: true };
  }
}
/** Composes repository, transport and secret-store dependencies without I/O. */
export function createLocalModelsService(deps = defaultDependencies) {
  return new LocalModelsService(deps);
}
export const localModelsService = createLocalModelsService();
