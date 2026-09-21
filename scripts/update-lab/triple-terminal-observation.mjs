/** Read-only failed-terminal observation for an exact prepared target; never repairs product state. */
import fs from 'node:fs';
import path from 'node:path';

/** Return exact failed transaction evidence, or null while the transaction remains nonterminal. */
export function readTripleFailedTerminal(gitRoot, expected) {
    if (!Number.isSafeInteger(expected.sequence) || expected.sequence < 1 || !/^[a-f0-9]{64}$/.test(expected.targetDigest)) throw Error('triple_terminal_observation_invalid');
    const names=fs.readdirSync(gitRoot).filter(name=>new RegExp(`^nassaj-oid-control-transaction-${expected.sequence}-[a-f0-9]{64}\\.json$`).test(name));
    if(names.length>1)throw Error('triple_terminal_observation_ambiguous');
    if(!names.length)return null;
    const journal=JSON.parse(fs.readFileSync(path.join(gitRoot,names[0])));
    if(journal.schema!=='nassaj-oid-control-transaction/v2'||journal.sequence!==expected.sequence||journal.pair?.targetDigest!==expected.targetDigest)throw Error('triple_terminal_observation_mismatch');
    if(!['restart_deferred_restored','pair_rolled_back','manual_recovery_required'].includes(journal.state))return null;
    const maintenance=JSON.parse(fs.readFileSync(path.join(gitRoot,'nassaj-source-update/journal.json')));
    const settled=journal.state==='manual_recovery_required'
        ? maintenance.state==='MANUAL'&&maintenance.gateClosed===true
        : maintenance.state==='OPEN'&&maintenance.gateClosed===false&&!maintenance.oidAdmissionIntent;
    if(!settled)return null; // The journal precedes the admission transition; never kill that recovery window.
    return {maintenance:{state:maintenance.state,gateClosed:maintenance.gateClosed},state:journal.state,transactionNonce:journal.transactionNonce,databaseState:journal.pair.databaseState,
        safeStopFailure:journal.safeStopFailure??null,safeStartFailure:journal.safeStartFailure??null,
        originFailureCode:journal.originFailureCode??null,oldStopIntentAt:journal.oldStopIntentAt??null,
        oldStoppedAt:journal.oldStoppedAt??null,persistence:journal.persistence??null};
}
