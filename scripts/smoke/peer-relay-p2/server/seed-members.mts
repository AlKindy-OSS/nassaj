/**
 * Live suite seed (runs against the run's DB while the test server is up):
 * members A (owner), B, C (members), D (admin, owns no target session), one
 * project per session dir, and project membership so B can write a1's project
 * and A can write b1's. Passwords use the server's own hasher (a foreign cost would
 * be re-hashed at login and invalidate the token just minted). Prints {members:{name:{id,password}}, projects}. Never logs secrets elsewhere.
 */
import { randomBytes } from 'node:crypto';

import { getConnection, projectsDb, userDb } from '../../../../server/modules/database/index.ts';
import { hashPassword } from '../../../../server/services/password.service.js';

const dirs = JSON.parse(process.env.P2_DIRS!) as Record<string, string>;
const members: Record<string, { id: number; password: string }> = {};
for (const [name, role] of [['a', 'owner'], ['b', 'user'], ['c', 'user'], ['d', 'admin']] as const) {
  const password = randomBytes(18).toString('base64url');
  const user = userDb.createUser(`p2_${name}`, await hashPassword(password), role) as { id: number };
  members[name] = { id: user.id, password };
}
const projects: Record<string, string> = {};
const member = getConnection().prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, role, added_by) VALUES (?, ?, ?, ?)');
for (const [key, dir] of Object.entries(dirs)) {
  const owner = key.startsWith('a') ? members.a.id : members.b.id;
  const created = projectsDb.createProjectPath(dir, key, owner);
  const id = created.project!.project_id;
  projects[key] = id;
  for (const m of ['a', 'b', 'c', 'd']) member.run(id, members[m].id, 'member', owner);
}
console.log(JSON.stringify({ members, projects }));
