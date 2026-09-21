import { getConnection } from '@/modules/database/connection.js';

export type LocalModel = { id: string; name?: string; contextWindow?: number; maxOutput?: number };
export type LocalModelServer = {
  id: string; ownerId: number; providerId: string; name: string; baseUrl: string;
  runtime: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'other';
  models: LocalModel[]; createdAt: string; updatedAt: string;
};
const columns = 'id, owner_id AS ownerId, provider_id AS providerId, name, base_url AS baseUrl, runtime, models_json AS modelsJson, created_at AS createdAt, updated_at AS updatedAt';
const decode = (row: any): LocalModelServer => {
  const { modelsJson, ...server } = row;
  return { ...server, models: JSON.parse(modelsJson) };
};

export const localModelServersDb = {
  /**
   * Reads ONLY the caller's own servers (B-1268). Sharing a granter's server with a
   * grantee is deferred to T-1807: with B-1243 open, a shared block would hand the
   * granter's endpoint (and key) to a grantee's agent shell.
   */
  list(ownerId: number, limit = 100, offset = 0): LocalModelServer[] {
    return getConnection().prepare(`SELECT ${columns} FROM local_model_servers WHERE owner_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?`)
      .all(ownerId, limit, offset).map(decode);
  },
  /** Counts the same owner-only scope as list. */
  count(ownerId: number): number {
    return (getConnection().prepare('SELECT COUNT(*) AS total FROM local_model_servers WHERE owner_id = ?').get(ownerId) as { total: number }).total;
  },
  /** Reads a server only when the caller owns it. */
  get(id: string, ownerId: number): LocalModelServer | null {
    const row = getConnection().prepare(`SELECT ${columns} FROM local_model_servers WHERE id = ? AND owner_id = ?`).get(id, ownerId);
    return row ? decode(row) : null;
  },
  /** Persists an owner-scoped create/update; ownership is never reassigned. */
  save(server: Omit<LocalModelServer, 'createdAt' | 'updatedAt'>): void {
    getConnection().prepare(`INSERT INTO local_model_servers (id,owner_id,provider_id,name,base_url,runtime,models_json) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, runtime=excluded.runtime, models_json=excluded.models_json, updated_at=datetime('now') WHERE owner_id=excluded.owner_id`)
      .run(server.id, server.ownerId, server.providerId, server.name, server.baseUrl, server.runtime, JSON.stringify(server.models));
  },
  /** Compare-and-swap catalogue: an in-flight fetch cannot resurrect or overwrite edits. */
  updateModels(server: LocalModelServer, models: LocalModel[]): boolean {
    return getConnection().prepare(`UPDATE local_model_servers SET models_json = ?, updated_at = datetime('now')
      WHERE id = ? AND owner_id = ? AND base_url = ? AND runtime = ? AND models_json = ? AND updated_at = ?`)
      .run(JSON.stringify(models), server.id, server.ownerId, server.baseUrl, server.runtime, JSON.stringify(server.models), server.updatedAt).changes === 1;
  },
  /** Removes only the caller's row; does not signal any running process. */
  remove(id: string, ownerId: number): void {
    getConnection().prepare('DELETE FROM local_model_servers WHERE id = ? AND owner_id = ?').run(id, ownerId);
  },
};
