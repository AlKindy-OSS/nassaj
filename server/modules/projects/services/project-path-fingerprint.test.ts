import assert from 'node:assert/strict';
import test from 'node:test';

import { fingerprintCanonicalProjectPath, fingerprintProjectReadSet } from './project-path-fingerprint.js';

test('canonical fingerprint is stable across calls, key-scoped, exact-path and fails closed on missing read keys',()=>{
 const keys=new Map([[1,Buffer.alloc(32,1)],[2,Buffer.alloc(32,2)]]);
 const first=fingerprintCanonicalProjectPath('/project/a',1,keys);
 assert.equal(first,fingerprintCanonicalProjectPath('/project/a',1,keys));
 assert.notEqual(first,fingerprintCanonicalProjectPath('/project/a',2,keys));
 assert.notEqual(first,fingerprintCanonicalProjectPath('/project/A',1,keys));
 assert.equal(fingerprintProjectReadSet('/project/a',[1,2],keys).length,2);
 assert.throws(()=>fingerprintProjectReadSet('/project/a',[1,3],keys));
 for(const invalid of ['relative','/a/../b','/a//b','/a/','/a\0b']) assert.throws(()=>fingerprintCanonicalProjectPath(invalid,1,keys));
 assert.throws(()=>fingerprintProjectReadSet('/a',[],keys));
});
