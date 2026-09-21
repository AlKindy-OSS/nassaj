import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {resolveRecoveryLabAsset,verifyRecoveryLabAssetBytes} from './local-source-recovery-assets.mjs';
const bytes=Buffer.from('actual sealed asset'),generationId='a'.repeat(64),buildId='b'.repeat(64);
const manifest={schema:'nassaj-client-assets/v1',generationId,buildId,entries:[{path:'assets/app.js',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]};
const url=`/assets/generations/${generationId}/assets/app.js`;

test('generation URL resolves to manifest relative dist path and verifies both byte sources',()=>{
    const asset=resolveRecoveryLabAsset('/fixture/dist',url,manifest,buildId);
    assert.equal(asset.file,'/fixture/dist/assets/app.js');
    assert.equal(verifyRecoveryLabAssetBytes(asset,bytes,bytes).generationId,generationId);
    assert.throws(()=>verifyRecoveryLabAssetBytes(asset,Buffer.from('changed'),bytes),/content_changed/);
    assert.throws(()=>verifyRecoveryLabAssetBytes(asset,bytes,Buffer.from('changed')),/content_changed/);
});

test('generation resolver rejects foreign generation, manifest build, traversal and absent entries',()=>{
    for(const value of [url.replace(generationId,'c'.repeat(64)),'/assets/app.js'])
        assert.throws(()=>resolveRecoveryLabAsset('/fixture/dist',value,manifest,buildId),/generation_changed/);
    assert.throws(()=>resolveRecoveryLabAsset('/fixture/dist',url,manifest,'c'.repeat(64)),/manifest_invalid/);
    for(const suffix of ['../secret','%2e%2e/secret','assets//app.js','assets/app.js?other'])
        assert.throws(()=>resolveRecoveryLabAsset('/fixture/dist',`/assets/generations/${generationId}/${suffix}`,manifest,buildId),/path_invalid/);
    assert.throws(()=>resolveRecoveryLabAsset('/fixture/dist',url,{...manifest,entries:[]},buildId),/entry_missing/);
});
