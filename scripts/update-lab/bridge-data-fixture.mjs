/** Synthetic startup data. This module may open only the isolated laboratory database. */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';

function openFixture(lab) {
    assert.equal(process.pid, 1);
    assert.equal(process.env.DATABASE_PATH, path.join(lab, 'data/auth.db'));
    assert.match(lab, /\/.artifacts\/t1772-bridge-rehearsal\/run-[^/]+$/);
    assert.equal(fs.realpathSync(lab), lab);
    const db = new DatabaseSync(process.env.DATABASE_PATH);
    db.exec('PRAGMA foreign_keys=ON');
    return db;
}

/** Seed representative rows after actual old schema initialization, without copying user data. */
export async function seedBridgeData(lab,{externalUnknown=false}={}) {
    const db = openFixture(lab);
    const {encryptCredentialValue} = await import(pathToFileURL(path.join(lab, 'app/dist-server/server/modules/database/database-credential-crypto.js')));
    try {
        const owner = db.prepare("SELECT id,password_hash FROM users WHERE username=? AND role='owner'").get('bridgeowner');
        assert.ok(owner);
        db.prepare('INSERT INTO users(username,password_hash,role,status,is_active) VALUES(?,?,?,?,?)').run('bridgemember', owner.password_hash, 'user', 'active', 1);
        const member = db.prepare('SELECT id FROM users WHERE username=?').get('bridgemember').id;
        db.prepare('INSERT INTO provider_credential_grants(owner_user_id,grantee_user_id,provider) VALUES(?,?,?)').run(owner.id, member, 'claude');
        const aad = {id: 901, userId: owner.id, credentialType: 'github_token'};
        db.prepare('INSERT INTO user_credentials(id,user_id,credential_name,credential_type,credential_value) VALUES(?,?,?,?,?)')
            .run(aad.id, owner.id, 'bridge-fake', aad.credentialType, encryptCredentialValue('bridge-synthetic-not-a-real-token', aad));
        db.prepare('INSERT INTO app_config(key,value) VALUES(?,?)').run('bridge_rehearsal_sentinel', 'preserve-me');
        db.prepare('INSERT INTO sessions(session_id) VALUES(?)').run('bridge-live');
        for (const session of ['bridge-live', 'bridge-gone']) {
            db.prepare("INSERT INTO message_authors(session_id,user_id,content_hash,created_at) VALUES(?,?,?,datetime('now','-30 days'))").run(session, owner.id, session);
            db.prepare("INSERT INTO starred_sessions(user_id,session_id,created_at) VALUES(?,?,datetime('now','-30 days'))").run(owner.id, session);
        }
        db.prepare("INSERT INTO audit_log(user_id,action,created_at) VALUES(?,?,datetime('now','-100 days'))").run(owner.id, 'bridge-old-audit');
        db.prepare('INSERT INTO audit_log(user_id,action) VALUES(?,?)').run(owner.id, 'bridge-current-audit');
        for (const status of ['pending', 'failed']) db.prepare(`INSERT INTO scheduled_messages
            (id,user_id,session_id,content,scheduled_for,available_at,status) VALUES(?,?,?,?,?,?,?)`)
            .run(`bridge-${status}`, owner.id, 'bridge-live', 'synthetic fixture', '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', status);
    } finally { db.close(); }
    await seedPermissionLease(lab,externalUnknown);
}

async function seedPermissionLease(lab,externalUnknown,suffix='') {
    const require=createRequire(path.join(lab,'app/package.json'));
    const Database=require('better-sqlite3'),db=new Database(process.env.DATABASE_PATH);
    const permission=await import(pathToFileURL(path.join(lab,'app/dist-server/server/modules/database/repositories/permission-execution.js')));
    try {
        const userId=db.prepare("SELECT id FROM users WHERE username=?").get('bridgeowner').id;
        const now=Date.now()-60000;
        permission.createPermissionAdmission(db,{decisionId:'bridge-decision'+suffix,leaseId:'bridge-lease'+suffix,userId,principalId:`user:${userId}`,
            authenticationKind:'session',authorizationGeneration:1,launchId:'bridge-launch',sessionId:'bridge-live',projectId:'bridge-project',
            workspaceDigest:'a'.repeat(64),provider:'codex',body:'codex',engine:'sdk',entrypoint:'ws.chat',purpose:'sdk_turn',
            requestedProfile:'full_delegation',contractVersion:'permission-parity/v1',profileDigest:'bridge-profile',capabilityDigest:'bridge-capability',
            releaseBuild:'development-unsealed',protocolGeneration:1,ownerId:'bridge-dead-owner',ownerPid:99999999,
            ownerBootId:'bridge-previous-boot',ownerStartTicks:'1',effectIdentity:'bridge-effect'+suffix,expiresAtMs:now+1000,nowMs:now});
        if(externalUnknown)permission.claimPermissionLease(db,'bridge-lease'+suffix,1,now+100);
    } finally {db.close();}
}

