/** Bind served generation URLs to the current sealed manifest, never to invented dist paths. */
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Resolve only an exact current-generation URL with one sealed manifest entry. */
export function resolveRecoveryLabAsset(dist,url,manifest,expectedBuildId) {
    if(manifest?.schema!=='nassaj-client-assets/v1'||!/^[a-f0-9]{64}$/.test(manifest.generationId||'')
        ||manifest.buildId!==expectedBuildId||!Array.isArray(manifest.entries))throw Error('lab_asset_manifest_invalid');
    const prefix=`/assets/generations/${manifest.generationId}/`;
    if(typeof url!=='string'||!url.startsWith(prefix))throw Error('lab_asset_generation_changed');
    const relative=url.slice(prefix.length);
    if(!relative||relative.split('/').some(part=>!part||part==='.'||part==='..')||/[\\%?#\0]/.test(relative))throw Error('lab_asset_path_invalid');
    const matches=manifest.entries.filter(entry=>entry.path===relative);
    if(matches.length!==1||!/^[a-f0-9]{64}$/.test(matches[0].sha256||'')||!Number.isSafeInteger(matches[0].size)||matches[0].size<0)throw Error('lab_asset_entry_missing');
    const file=path.resolve(dist,relative);if(!file.startsWith(path.resolve(dist)+'/'))throw Error('lab_asset_path_invalid');
    return {file,entry:matches[0],generationId:manifest.generationId};
}

/** Compare real HTTP and local artifact bytes with the sealed size and digest independently. */
export function verifyRecoveryLabAssetBytes(asset,localBytes,httpBytes) {
    for(const bytes of [localBytes,httpBytes])if(bytes.length!==asset.entry.size||createHash('sha256').update(bytes).digest('hex')!==asset.entry.sha256)
        throw Error('lab_asset_content_changed');
    return {path:asset.entry.path,sha256:asset.entry.sha256,generationId:asset.generationId};
}
