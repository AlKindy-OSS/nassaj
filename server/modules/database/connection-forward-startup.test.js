import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import Database from 'better-sqlite3';

import { setupInitialArmFixture } from '../../../scripts/fixtures/initial-arm-fixture.mjs';
import { installFixedStateMutexAuthority } from '../../../scripts/fixtures/fixed-state-mutex-authority.mjs';
import { createBootstrapContextHarness } from '../../../scripts/fixtures/bootstrap-context-harness.mjs';

const project = process.cwd();
const load = file => import(pathToFileURL(file).href);

test('cold compiled connection binds signed target on actual readonly and writable handles', async t => {
  // A clean checkout has no `.artifacts`; never depend on a previous run having created it.
  const artifacts = path.join(project, '.artifacts'); fs.mkdirSync(artifacts, {recursive:true});
  const root = fs.mkdtempSync(path.join(artifacts, 'cold-forward-database-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const compiled = path.join(root, 'dist-server');
  for (const [tool, args] of [
    ['tsc', ['--project', 'server/tsconfig.json', '--outDir', compiled]],
    ['tsc-alias', ['--project', 'server/tsconfig.json', '--outDir', compiled]],
  ]) {
    const result = spawnSync(path.join(project, 'node_modules/.bin', tool), args, {cwd:project,encoding:'utf8'});
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  const server = path.join(compiled, 'server');
  // Prepare fixture security with default v1 modules before sealing the forward profile.
  const {migrateConnectorAuthSchema} = await load(path.join(server, 'modules/database/connector-auth.migration.js'));
  const {migrateConnectorPolicyV2Substrate} = await load(path.join(server, 'modules/database/connector-policy-v2.migration.js'));
  const {openOrCreateConnectorRuntimeAuthorityRoot} = await load(path.join(server, 'modules/connectors/connector-runtime-authority-root.js'));
  const {reinstallConnectorRuntimeFence} = await load(path.join(server, 'modules/connectors/connector-runtime-fence.js'));
  const {observeCompatibleForwardDatabase} = await load(path.join(server, 'modules/database/compatible-forward-observation.js'));
  const directory = path.join(root, 'db-private'); fs.mkdirSync(directory, {mode:0o700});
  const databasePath = path.join(directory, 'fixture.sqlite');
  const db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,status TEXT,is_active INTEGER);
    CREATE TABLE app_config(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE session_workspace_modes(session_id TEXT,project_path TEXT,mode TEXT);
    CREATE TABLE vapid_keys(id INTEGER,public_key TEXT,private_key TEXT);`);
  db.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(7,'owner','active',1);
  db.prepare('INSERT INTO app_config VALUES (?, ?)').run('jwt_secret','fixture-only-'.repeat(5));
  db.prepare('INSERT INTO vapid_keys VALUES (?, ?, ?)').run(1,'fixture-public','fixture-private');
  migrateConnectorAuthSchema(db);
  const installation = migrateConnectorPolicyV2Substrate(db);
  db.prepare('INSERT INTO connector_m5_installation_origin VALUES (?, ?, ?)').run(installation,'https://existing.example',Date.now());
  const authority = openOrCreateConnectorRuntimeAuthorityRoot(databasePath + '.connector-runtime-authority.json').authority;
  reinstallConnectorRuntimeFence(db, authority);
  const target = observeCompatibleForwardDatabase(db);
  db.close(); fs.chmodSync(databasePath,0o600);
  fs.writeFileSync(path.join(server,'bootstrap-release-profile.js'), "export const ROOT_ADMISSION_REQUIRED=true;\nexport const PROFILE_ID='local-forward-349/v2';\n");
  const files = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      const file = path.join(directory,entry.name);
      if (entry.isDirectory()) collect(file);
      else { const metadata=fs.statSync(file); files.push({path:path.relative(root,file),size:metadata.size,mode:metadata.mode&0o777,
        sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}); }
    }
  }
  collect(compiled); files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  const contextUrl=pathToFileURL(path.join(server,'bootstrap-startup-context.js')).href;
  const connectionUrl=pathToFileURL(path.join(server,'modules/database/connection.js')).href;
  for (const key of [null,'schemaDigest','compatibilityShapeDigest','migrationStateDigest','rw-drift']) {
    await t.test(key ? `rejects signed ${key} mismatch` : 'readonly to security-authorized writable reopening', async st => {
      const databaseTarget = key && key !== 'rw-drift' ? {...target,[key]:'0'.repeat(64)} : target;
      const f = createBootstrapContextHarness(st,{releaseRoot:root,files,databasePath,databaseTarget,simulateInitialOperator:true});
      const before=fs.readFileSync(databasePath);
      const go=path.join(f.root,'connection-go');
      const running=f.start(`
        import fs from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
        while(!fs.existsSync(${JSON.stringify(go)}))await delay(5);
        import {establishStartupAdmission,admitSecurityStartup} from ${JSON.stringify(contextUrl)};
        process.env.TMPDIR=${JSON.stringify(root)};
        process.env.DATABASE_PATH=${JSON.stringify(databasePath)};
        delete process.env.JWT_SECRET; delete process.env.NASSAJ_UNIVERSAL_CONVERSATIONS_SHADOW;
        await establishStartupAdmission();
        const {default:Database}=await import('better-sqlite3');
        const statements=[];
        for(const method of ['prepare','exec','pragma']) {
          const original=Database.prototype[method];
          Database.prototype[method]=function(sql,...args){statements.push({method,sql});return original.call(this,sql,...args)};
        }
        const {getConnection}=await import(${JSON.stringify(connectionUrl)});
        const ro=getConnection(); if(!ro.readonly) throw Error('expected_readonly');
        await admitSecurityStartup();
        if(${JSON.stringify(key === 'rw-drift')}) {
          const writer=new Database(process.env.DATABASE_PATH);
          writer.prepare('INSERT INTO app_config VALUES (?, ?)').run('participants_backfill_completed_at','fixture');
          writer.close();
        }
        const rw=getConnection(); if(rw.readonly || ro.open) throw Error('expected_reopen');
        rw.close();
        process.stdout.write(JSON.stringify(statements));
      `);
      st.after(()=>running.child.kill('SIGKILL'));
      const armed=await setupInitialArmFixture(st,{fixture:f,targetChild:running.child});
      installFixedStateMutexAuthority(st,f.root,f.config,{file:path.join(f.root,'config.json')});
      f.write('config.json',f.config);await armed.arm();fs.writeFileSync(go,'go');
      const result=await running.result;
      if(key) { assert.notEqual(result.code,0); assert.match(result.stderr,/existing_startup_database_target_drift/); }
      else {
        assert.equal(result.code,0,result.stderr);
        const statements=JSON.parse(result.stdout);
        assert.ok(statements.length>20);
        assert.equal(statements.some(({sql})=>/^\s*(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE|VACUUM|ATTACH|DETACH)\b/i.test(sql)),false);
      }
      if(key !== 'rw-drift') assert.deepEqual(fs.readFileSync(databasePath),before);
    });
  }
});
