/**
 * N9 step 2 (copied into the N-1 build and run there): boots N-1 on the N
 * database and drives its S1 repository over the rows N wrote. Any throw fails.
 */
import { closeConnection, getConnection, initializeDatabase, peerMessagesDb } from './server/modules/database/index.ts';

await initializeDatabase();
const now = Date.now();
const deliverable = peerMessagesDb.listDeliverable(now, 10).map((r) => r.id).sort();
const promoted = peerMessagesDb.get('pm_from_hold');
const claimed = peerMessagesDb.claim('pm_from_hold', now, 0);
const settled = peerMessagesDb.transition('pm_from_hold', 'delivering', 'queued', { cause: 'n9', nowMs: now });
const listed = peerMessagesDb.listForSession('a1', 10).map((r) => r.id).sort();
const holdsTable = Boolean(getConnection().prepare("SELECT 1 FROM sqlite_master WHERE name = 'peer_holds'").get());
const heldRows = (getConnection().prepare("SELECT COUNT(*) AS n FROM peer_holds WHERE state = 'held'").get() as { n: number }).n;
closeConnection();
console.log(JSON.stringify({ booted: true, deliverable, promotedState: promoted?.state, claimed, settled, listed, holdsTable, heldRows }));