/** Re-establish startup writer predicates after the successful old baseline, for the bridge itself to consume. */
export async function seedBridgeWriterPredicates(lab) {
    const db=openFixture(lab);
    try {
        const user=db.prepare('SELECT id FROM users WHERE username=?').get('bridgeowner').id;
        db.prepare("INSERT INTO audit_log(user_id,action,created_at) VALUES(?,?,datetime('now','-100 days'))").run(user,'bridge-old-audit');
        db.prepare("INSERT INTO message_authors(session_id,user_id,content_hash,created_at) VALUES(?,?,?,datetime('now','-30 days'))").run('bridge-gone',user,'bridge-gone');
        db.prepare("INSERT INTO starred_sessions(user_id,session_id,created_at) VALUES(?,?,datetime('now','-30 days'))").run(user,'bridge-gone');
    } finally {db.close();}
    await seedPermissionLease(lab,false,'-target');
    return readBridgeWriterPredicates(lab);
}

/** Read logical predicates without triggering cleanup or reconciliation. */
export function readBridgeWriterPredicates(lab) {
    const db=openFixture(lab);
    try {return {
        oldAudit:db.prepare('SELECT count(*) n FROM audit_log WHERE action=?').get('bridge-old-audit').n,
        orphanAuthors:db.prepare('SELECT count(*) n FROM message_authors WHERE session_id=?').get('bridge-gone').n,
        orphanStars:db.prepare('SELECT count(*) n FROM starred_sessions WHERE session_id=?').get('bridge-gone').n,
        targetLease:db.prepare('SELECT status FROM permission_admission_leases WHERE lease_id=?').get('bridge-lease-target')?.status??null,
        targetOutcome:db.prepare('SELECT terminal_outcome FROM permission_launch_decisions WHERE decision_id=?').get('bridge-decision-target')?.terminal_outcome??null,
    };} finally {db.close();}
}

/** Assert logical preservation and the explicitly expected old startup cleanup effects. */
export async function assertBridgeData(lab,{externalUnknown=false}={}) {
    const db = openFixture(lab);
    try {
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        assert.equal(db.prepare('SELECT value FROM app_config WHERE key=?').get('bridge_rehearsal_sentinel').value, 'preserve-me');
        assert.equal(db.prepare('SELECT count(*) n FROM provider_credential_grants WHERE declined_at IS NULL').get().n, 1);
        assertFreshCredentialRoundTrip(lab);
        assert.deepEqual(db.prepare("SELECT status FROM scheduled_messages WHERE id LIKE 'bridge-%' ORDER BY status").all().map(r => r.status), ['failed', 'pending']);
        assert.deepEqual(db.prepare("SELECT session_id FROM message_authors WHERE session_id LIKE 'bridge-%' ORDER BY session_id").all().map(r => r.session_id), ['bridge-live']);
        assert.deepEqual(db.prepare("SELECT session_id FROM starred_sessions WHERE session_id LIKE 'bridge-%' ORDER BY session_id").all().map(r => r.session_id), ['bridge-live']);
        assert.deepEqual(db.prepare("SELECT action FROM audit_log WHERE action LIKE 'bridge-%' ORDER BY action").all().map(r => r.action), ['bridge-current-audit']);
        assert.equal(db.prepare('SELECT terminal_outcome FROM permission_launch_decisions WHERE decision_id=?').get('bridge-decision').terminal_outcome,externalUnknown?'reconciled_unknown':'not_started');
        assert.equal(db.prepare('SELECT status FROM permission_admission_leases WHERE lease_id=?').get('bridge-lease').status,externalUnknown?'terminal':'revoked');
        return {integrity: 'ok', credentialRoundTrip: true, activeGrant: true, jobsPreserved: true, cleanupExpected: true};
    } finally { db.close(); }
}

