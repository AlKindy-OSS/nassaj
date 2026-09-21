/** Additive schema, run only by the admitted/ordinary startup migration paths. */
export function migrateDocumentShares(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS document_shares (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, relative_path TEXT NOT NULL,
    audience TEXT NOT NULL CHECK(audience IN ('members','client')), token_hash TEXT,
    root_dev TEXT NOT NULL, root_ino TEXT NOT NULL, created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, source_missing_at TEXT,
    FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS document_shares_project ON document_shares(project_id)');
}

/** Dependency-injected persistence; never creates a schema on an HTTP request. */
export function createDocumentSharesStore(db) {
  return {
    get: (id) => db.prepare('SELECT * FROM document_shares WHERE id = ?').get(id),
    list: (projectId) => db.prepare(`SELECT * FROM document_shares WHERE project_id = ?
      ORDER BY (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)) DESC, created_at DESC LIMIT 200`)
      .all(projectId, new Date().toISOString()),
    activeCount: (projectId) => db.prepare(`SELECT COUNT(*) AS count FROM document_shares WHERE project_id = ?
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
      .get(projectId, new Date().toISOString()).count,
    insert: (row) => db.prepare(`INSERT INTO document_shares
      (id,project_id,relative_path,audience,token_hash,root_dev,root_ino,created_by,created_at,expires_at)
      SELECT @id,@project_id,@relative_path,@audience,@token_hash,@root_dev,@root_ino,@created_by,@created_at,@expires_at
      WHERE (SELECT COUNT(*) FROM document_shares WHERE project_id=@project_id
        AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>@now)) < 100`)
      .run({ ...row, now: new Date().toISOString() }),
    update: (id, relativePath, expiresAt, identity) => db.prepare(`UPDATE document_shares
      SET relative_path=@relativePath,expires_at=@expiresAt,root_dev=@rootDev,root_ino=@rootIno,source_missing_at=NULL
      WHERE id=@id AND revoked_at IS NULL AND (
        (@expiresAt IS NOT NULL AND @expiresAt<=@now) OR
        (SELECT COUNT(*) FROM document_shares AS other WHERE other.project_id=document_shares.project_id
          AND other.id<>@id AND other.revoked_at IS NULL
          AND (other.expires_at IS NULL OR other.expires_at>@now)) < 100)`)
      .run({ id, relativePath, expiresAt, rootDev: identity.root_dev, rootIno: identity.root_ino,
        now: new Date().toISOString() }),
    revoke: (id, at) => db.prepare('UPDATE document_shares SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(at, id),
    markMissing: (id, relativePath) => db.prepare(`UPDATE document_shares SET source_missing_at=COALESCE(source_missing_at,?)
      WHERE id=? AND relative_path=?`).run(new Date().toISOString(), id, relativePath),
    project: (id) => db.prepare('SELECT * FROM projects WHERE project_id=? AND isArchived=0').get(id),
    // Explicit offline restore step: never run against a running installation.
    disableRestored: (at) => db.prepare('UPDATE document_shares SET revoked_at=COALESCE(revoked_at,?)').run(at),
  };
}
