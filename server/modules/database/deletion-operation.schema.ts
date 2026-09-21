/** S1b candidate expansion only; never imported into live migrations. Existing unknown records do not authorize replay. */
export const DELETION_OPERATION_EXPANSION_SQL = `
ALTER TABLE project_deletion_records ADD COLUMN actor_id INTEGER REFERENCES users(id);
ALTER TABLE project_deletion_records ADD COLUMN target_kind TEXT CHECK(target_kind IN ('session','project'));
ALTER TABLE project_deletion_records ADD COLUMN target_id TEXT;
`;