/** Refuse host or unrelated child execution before any credential database is opened. */
export function assertBridgeCryptoChildNamespace(lab) {
    const parent=process.env.NASSAJ_LAB_PARENT_PID_NS;
    if(!/^pid:\[\d+\]$/.test(parent||'') || fs.readlinkSync('/proc/self/ns/pid')===parent
        || process.pid===1 || process.cwd()!==lab || fs.realpathSync(lab)!==lab
        || !/^\/.*\/\.artifacts\/t1772-bridge-rehearsal\/run-[A-Za-z0-9]+$/.test(lab)
        || process.env.PM2_HOME!==path.join(process.env.HOME,'.pm2'))throw Error('crypto_fixture_not_child');
}

function assertFreshCredentialRoundTrip(lab) {
    const source=`import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {pathToFileURL} from 'node:url';
${assertBridgeCryptoChildNamespace.toString()}
const lab=${JSON.stringify(lab)};assertBridgeCryptoChildNamespace(lab);
const db=new DatabaseSync(process.env.DATABASE_PATH,{readOnly:true});const row=db.prepare('SELECT * FROM user_credentials WHERE id=?').get(901);
const file=path.join(lab,'app/dist-server/server/modules/database/database-credential-crypto.js');
const {decryptCredentialValue}=await import(pathToFileURL(file));
if(decryptCredentialValue(row.credential_value,{id:row.id,userId:row.user_id,credentialType:row.credential_type})!=='bridge-synthetic-not-a-real-token')throw Error('crypto_fixture_mismatch');
const identity=JSON.parse(fs.readFileSync(path.join(lab,'app/dist-server/BUILD_PROVENANCE.json')));db.close();console.log(JSON.stringify({verified:true,buildId:identity.buildId}));`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',source],{cwd:lab,env:process.env,encoding:'utf8',timeout:10000,killSignal:'SIGKILL'});
    assert.equal(child.status,0,'fresh generation credential verification failed');
    const current=JSON.parse(fs.readFileSync(path.join(lab,'app/dist-server/BUILD_PROVENANCE.json')));
    assert.deepEqual(JSON.parse(child.stdout),{verified:true,buildId:current.buildId});
}

/** Exercise real authentication and grant resolution through the running generation's HTTP routes. */
export async function assertBridgeAuthentication(lab,port) {
    const configuration=fs.readFileSync(path.join(lab,'app/.env'),'utf8');
    const password=configuration.split('\n').find(line=>line.startsWith('BOOTSTRAP_OWNER_PASSWORD=')).slice('BOOTSTRAP_OWNER_PASSWORD='.length);
    const identities={};
    for(const username of ['bridgeowner','bridgemember']) {
        const login=await fetch(`http://127.0.0.1:${port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({username,password}),signal:AbortSignal.timeout(10000)});
        assert.equal(login.status,200,`${username} authenticates after startup`);
        const body=await login.json();
        assert.equal(body.user.username,username);
        const overview=await fetch(`http://127.0.0.1:${port}/api/credential-grants`,{headers:{Authorization:`Bearer ${body.token}`},signal:AbortSignal.timeout(5000)});
        assert.equal(overview.status,200);
        identities[username]={id:body.user.id,role:body.user.role,overview:(await overview.json()).data};
    }
    const owner=identities.bridgeowner,member=identities.bridgemember;
    assert.equal(owner.role,'owner');assert.equal(member.role,'user');
    assert.ok(owner.overview.given.some(row=>row.userId===member.id && row.provider==='claude' && !row.declined));
    assert.ok(member.overview.received.some(row=>row.ownerUserId===owner.id && row.provider==='claude' && !row.declined && row.inUse));
    return {ownerAuthenticated:true,memberAuthenticated:true,grantResolvedByRunningApplication:true};
}
